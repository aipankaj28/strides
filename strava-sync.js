const db = require('./db');
const { throttledFetch, getUsage } = require('./strava-rate-limiter');

// Official event start date (YYYY-MM-DD) — mirrors EVENT_START_DATE in server.js.
// Kept as a separate constant here since this module has no Express req/res
// context; both read from the same env var so they never drift apart.
const EVENT_START_DATE = process.env.EVENT_START_DATE || '2026-07-26';

// ---------------------------------------------------------------------------
// Initial-sync queue
// New athletes are enqueued here at OAuth time instead of being synced
// immediately. The queue drains at one user per QUEUE_INTERVAL_MS, keeping
// API usage well under the 100-reads/15-min Strava limit.
// ---------------------------------------------------------------------------
const QUEUE_INTERVAL_MS = 12000; // 1 user per 12 s  → ~75 users / 15-min window
const syncQueue = [];
let queueTimer = null;

function enqueueSyncUser(userId) {
  if (!syncQueue.includes(userId)) {
    syncQueue.push(userId);
    console.log(`[SyncQueue] Enqueued user ${userId}. Queue length: ${syncQueue.length}`);
  }
  if (!queueTimer) startQueueDrain();
}

function startQueueDrain() {
  queueTimer = setInterval(async () => {
    if (syncQueue.length === 0) {
      clearInterval(queueTimer);
      queueTimer = null;
      console.log('[SyncQueue] Queue empty — drain stopped.');
      return;
    }
    const userId = syncQueue.shift();
    console.log(`[SyncQueue] Processing user ${userId}. Remaining: ${syncQueue.length}`);
    try {
      await syncUserActivities(userId);
    } catch (err) {
      console.error(`[SyncQueue] Error syncing user ${userId}:`, err);
    }
  }, QUEUE_INTERVAL_MS);
}

// Map activity distances to numeric targets in km
const DISTANCE_MAP = {
  // Run
  '21k': 21.0,
  '15k': 15.0,
  '10k': 10.0,
  '7k': 7.0,
  '5k': 5.0,
  '2k': 2.0,
  // Cycle
  '50k': 50.0,
  '40k': 40.0,
  '30k': 30.0,
  '20k': 20.0,
  // Mix
  '30k': 30.0,
  '20k': 20.0
};

/**
 * Normalizes activity type from Strava to Strides internal types
 * Strava uses "Run", "Ride", "VirtualRide", "Walk", etc.
 */
function isActivityTypeMatch(userCategory, stravaType) {
  const type = stravaType.toLowerCase();
  if (userCategory === 'run') {
    return type === 'run';
  } else if (userCategory === 'cycle') {
    return type === 'ride' || type === 'virtualride';
  } else if (userCategory === 'mix') {
    return type === 'run' || type === 'ride' || type === 'virtualride';
  }
  return false;
}

function getTargetDistance(distanceStr) {
  if (!distanceStr) return 0.0;
  
  // Try static map first
  const cleanStr = distanceStr.toLowerCase().trim();
  if (DISTANCE_MAP[cleanStr] !== undefined) {
    return DISTANCE_MAP[cleanStr];
  }
  
  // Parse dynamic custom distance (e.g. "2.5k" -> 2.5, "12k" -> 12.0)
  const numericStr = cleanStr.replace('k', '').trim();
  const parsed = parseFloat(numericStr);
  return isNaN(parsed) ? 0.0 : parsed;
}

/**
 * Generates an array of dates (YYYY-MM-DD) from startDate to endDate inclusive
 */
