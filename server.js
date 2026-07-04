require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./db');
const crypto = require('crypto');
const stravaSync = require('./strava-sync');

// Hash password with PBKDF2
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Verify password against stored hash
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

const app = express();
const PORT = process.env.PORT || 3000;

// Railway terminates TLS and forwards via X-Forwarded-Proto; without this,
// req.protocol always reports 'http' even on HTTPS requests, which broke
// the default Strava webhook callback URL (Strava rejects non-HTTPS).
app.set('trust proxy', true);

// Enable CORS and body parsers
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Calculate age based on date string (YYYY-MM-DD)
function calculateAge(dobStr) {
  const birthDate = new Date(dobStr);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

// Map age to age group label
function getAgeGroup(age) {
  if (age < 18) return 'upto18';
  if (age >= 18 && age <= 30) return '18-30';
  if (age > 30 && age <= 40) return '30-40';
  if (age > 40 && age <= 50) return '40-50';
  if (age > 50 && age <= 60) return '50-60';
  return '60plus';
}

// ---------------------------------------------------------
// ONBOARDING & SIGNUP APIS
// ---------------------------------------------------------

// Signup API
app.post('/api/signup', async (req, res) => {
  const { name, surname, dob, gender, email, mobile, password } = req.body;

  if (!name || !surname || !dob || !gender || !email || !mobile || !password) {
    return res.status(400).json({ error: 'All signup fields are required.' });
  }

  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  if (password.length < 8 || !hasUppercase || !hasLowercase || !hasNumber || !hasSpecial) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long and contain uppercase, lowercase, numbers, and special characters.' });
  }

  try {
    // Check if user already exists
    const checkUser = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email ID already registered. Please login instead.' });
    }

    const userId = 'usr_' + Math.random().toString(36).substring(2, 15);
    const passwordHash = hashPassword(password);
    
    // Save partial profile
    const insertQuery = `
      INSERT INTO users (id, name, surname, dob, gender, email, mobile, activity_type, activity_distance, is_paid, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;
    await db.query(insertQuery, [
      userId,
      name.trim(),
      surname.trim(),
      dob,
      gender.toLowerCase(),
      email.toLowerCase().trim(),
      mobile.trim(),
      'run', // Default activity
      '5k',  // Default distance
      false, // Not paid yet
      passwordHash
    ]);

    // Fetch and return the newly created user
    const newUser = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    res.status(201).json(newUser.rows[0]);
  } catch (error) {
    console.error('Error in signup:', error);
    res.status(500).json({ error: 'Registration failed due to server error.' });
  }
});

// Login API
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email ID and password are required.' });
  }

  try {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Email ID not found. Please sign up.' });
    }
    const user = userRes.rows[0];

    // Authenticate password
    if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email ID or password.' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ error: 'Login failed due to server error.' });
  }
});

// ---------------------------------------------------------
// EVENT CATEGORY SELECTION API
// No payment is collected — is_paid is repurposed to mean
// "category/distance selection confirmed" so existing gating
// logic (routing, leaderboard eligibility) keeps working unchanged.
// ---------------------------------------------------------

app.post('/api/checkout', async (req, res) => {
  const { userId, activity_type, activity_distance } = req.body;

  if (!userId || !activity_type || !activity_distance) {
    return res.status(400).json({ error: 'Missing category, distance, or user identifier.' });
  }

  try {
    const updateQuery = `
      UPDATE users
      SET activity_type = $1,
          activity_distance = $2,
          is_paid = TRUE
      WHERE id = $3
    `;
    await db.query(updateQuery, [activity_type, activity_distance, userId]);

    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(userRes.rows[0]);
  } catch (error) {
    console.error('Error saving event category selection:', error);
    res.status(500).json({ error: 'Failed to save your selection.' });
  }
});

// ---------------------------------------------------------
// STRAVA OAUTH FLOW APIS
// ---------------------------------------------------------

// Strava redirect authorization URI generator
app.get('/api/auth/strava', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'Missing user ID.' });
  }

  const clientId = process.env.STRAVA_CLIENT_ID ? process.env.STRAVA_CLIENT_ID.trim() : undefined;
  const redirectUriOverride = process.env.STRAVA_REDIRECT_URI ? process.env.STRAVA_REDIRECT_URI.trim() : undefined;
  const host = req.get('host');
  const redirectUri = redirectUriOverride || `${req.protocol}://${host}/api/auth/strava/callback`;

  // Check if we are running in Dev Mode without real credentials
  if (process.env.DEV_MODE === 'true' && (!clientId || clientId.startsWith('your_'))) {
    // Generate simple redirect back to callback with mock token code
    return res.json({
      url: `/api/auth/strava/callback?code=mock_code&state=${userId}`
    });
  }

  const oauthUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read,activity:read_all&state=${userId}`;
  res.json({ url: oauthUrl });
});

// OAuth Callback Endpoint
app.get('/api/auth/strava/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

  if (error) {
    console.error('Strava authorization denied:', error);
    // Include the userId's email so the frontend can restore the user session
    const errUserRes = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
    const errEmail = errUserRes.rows.length > 0 ? errUserRes.rows[0].email : null;
    const redirectBase = errEmail
      ? `/#/connect-strava?email=${encodeURIComponent(errEmail)}`
      : '/#/connect-strava';
    return res.redirect(`${redirectBase}&error=${encodeURIComponent(error)}`);
  }

  if (!code || !userId) {
    return res.status(400).send('Invalid OAuth callback parameters.');
  }

  try {
    const hostUrl = `${req.protocol}://${req.get('host')}`;
    const tokens = await stravaSync.exchangeStravaCode(code, hostUrl);

    // Update tokens in users database
    const updateQuery = `
      UPDATE users
      SET strava_id = $1,
          strava_access_token = $2,
          strava_refresh_token = $3,
          strava_token_expires_at = $4,
          strava_profile_public = TRUE
      WHERE id = $5
    `;
    await db.query(updateQuery, [
      tokens.strava_id,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_at,
      userId
    ]);

    // Queue initial sync — processed at a rate-limited pace alongside other new signups
    stravaSync.enqueueSyncUser(userId);

    // Fetch user email to redirect them back to dashboard
    const userRes = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length > 0) {
      res.redirect(`/#/dashboard?email=${encodeURIComponent(userRes.rows[0].email)}`);
    } else {
      res.redirect('/#/dashboard');
    }
  } catch (error) {
    console.error('Error during Strava OAuth callback:', error);
    res.status(500).send(`Strava connection authentication failed: ${error.message}`);
  }
});

