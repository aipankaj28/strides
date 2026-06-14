require('dotenv').config();
// Set mock dev mode flag
process.env.DEV_MODE = 'true';

const db = require('../db');
const stravaSync = require('../strava-sync');

async function runTests() {
  console.log('--- Starting Strides Verification Test ---');

  // Initialize db tables
  await db.initDb();

  // Clear previous test users if any
  await db.query("DELETE FROM activities WHERE user_id LIKE 'test_usr_%'");
  await db.query("DELETE FROM users WHERE id LIKE 'test_usr_%'");

  const userId = 'test_usr_alice';
  const email = 'alice.test@strides.com';

  console.log('1. Testing User Registration...');
  const insertUserSql = `
    INSERT INTO users (id, name, surname, dob, gender, email, mobile, activity_type, activity_distance, is_paid, total_paid)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `;
  await db.query(insertUserSql, [
    userId, 'Alice', 'Runner', '1995-04-12', 'female', email, '+919876543210', 'run', '5k', true, 234.82
  ]);

  const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 1) {
    console.log('   ✅ User successfully registered.');
  } else {
    throw new Error('   ❌ User registration failed.');
  }

  const targetDist = stravaSync.getTargetDistance('5k');
  console.log(`2. Verify distance target parsing: '5k' mapped to ${targetDist} km.`);
  if (targetDist === 5.0) {
    console.log('   ✅ Distance mapping matches.');
  } else {
    throw new Error(`   ❌ Expected 5.0, got ${targetDist}`);
  }

  const customDistRun = stravaSync.getTargetDistance('2.5k');
  console.log(`   Verify custom run target parsing: '2.5k' mapped to ${customDistRun} km.`);
  if (customDistRun === 2.5) {
    console.log('   ✅ Custom run distance parsing matches.');
  } else {
    throw new Error(`   ❌ Expected 2.5, got ${customDistRun}`);
  }

  const customDistCycle = stravaSync.getTargetDistance('12.5k');
  console.log(`   Verify custom cycle target parsing: '12.5k' mapped to ${customDistCycle} km.`);
  if (customDistCycle === 12.5) {
    console.log('   ✅ Custom cycle distance parsing matches.');
  } else {
    throw new Error(`   ❌ Expected 12.5, got ${customDistCycle}`);
  }

  console.log('3. Uploading daily activities from 26th July 2026...');
  
  // Activities: July 26, 27, 28 (Streak of 3)
  const testActs = [
    { id: 'act_t1', date: '2026-07-26', dist: 6.2, time: 1800 }, // 6.2 km in 30 mins
    { id: 'act_t2', date: '2026-07-27', dist: 5.1, time: 1600 }, // 5.1 km in 26 mins 40s
    { id: 'act_t3', date: '2026-07-28', dist: 8.5, time: 2400 }  // 8.5 km in 40 mins
  ];

  for (const act of testActs) {
    const isValDist = act.dist >= targetDist;
    const speed = act.dist / act.time;

    const insertActSql = `
      INSERT INTO activities (id, user_id, strava_activity_id, type, distance, elapsed_time, has_gps, start_latlng, activity_date, is_valid_distance, speed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;
    await db.query(insertActSql, [
      act.id, userId, act.id, 'run', act.dist, act.time, true, '19.0760,72.8777', act.date, isValDist, speed
    ]);
  }
  
  console.log('   Activities saved. Calculating consistency checks...');
  await stravaSync.updateAllUserConsistency(userId);

  // Check activity verification results
  const actRes = await db.query('SELECT * FROM activities WHERE user_id = $1 ORDER BY activity_date ASC', [userId]);
  
  let allConsistent = true;
  actRes.rows.forEach((row, i) => {
    console.log(`   Activity on ${row.activity_date}: distance=${row.distance}km, valid_distance=${row.is_valid_distance}, consistent=${row.is_consistent}, speed=${(row.speed * 3600).toFixed(2)}km/h`);
    if (!row.is_consistent) allConsistent = false;
  });

  if (allConsistent && actRes.rows.length === 3) {
    console.log('   ✅ Verification checks successfully validated daily consistency logic.');
  } else {
    throw new Error('   ❌ Consistency check logic failed.');
  }

  console.log('4. Testing Leaderboard Rankings query...');
  const lbQuery = `
    SELECT 
      u.name,
      a.speed
    FROM users u
    INNER JOIN (
      SELECT user_id, MAX(speed) as max_speed
      FROM activities
      WHERE is_valid_distance = TRUE AND is_consistent = TRUE
      GROUP BY user_id
    ) max_act ON u.id = max_act.user_id
    INNER JOIN activities a ON a.user_id = u.id AND a.speed = max_act.max_speed
    WHERE u.is_paid = TRUE
  `;
  const lbRes = await db.query(lbQuery);
  if (lbRes.rows.length > 0) {
    console.log(`   ✅ Leaderboard retrieves top rankings. Top speed: ${(lbRes.rows[0].speed * 3600).toFixed(2)} km/h.`);
  } else {
    throw new Error('   ❌ Leaderboard query returned empty rows.');
  }

  // Clean up tests
  await db.query("DELETE FROM activities WHERE user_id LIKE 'test_usr_%'");
  await db.query("DELETE FROM users WHERE id LIKE 'test_usr_%'");
  console.log('   ✅ Cleaned up database records.');

  console.log('\n*** ALL TESTS COMPLETED SUCCESSFULLY! ***');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Verification test failed:', err);
  process.exit(1);
});