function getDateRange(startDateStr, endDateStr) {
  const dates = [];
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  
  // Create copies to avoid mutating
  let current = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const final = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  while (current <= final) {
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Check if the user has completed at least one valid activity for EVERY single
 * day starting from EVENT_START_DATE up to targetDate. Activities logged
 * before EVENT_START_DATE are never considered -- the window always starts
 * on the official event start date, with no "use the athlete's earlier
 * activity" testing allowance.
 */
async function verifyDailyConsistency(userId, targetDate, activityType, distanceTarget) {
  const startConsistencyDate = EVENT_START_DATE;

  // Should not be called for dates before the event start (the caller guards
  // this), but stay safe: such a date can never be "consistent" under this rule.
  if (targetDate < startConsistencyDate) {
    return false;
  }

  const requiredDates = getDateRange(startConsistencyDate, targetDate);

  // Fetch all activities done by this user that match the category type and exceed target distance
  // We check for these between the start date and targetDate
  const queryText = `
    SELECT DISTINCT activity_date
    FROM activities
    WHERE user_id = $1
      AND activity_date >= $2
      AND activity_date <= $3
      AND is_valid_distance = TRUE
  `;

  const result = await db.query(queryText, [userId, startConsistencyDate, targetDate]);
  const completedDates = new Set(result.rows.map(r => r.activity_date));

  // Check if every required date is present in completedDates
  for (const date of requiredDates) {
    if (!completedDates.has(date)) {
      return false; // Gap found!
    }
  }

  return true;
}

/**
 * Verifies a single activity against the 3 rules
 */
async function verifyActivity(userId, activity) {
  // Fetch user details
  const userResult = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length === 0) return null;
  const user = userResult.rows[0];

  const targetDist = getTargetDistance(user.activity_distance);
  const typeMatch = isActivityTypeMatch(user.activity_type, activity.type);

  // 1st Check: Distance >= Selected Target & Type matches
  const isValidDistance = typeMatch && (activity.distance >= targetDist);

  // If distance matches, we check daily consistency since 2026-07-26 up to this activity date
  let isConsistent = false;
  if (isValidDistance) {
    // Note: We need to save the activity first, then evaluate consistency including this activity
    // To do this, we can temporarily query consistency by pretending the activity is in the database,
    // or we can write a function that performs the check against the database + the new activity.
    // The simplest way is: save the activity to the database with is_valid_distance = TRUE first,
    // then recalculate the consistency status for all activities of this user.
  }

  // Speed = distance in km / elapsed time in seconds
  const speed = activity.elapsed_time > 0 ? (activity.distance / activity.elapsed_time) : 0;

  return {
    isValidDistance,
    speed
  };
}

/**
 * Recalculates and updates the consistency flag for all valid activities of a user.
 * Daily consistency means they have completed at least one valid activity daily
 * from EVENT_START_DATE up to the date of that specific activity. Any activity
 * dated before EVENT_START_DATE is ignored entirely -- always marked not
 * consistent, regardless of distance/type -- since it falls outside the event window.
 */
async function updateAllUserConsistency(userId) {
  // Get user profile
  const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return;
  const user = userRes.rows[0];
  const targetDist = getTargetDistance(user.activity_distance);

  // Get all activities for user sorted by date
  const actRes = await db.query(
    'SELECT * FROM activities WHERE user_id = $1 ORDER BY activity_date ASC',
    [userId]
  );

  const activities = actRes.rows;

  for (const act of activities) {
    let isConsistent = false;

    if (act.is_valid_distance && act.activity_date >= EVENT_START_DATE) {
      // Check consistency up to this activity's date
      isConsistent = await verifyDailyConsistency(userId, act.activity_date, user.activity_type, targetDist);
    }

    await db.query(
      'UPDATE activities SET is_consistent = $1 WHERE id = $2',
      [isConsistent, act.id]
    );
  }
}

/**
 * Exchanges Strava OAuth authorization code for Access and Refresh tokens
 */
async function exchangeStravaCode(code, hostUrl) {
  const clientId = process.env.STRAVA_CLIENT_ID ? process.env.STRAVA_CLIENT_ID.trim() : undefined;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET ? process.env.STRAVA_CLIENT_SECRET.trim() : undefined;

  if (process.env.DEV_MODE === 'true' && (code === 'mock_code' || !clientId || clientId.startsWith('your_'))) {
    // Generate simulated Strava profile
    console.log('Simulating Strava Token Exchange (Dev Mode)...');
    return {
      strava_id: 'mock_athlete_' + Math.floor(Math.random() * 10000),
      access_token: 'mock_access_token_' + Math.random().toString(36).substring(7),
      refresh_token: 'mock_refresh_token_' + Math.random().toString(36).substring(7),
      expires_at: Math.floor(Date.now() / 1000) + 180 * 24 * 3600 // 180 days
    };
  }

  // Real Strava API Call
  console.log(`[Strava API] Requesting Token Exchange. URL: https://www.strava.com/oauth/token. Params:`, {
    client_id: clientId,
    client_secret_length: clientSecret ? clientSecret.length : 0,
    client_secret_preview: clientSecret ? `${clientSecret.substring(0, 3)}...${clientSecret.substring(clientSecret.length - 3)}` : 'undefined',
    code: code ? (code.substring(0, 4) + '...' + code.substring(code.length - 4)) : '',
    grant_type: 'authorization_code'
  });

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code'
    })
  });

  console.log(`[Strava API] Token Exchange Response Status: ${response.status}`);
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Strava API] Token Exchange Error Response: ${errText}`);
    throw new Error(`Strava Token Exchange failed: ${errText}`);
  }

  const data = await response.json();
  console.log(`[Strava API] Token Exchange Response Success:`, {
    token_type: data.token_type,
    expires_at: data.expires_at,
    expires_in: data.expires_in,
    refresh_token: '***MASKED***',
    access_token: '***MASKED***',
    athlete: data.athlete ? { id: data.athlete.id, firstname: data.athlete.firstname, lastname: data.athlete.lastname } : null
  });

  return {
    strava_id: String(data.athlete.id),
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at // unix timestamp in seconds
  };
}

/**
 * Refreshes an expired Strava access token
 */
async function refreshStravaToken(refreshToken) {
  const clientId = process.env.STRAVA_CLIENT_ID ? process.env.STRAVA_CLIENT_ID.trim() : undefined;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET ? process.env.STRAVA_CLIENT_SECRET.trim() : undefined;

  if (refreshToken.startsWith('mock_')) {
    return {
      access_token: 'mock_access_token_refreshed_' + Math.random().toString(36).substring(7),
      expires_at: Math.floor(Date.now() / 1000) + 3600
    };
  }

  console.log(`[Strava API] Requesting Token Refresh. URL: https://www.strava.com/oauth/token. Params:`, {
    client_id: clientId,
    client_secret: '***MASKED***',
    refresh_token: '***MASKED***',
    grant_type: 'refresh_token'
  });

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  console.log(`[Strava API] Token Refresh Response Status: ${response.status}`);
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Strava API] Token Refresh Error Response: ${errText}`);
    throw new Error(`Strava Token Refresh failed: ${errText}`);
  }

  const data = await response.json();
  console.log(`[Strava API] Token Refresh Response Success:`, {
    token_type: data.token_type,
    expires_at: data.expires_at,
    expires_in: data.expires_in,
    refresh_token: '***MASKED***',
    access_token: '***MASKED***'
  });

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at
  };
}

/**
 * Returns a valid (non-expired) Strava access token for a user, refreshing
 * and persisting it first if it's within 5 minutes of expiry.
 * Returns null if the user has no Strava connection or refresh fails.
 */
async function getValidAccessToken(user) {
  if (!user.strava_access_token) return null;

  let accessToken = user.strava_access_token;
  let expiresAt = parseInt(user.strava_token_expires_at);

  const currentTime = Math.floor(Date.now() / 1000);
  if (expiresAt - currentTime < 300) {
    try {
      const refreshed = await refreshStravaToken(user.strava_refresh_token);
      accessToken = refreshed.access_token;
      expiresAt = refreshed.expires_at;

      const updateQuery = `
        UPDATE users
        SET strava_access_token = $1,
            strava_token_expires_at = $2,
            strava_refresh_token = COALESCE($3, strava_refresh_token)
        WHERE id = $4
      `;
      await db.query(updateQuery, [accessToken, expiresAt, refreshed.refresh_token || null, user.id]);
      console.log(`Successfully refreshed Strava token for user: ${user.email}`);
    } catch (error) {
      console.error(`Failed to refresh token for user ${user.email}:`, error);
      return null;
    }
  }

  return accessToken;
}

/**
 * Normalizes a raw Strava activity object and upserts it into the database
 * against the given user, recalculating its verification checks.
 */
async function saveActivityRecord(user, sa) {
  const hasGps = sa.start_latlng && sa.start_latlng.length === 2;
  const startLatLngStr = hasGps ? `${sa.start_latlng[0]},${sa.start_latlng[1]}` : null;

  // Convert meters to km (2 decimal places)
  const distanceKm = Math.round((sa.distance / 1000) * 100) / 100;
  const elapsedTimeSec = sa.elapsed_time;
  const activityDate = sa.start_date_local.substring(0, 10);
  const classType = sa.type.toLowerCase() === 'run' ? 'run' : (sa.type.toLowerCase() === 'ride' ? 'ride' : sa.type.toLowerCase());

  const targetDist = getTargetDistance(user.activity_distance);
  const typeMatch = isActivityTypeMatch(user.activity_type, classType);
  const isValidDistance = typeMatch && (distanceKm >= targetDist);
  const speed = elapsedTimeSec > 0 ? (distanceKm / elapsedTimeSec) : 0;
  const isManual = sa.manual === true;

  const upsertQuery = `
    INSERT INTO activities (id, user_id, strava_activity_id, type, distance, elapsed_time, has_gps, start_latlng, activity_date, is_valid_distance, speed, is_manual)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (strava_activity_id) DO UPDATE SET
      distance = EXCLUDED.distance,
      elapsed_time = EXCLUDED.elapsed_time,
      has_gps = EXCLUDED.has_gps,
      start_latlng = EXCLUDED.start_latlng,
      is_valid_distance = EXCLUDED.is_valid_distance,
      speed = EXCLUDED.speed,
      is_manual = EXCLUDED.is_manual
  `;

  await db.query(upsertQuery, [
    `act_${sa.id}`,
    user.id,
    String(sa.id),
    classType,
    distanceKm,
    elapsedTimeSec,
    hasGps,
    startLatLngStr,
    activityDate,
    isValidDistance,
    speed,
    isManual
  ]);
}

/**
 * Fetches a single activity by Strava activity ID for a user and saves it.
 * Used by the webhook handler to react instantly to create/update events
 * instead of waiting for the periodic poll.
 */
async function fetchAndSaveActivity(userId, stravaActivityId) {
  const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return;
  const user = userRes.rows[0];

  const accessToken = await getValidAccessToken(user);
  if (!accessToken || accessToken.startsWith('mock_')) return;

  try {
    const response = await throttledFetch(`https://www.strava.com/api/v3/activities/${stravaActivityId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Strava Webhook] Failed to fetch activity ${stravaActivityId}: ${errText}`);
      return;
    }

    const sa = await response.json();
    await saveActivityRecord(user, sa);
    await updateAllUserConsistency(userId);
    console.log(`[Strava Webhook] Saved activity ${stravaActivityId} for user ${user.email}.`);
  } catch (error) {
    console.error(`[Strava Webhook] Error fetching activity ${stravaActivityId}:`, error);
  }
}