// ---------------------------------------------------------
// STRAVA WEBHOOK EVENTS
// https://developers.strava.com/docs/webhooks/
// ---------------------------------------------------------

// Subscription validation handshake. Strava GETs this once when a push
// subscription is created and expects the hub.challenge value echoed back.
app.get('/api/strava/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN
    ? process.env.STRAVA_WEBHOOK_VERIFY_TOKEN.trim()
    : undefined;

  if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
    console.log('[Strava Webhook] Subscription validation succeeded.');
    return res.status(200).json({ 'hub.challenge': challenge });
  }

  console.error('[Strava Webhook] Subscription validation failed: token mismatch.');
  res.sendStatus(403);
});

// Event delivery endpoint. Strava requires a 200 response within 2 seconds,
// so we acknowledge immediately and process the event afterwards.
app.post('/api/strava/webhook', (req, res) => {
  res.sendStatus(200);

  const { object_type, object_id, aspect_type, owner_id, updates } = req.body || {};
  console.log('[Strava Webhook] Event received:', JSON.stringify(req.body));

  (async () => {
    try {
      if (object_type === 'activity') {
        const user = await stravaSync.findUserByStravaId(owner_id);
        if (!user) {
          console.warn(`[Strava Webhook] No matching user for athlete ${owner_id}.`);
          return;
        }

        if (aspect_type === 'create' || aspect_type === 'update') {
          await stravaSync.fetchAndSaveActivity(user.id, object_id);
        } else if (aspect_type === 'delete') {
          await stravaSync.removeActivity(user.id, object_id);
        }
      } else if (object_type === 'athlete') {
        // Deauthorization is delivered as an athlete update with updates.authorized === "false"
        if (updates && updates.authorized === 'false') {
          await stravaSync.deauthorizeAthlete(owner_id);
          console.log(`[Strava Webhook] Athlete ${owner_id} revoked access. Tokens cleared.`);
        }
      }
    } catch (error) {
      console.error('[Strava Webhook] Error processing event:', error);
    }
  })();
});