/**
 * Removes a previously synced activity (Strava "delete" event) and
 * recalculates the owner's consistency streak.
 */
async function removeActivity(userId, stravaActivityId) {
  await db.query('DELETE FROM activities WHERE strava_activity_id = $1', [String(stravaActivityId)]);
  await updateAllUserConsistency(userId);
}

/**
 * Clears stored Strava tokens for an athlete who revoked access
 * (Strava "deauthorization" webhook event).
 */
async function deauthorizeAthlete(stravaAthleteId) {
  await db.query(
    `UPDATE users SET strava_access_token = NULL, strava_refresh_token = NULL, strava_token_expires_at = NULL, strava_profile_public = FALSE WHERE strava_id = $1`,
    [String(stravaAthleteId)]
  );
}

/**
 * Looks up the internal user record owning a given Strava athlete ID.
 */
async function findUserByStravaId(stravaAthleteId) {
  const res = await db.query('SELECT * FROM users WHERE strava_id = $1', [String(stravaAthleteId)]);
  return res.rows.length > 0 ? res.rows[0] : null;
}

/**
 * Synchronize activities from Strava API for a specific user
 */
async function syncUserActivities(userId) {
  const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return;
  const user = userRes.rows[0];

  if (!user.strava_access_token) return;

  const accessToken = await getValidAccessToken(user);
  if (!accessToken) return;

  let stravaActivities = [];

  if (accessToken.startsWith('mock_')) {
    // In mock mode, we do not perform actual REST queries to Strava.
    // Instead, mock activities can be inserted manually via the simulator dashboard.
    return;
  }

  // Real Strava Sync API Call
  try {
    // Get activities. Pull activities since the start of event preparation.
    // If the event hasn't started yet, fetch activities from the last 30 days for testing.
    // Otherwise, fetch activities starting from the event start date.
    const eventStart = Math.floor(new Date(EVENT_START_DATE).getTime() / 1000);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const queryEpoch = nowEpoch < eventStart ? (nowEpoch - 30 * 24 * 3600) : eventStart;
    const requestUrl = `https://www.strava.com/api/v3/athlete/activities?after=${queryEpoch}&per_page=100`;

    console.log(`[Strava API] Syncing Activities. URL: ${requestUrl}. Headers: Authorization: Bearer ***MASKED***`);

    const response = await throttledFetch(requestUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    console.log(`[Strava API] Syncing Activities Response Status: ${response.status}  ${JSON.stringify(getUsage())}`);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Strava API] Strava activities fetch failed: ${errText}`);
      return;
    }

    stravaActivities = await response.json();
    console.log(`[Strava API] Syncing Activities Success. Fetched ${stravaActivities.length} activities.`);
    if (stravaActivities.length > 0) {
      console.log(`[Strava API] Sample Activity:`, JSON.stringify(stravaActivities[0], null, 2));
    }
  } catch (error) {
    console.error(`[Strava API] Error requesting Strava activities for ${user.email}:`, error);
    return;
  }

  // Insert/Update activities into the database
  for (const sa of stravaActivities) {
    try {
      await saveActivityRecord(user, sa);
    } catch (e) {
      console.error(`Error saving activity ${sa.id}:`, e);
    }
  }

  // Recalculate daily consistency for the user
  await updateAllUserConsistency(userId);

  // Stamp last_synced_at so the fallback cron can skip recently-synced users
  await db.query('UPDATE users SET last_synced_at = NOW() WHERE id = $1', [userId]);
}

/**
 * Triggers background sync for all users who have connected Strava
 */
async function syncAllUsers() {
  console.log('[Cron] Running fallback Strava sync (users not synced in last 6 hours)...');
  try {
    // Only target users whose last_synced_at is NULL or older than 6 hours.
    // Healthy webhook delivery means most users will be excluded here.
    const result = await db.query(`
      SELECT id FROM users
      WHERE strava_access_token IS NOT NULL
        AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '6 hours')
    `);
    console.log(`[Cron] ${result.rows.length} user(s) need catch-up sync.`);
    for (const row of result.rows) {
      await syncUserActivities(row.id);
    }
    console.log('[Cron] Fallback sync completed.');
  } catch (error) {
    console.error('[Cron] Error during fallback sync:', error);
  }
}

/**
 * Registers a webhook push subscription with Strava for this app's client_id.
 * Strava only allows ONE active subscription per client_id, so this should
 * be run once (not on every server start). callbackUrl must be a publicly
 * reachable HTTPS URL pointing at the /api/strava/webhook endpoint, and
 * Strava will immediately GET it with a verification challenge before
 * this call resolves.
 */
async function createPushSubscription(callbackUrl, verifyToken) {
  const clientId = process.env.STRAVA_CLIENT_ID ? process.env.STRAVA_CLIENT_ID.trim() : undefined;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET ? process.env.STRAVA_CLIENT_SECRET.trim() : undefined;

  const response = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      callback_url: callbackUrl,
      verify_token: verifyToken
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Strava push subscription creation failed: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Looks up this app's currently registered webhook push subscription(s).
 */
async function viewPushSubscription() {
  const clientId = process.env.STRAVA_CLIENT_ID ? process.env.STRAVA_CLIENT_ID.trim() : undefined;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET ? process.env.STRAVA_CLIENT_SECRET.trim() : undefined;

  const response = await fetch(
    `https://www.strava.com/api/v3/push_subscriptions?client_id=${clientId}&client_secret=${clientSecret}`
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Failed to fetch push subscriptions: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Deletes a webhook push subscription by ID, freeing up the client_id to
 * register a new callback URL.
 */
async function deletePushSubscription(subscriptionId) {
  const clientId = process.env.STRAVA_CLIENT_ID ? process.env.STRAVA_CLIENT_ID.trim() : undefined;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET ? process.env.STRAVA_CLIENT_SECRET.trim() : undefined;

  const response = await fetch(
    `https://www.strava.com/api/v3/push_subscriptions/${subscriptionId}?client_id=${clientId}&client_secret=${clientSecret}`,
    { method: 'DELETE' }
  );
  if (!response.ok && response.status !== 204) {
    const errText = await response.text();
    throw new Error(`Failed to delete push subscription: ${errText}`);
  }
  return true;
}

module.exports = {
  exchangeStravaCode,
  refreshStravaToken,
  syncUserActivities,
  syncAllUsers,
  enqueueSyncUser,
  updateAllUserConsistency,
  getTargetDistance,
  isActivityTypeMatch,
  fetchAndSaveActivity,
  removeActivity,
  deauthorizeAthlete,
  findUserByStravaId,
  createPushSubscription,
  viewPushSubscription,
  deletePushSubscription
};