// ---------------------------------------------------------
// STRAVA WEBHOOK SUBSCRIPTION MANAGEMENT (one-time setup, secret-gated)
// ---------------------------------------------------------

const isStravaAdmin = (req, res, next) => {
  const secret = req.query.client_secret || (req.body && req.body.client_secret);
  const expected = process.env.STRAVA_CLIENT_SECRET ? process.env.STRAVA_CLIENT_SECRET.trim() : undefined;
  if (expected && secret === expected) {
    return next();
  }
  res.status(403).json({ error: 'Invalid or missing client_secret.' });
};

// Creates the (single, app-wide) push subscription. Run this once after
// deploying, pointing callbackUrl at this server's public /api/strava/webhook URL.
app.post('/api/admin/strava/webhook-subscribe', isStravaAdmin, async (req, res) => {
  try {
    const host = req.get('host');
    const callbackUrl = req.body.callbackUrl || `${req.protocol}://${host}/api/strava/webhook`;
    const verifyToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN
      ? process.env.STRAVA_WEBHOOK_VERIFY_TOKEN.trim()
      : undefined;

    if (!verifyToken) {
      return res.status(400).json({ error: 'STRAVA_WEBHOOK_VERIFY_TOKEN is not configured on the server.' });
    }

    const subscription = await stravaSync.createPushSubscription(callbackUrl, verifyToken);
    res.json({ success: true, subscription });
  } catch (error) {
    console.error('Error creating Strava push subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Views the currently registered subscription.
app.get('/api/admin/strava/webhook-subscription', isStravaAdmin, async (req, res) => {
  try {
    const subscriptions = await stravaSync.viewPushSubscription();
    res.json(subscriptions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deletes a subscription by ID (needed before registering a new callback URL).
app.delete('/api/admin/strava/webhook-subscription/:id', isStravaAdmin, async (req, res) => {
  try {
    await stravaSync.deletePushSubscription(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Public Configuration Endpoint
app.get('/api/config', (req, res) => {
  res.json({
    devMode: process.env.DEV_MODE === 'true',
    dashboardPollSeconds: parseInt(process.env.DASHBOARD_POLL_INTERVAL_SECONDS) || 15
  });
});

// ---------------------------------------------------------
// DASHBOARD & LEADERBOARD APIS
// ---------------------------------------------------------

// User Dashboard Data API
app.get('/api/user/dashboard', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email query parameter is required.' });
  }

  try {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }
    const user = userRes.rows[0];

    // Fetch activities sorted by date desc
    const actRes = await db.query('SELECT * FROM activities WHERE user_id = $1 ORDER BY activity_date DESC', [user.id]);
    
    // Calculate streak length (consecutive days with consistent activities since 2026-07-26)
    // If testing before the event start, calculate consistency relative to their first recorded activity
    let streakDays = 0;
    const startConsistencyDate = '2026-07-26';
    
    // Query list of distinct dates where the user had a valid activity
    const datesRes = await db.query(
      'SELECT DISTINCT activity_date FROM activities WHERE user_id = $1 AND is_valid_distance = TRUE ORDER BY activity_date ASC',
      [user.id]
    );

    const validDates = datesRes.rows.map(r => r.activity_date);
    
    if (validDates.length > 0) {
      // If the earliest activity is before July 26th, start the streak validation from that date for testing
      const effectiveStartDate = (validDates[0] < startConsistencyDate) ? validDates[0] : startConsistencyDate;
      const latestDateStr = validDates[validDates.length - 1];
      
      // Calculate streak from effectiveStartDate up to the latest date
      if (latestDateStr >= effectiveStartDate) {
        let current = new Date(effectiveStartDate);
        const latest = new Date(latestDateStr);
        const completedSet = new Set(validDates);
        let consistent = true;
        
        while (current <= latest) {
          const yyyy = current.getFullYear();
          const mm = String(current.getMonth() + 1).padStart(2, '0');
          const dd = String(current.getDate()).padStart(2, '0');
          const dateStr = `${yyyy}-${mm}-${dd}`;
          
          if (completedSet.has(dateStr)) {
            streakDays++;
          } else {
            consistent = false;
            break; // Streak broken!
          }
          current.setDate(current.getDate() + 1);
        }
        
        if (!consistent) {
          // If broken, streak length is the number of consistent days from latest backwards
          streakDays = 0;
          let temp = new Date(latest);
          while (temp >= new Date(effectiveStartDate)) {
            const yyyy = temp.getFullYear();
            const mm = String(temp.getMonth() + 1).padStart(2, '0');
            const dd = String(temp.getDate()).padStart(2, '0');
            const dateStr = `${yyyy}-${mm}-${dd}`;
            if (completedSet.has(dateStr)) {
              streakDays++;
            } else {
              break;
            }
            temp.setDate(temp.getDate() - 1);
          }
        }
      }
    }

    res.json({
      user,
      activities: actRes.rows,
      streak: streakDays,
      targetDistance: stravaSync.getTargetDistance(user.activity_distance)
    });
  } catch (error) {
    console.error('Error loading dashboard data:', error);
    res.status(500).json({ error: 'Server error loading profile dashboard.' });
  }
});

// Global Leaderboard API
app.get('/api/leaderboard', async (req, res) => {
  const { category, gender, ageGroup } = req.query;

  try {
    // Athlete qualifies for the leaderboard once they have at least one activity
    // that is both distance-valid and consistent. Consistency streak = count of
    // such activities (each one implies every prior required day was also met).
    // Total distance = sum of every activity logged by the athlete, valid or not.
    let sqlQuery = `
      SELECT
        u.id as user_id,
        u.name,
        u.surname,
        u.gender,
        u.dob,
        u.activity_type,
        u.activity_distance,
        (SELECT COUNT(*) FROM activities s
           WHERE s.user_id = u.id AND s.is_valid_distance = TRUE AND s.is_consistent = TRUE) as streak,
        (SELECT COALESCE(SUM(distance), 0) FROM activities t
           WHERE t.user_id = u.id) as total_distance
      FROM users u
      WHERE u.is_paid = TRUE
        AND EXISTS (
          SELECT 1 FROM activities e
          WHERE e.user_id = u.id AND e.is_valid_distance = TRUE AND e.is_consistent = TRUE
        )
    `;

    const params = [];
    let paramIndex = 1;

    // Apply activity category filter (run, cycle, mix)
    if (category) {
      sqlQuery += ` AND u.activity_type = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    // Apply gender filter
    if (gender) {
      sqlQuery += ` AND u.gender = $${paramIndex}`;
      params.push(gender);
      paramIndex++;
    }

    const result = await db.query(sqlQuery, params);

    // Map database rows and calculate ages to apply age group filter client-side / node-side
    let leaderboard = result.rows.map(row => {
      const age = calculateAge(row.dob);
      return {
        userId: row.user_id,
        name: `${row.name} ${row.surname}`,
        gender: row.gender,
        age: age,
        ageGroup: getAgeGroup(age),
        category: row.activity_type,
        targetDistance: row.activity_distance,
        streak: parseInt(row.streak),
        totalDistance: parseFloat(row.total_distance)
      };
    });

    // Apply age group filter
    if (ageGroup) {
      leaderboard = leaderboard.filter(item => item.ageGroup === ageGroup);
    }

    // Sort leaderboard by consistency streak descending, then total distance descending
    leaderboard.sort((a, b) => b.streak - a.streak || b.totalDistance - a.totalDistance);

    // Add Rank
    leaderboard = leaderboard.map((item, idx) => ({
      rank: idx + 1,
      ...item
    }));

    res.json(leaderboard);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Server error generating leaderboard rankings.' });
  }
});

// ---------------------------------------------------------
// DEVELOPER SIMULATOR / ADMIN APIS (Protected by DEV_MODE)
// ---------------------------------------------------------

const isDevMode = (req, res, next) => {
  if (process.env.DEV_MODE === 'true') {
    next();
  } else {
    res.status(403).json({ error: 'Admin simulation tools are disabled in production.' });
  }
};

// List all users
app.get('/api/admin/users', isDevMode, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM users ORDER BY registered_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email endpoints removed

// Insert simulated activity to test rules
app.post('/api/admin/mock-activity', isDevMode, async (req, res) => {
  const { userId, type, distance, elapsed_time, has_gps, start_latlng, activity_date } = req.body;

  if (!userId || !type || !distance || !elapsed_time || !activity_date) {
    return res.status(400).json({ error: 'All fields (userId, type, distance, elapsed_time, activity_date) are required.' });
  }

  try {
    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = userRes.rows[0];

    const actId = 'act_mock_' + Math.floor(Math.random() * 1000000);
    const distanceKm = parseFloat(distance);
    const elapsedSec = parseFloat(elapsed_time);
    
    // Evaluate Rule 1: Distance check
    const targetDist = stravaSync.getTargetDistance(user.activity_distance);
    const typeMatch = (user.activity_type === 'run' && type.toLowerCase() === 'run') ||
                      (user.activity_type === 'cycle' && type.toLowerCase() === 'ride') ||
                      (user.activity_type === 'mix' && (type.toLowerCase() === 'run' || type.toLowerCase() === 'ride'));
    
    const isValidDistance = typeMatch && (distanceKm >= targetDist);
    const speed = elapsedSec > 0 ? (distanceKm / elapsedSec) : 0;

    const insertQuery = `
      INSERT INTO activities (id, user_id, strava_activity_id, type, distance, elapsed_time, has_gps, start_latlng, activity_date, is_valid_distance, speed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;
    await db.query(insertQuery, [
      actId,
      userId,
      actId, // actId is also used as unique strava_activity_id
      type.toLowerCase(),
      distanceKm,
      elapsedSec,
      has_gps === 'true' || has_gps === true,
      start_latlng || '19.0760,72.8777', // Default to Mumbai coordinates if empty
      activity_date,
      isValidDistance,
      speed
    ]);

    // Recalculate daily consistency for user
    await stravaSync.updateAllUserConsistency(userId);

    res.json({ success: true, activityId: actId });
  } catch (error) {
    console.error('Error inserting mock activity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset database
app.post('/api/admin/reset', isDevMode, async (req, res) => {
  try {
    await db.query('DELETE FROM activities');
    await db.query('DELETE FROM users');
    res.json({ success: true, message: 'Database reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger background sync manually
app.post('/api/admin/sync-all', isDevMode, async (req, res) => {
  await stravaSync.syncAllUsers();
  res.json({ success: true, message: 'Sync completed.' });
});


// ---------------------------------------------------------
// SERVER INITIALIZATION
// ---------------------------------------------------------

app.listen(PORT, async () => {
  // Initialize Database tables
  await db.initDb();
  
  // Email configuration removed

  console.log(`Strides Web App is running on port ${PORT}`);

  // Fallback sync cron — runs every 6 hours to catch any activities missed by webhooks.
  // Skips users synced within the last 6 hours so normal webhook-driven updates
  // don't burn any API quota here.
  setInterval(() => {
    stravaSync.syncAllUsers();
  }, 6 * 60 * 60 * 1000);
});
