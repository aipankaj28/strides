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

// Checks a plaintext password meets the same strength rule enforced at signup
function isPasswordStrong(password) {
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  return password.length >= 8 && hasUppercase && hasLowercase && hasNumber && hasSpecial;
}

// Hashes a 6-digit OTP with SHA-256 for storage — OTPs are short-lived and
// single-use, so a fast hash (rather than PBKDF2) is sufficient here.
function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

// Sends an email via the Resend HTTP API. Uses fetch directly rather than
// pulling in the resend npm package, consistent with how this app already
// talks to the Strava REST API elsewhere.
async function sendEmailViaResend(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL || 'Strides <onboarding@resend.dev>';

  if (!apiKey) {
    console.warn(`[Resend] RESEND_API_KEY not set — logging OTP email to console instead of sending.\nTo: ${to}\nSubject: ${subject}\n${html}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: fromAddress, to: [to], subject, html })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errText}`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Official event start date (YYYY-MM-DD). Consistency/streak/breaks
// calculations, the mandatory-Strava messaging, and the dev simulator's
// default activity date all key off this. Override via env var; defaults
// to the originally announced date.
const EVENT_START_DATE = process.env.EVENT_START_DATE || '2026-07-26';

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
// FORGOT PASSWORD (OTP via Resend)
// ---------------------------------------------------------

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Step 1: request an OTP. Returns an explicit 404 if the email isn't
// registered (chosen over a generic response for clearer UX, at the cost
// of letting this endpoint be used to enumerate registered emails).
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email ID is required.' });
  }

  try {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Email ID not found. Please check and try again, or sign up.' });
    }
    const user = userRes.rows[0];

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = Date.now() + OTP_EXPIRY_MS;

    await db.query(
      'UPDATE users SET reset_otp_hash = $1, reset_otp_expires_at = $2 WHERE id = $3',
      [hashOtp(otp), expiresAt, user.id]
    );

    await sendEmailViaResend(
      user.email,
      'Your Strides Password Reset Code',
      `<div style="font-family: sans-serif;">
        <p>Hi ${user.name},</p>
        <p>Your Strides password reset code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${otp}</p>
        <p>This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>`
    );

    res.json({ message: 'A verification code has been sent to your email.' });
  } catch (error) {
    console.error('Error in forgot-password:', error);
    res.status(500).json({ error: 'Failed to process password reset request.' });
  }
});

// Step 2: verify the OTP and set a new password
app.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, verification code, and new password are all required.' });
  }

  if (!isPasswordStrong(newPassword)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long and contain uppercase, lowercase, numbers, and special characters.' });
  }

  try {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (userRes.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }
    const user = userRes.rows[0];

    if (!user.reset_otp_hash || !user.reset_otp_expires_at) {
      return res.status(400).json({ error: 'No password reset was requested for this email.' });
    }
    if (Date.now() > parseInt(user.reset_otp_expires_at)) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }
    if (hashOtp(otp) !== user.reset_otp_hash) {
      return res.status(400).json({ error: 'Incorrect verification code.' });
    }

    await db.query(
      'UPDATE users SET password_hash = $1, reset_otp_hash = NULL, reset_otp_expires_at = NULL WHERE id = $2',
      [hashPassword(newPassword), user.id]
    );

    res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (error) {
    console.error('Error in reset-password:', error);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ---------------------------------------------------------
// EVENT CATEGORY SELECTION API
// No payment is collected — is_paid is repurposed to mean
// "category/distance selection confirmed" so existing gating
// logic (routing, leaderboard eligibility) keeps working unchanged.
// ---------------------------------------------------------

app.post('/api/checkout', async (req, res) => {
  const { userId, activity_type, activity_distance, activity_tier } = req.body;

  if (!userId || !activity_type || !activity_distance) {
    return res.status(400).json({ error: 'Missing category, distance, or user identifier.' });
  }

  // Tier (Pro/Intermediate/Beginner/Flexi) applies to Run and Cycle only — Mix has no tiers.
  if ((activity_type === 'run' || activity_type === 'cycle') && !activity_tier) {
    return res.status(400).json({ error: 'Missing tier selection for this category.' });
  }

  try {
    const updateQuery = `
      UPDATE users
      SET activity_type = $1,
          activity_distance = $2,
          activity_tier = $3,
          is_paid = TRUE
      WHERE id = $4
    `;
    await db.query(updateQuery, [activity_type, activity_distance, activity_type === 'mix' ? null : activity_tier, userId]);

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

    // Reject if this Strava athlete is already linked to a different Strides account
    const conflictRes = await db.query(
      'SELECT id, email FROM users WHERE strava_id = $1 AND id != $2',
      [tokens.strava_id, userId]
    );
    if (conflictRes.rows.length > 0) {
      console.warn(`Strava account ${tokens.strava_id} already linked to user ${conflictRes.rows[0].id}; rejecting link attempt from ${userId}.`);
      const requesterRes = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
      const requesterEmail = requesterRes.rows.length > 0 ? requesterRes.rows[0].email : null;
      const redirectBase = requesterEmail
        ? `/#/connect-strava?email=${encodeURIComponent(requesterEmail)}`
        : '/#/connect-strava';
      const message = 'This Strava account is already linked to another Strides profile. Please use a different Strava account.';
      return res.redirect(`${redirectBase}&error=${encodeURIComponent(message)}`);
    }

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
    dashboardPollSeconds: parseInt(process.env.DASHBOARD_POLL_INTERVAL_SECONDS) || 15,
    eventStartDate: EVENT_START_DATE
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
    
    // Consistency Streak = count of activities already flagged is_consistent by
    // updateAllUserConsistency() (same forward-from-start algorithm that produces
    // the per-row "Streak OK/Broken" badges and the Global Leaderboard ranking).
    // Keeping a single source of truth here avoids the dashboard stat disagreeing
    // with the table/leaderboard.
    const streakRes = await db.query(
      'SELECT COUNT(*) as streak FROM activities WHERE user_id = $1 AND is_valid_distance = TRUE AND is_consistent = TRUE',
      [user.id]
    );
    const streakDays = parseInt(streakRes.rows[0].streak);

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

function dateRange(startStr, endStr) {
  const dates = [];
  let cur = new Date(startStr + 'T00:00:00Z');
  const last = new Date(endStr + 'T00:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Global Leaderboard API
//
// Every paid athlete in the selected category is shown (no eligibility gate) and
// ranked using a "breaks" model instead of the old all-or-nothing streak flag:
//   - Window = [effective start date, today]. Effective start = the athlete's
//     earliest activity if that's before the official event start (2026-07-26),
//     otherwise the event start itself. Athletes with no activities use the
//     event start as-is, so an inactive athlete accrues one break per elapsed day.
//   - A day is "covered" only if the athlete logged an activity of the CORRECT
//     type that day (a wrong-type log counts as a break, same as no activity).
//   - A covered day is "met" if that day's distance satisfies the target.
//   - breaks = count of uncovered days; isPerfect = zero breaks AND every
//     covered day was met.
// Ranking: fewer breaks first; among equal breaks, isPerfect athletes rank
// above non-perfect ones; ties broken by average pace (total elapsed time /
// total distance across every logged activity) — a faster pace (fewer
// seconds per km) ranks higher. totalDistance is returned for display only
// and does NOT factor into ranking. Standard competition ranking — exact
// ties share a rank number, and the next distinct entry resumes at its
// true position.
app.get('/api/leaderboard', async (req, res) => {
  const { category } = req.query;

  try {
    let userQuery = 'SELECT id, name, surname, activity_type, activity_distance FROM users WHERE is_paid = TRUE';
    const params = [];
    if (category) {
      userQuery += ' AND activity_type = $1';
      params.push(category);
    }
    const usersRes = await db.query(userQuery, params);
    const users = usersRes.rows;

    if (users.length === 0) {
      return res.json([]);
    }

    const userIds = users.map(u => u.id);
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
    const actsRes = await db.query(
      `SELECT user_id, activity_date, distance, type, is_valid_distance, elapsed_time FROM activities WHERE user_id IN (${placeholders}) ORDER BY activity_date ASC`,
      userIds
    );

    const actsByUser = {};
    actsRes.rows.forEach(a => {
      if (!actsByUser[a.user_id]) actsByUser[a.user_id] = [];
      actsByUser[a.user_id].push(a);
    });

    const eventStartDate = EVENT_START_DATE;
    const today = new Date().toISOString().slice(0, 10);

    let leaderboard = users.map(u => {
      const acts = actsByUser[u.id] || [];
      const totalDistance = acts.reduce((sum, a) => sum + parseFloat(a.distance), 0);
      const totalElapsedSec = acts.reduce((sum, a) => sum + parseFloat(a.elapsed_time), 0);
      // Average pace across every logged activity (seconds per km) -- lower is
      // faster. Athletes with zero distance logged get Infinity so they never
      // win a pace tie-break.
      const avgPaceSecPerKm = totalDistance > 0 ? totalElapsedSec / totalDistance : Infinity;
      const effectiveStart = (acts.length > 0 && acts[0].activity_date < eventStartDate)
        ? acts[0].activity_date
        : eventStartDate;

      let breaks = 0;
      let isPerfect = false;

      if (effectiveStart <= today) {
        const byDate = {};
        acts.forEach(a => {
          if (!byDate[a.activity_date]) byDate[a.activity_date] = { typeMatch: false, met: false };
          if (stravaSync.isActivityTypeMatch(u.activity_type, a.type)) byDate[a.activity_date].typeMatch = true;
          if (a.is_valid_distance) byDate[a.activity_date].met = true;
        });

        isPerfect = true;
        for (const d of dateRange(effectiveStart, today)) {
          const day = byDate[d];
          if (!day || !day.typeMatch) {
            breaks++;
            isPerfect = false;
          } else if (!day.met) {
            isPerfect = false;
          }
        }
      }

      return {
        userId: u.id,
        name: `${u.name} ${u.surname}`,
        category: u.activity_type,
        targetDistance: u.activity_distance,
        breaks,
        isPerfect,
        totalDistance,
        avgPaceSecPerKm
      };
    });

    // Fewer breaks first; among equal breaks, isPerfect ranks above not-perfect;
    // final tie-break is average pace ascending (faster wins). totalDistance is
    // NOT part of ranking -- it's returned purely for display.
    leaderboard.sort((a, b) =>
      a.breaks - b.breaks ||
      (b.isPerfect - a.isPerfect) ||
      a.avgPaceSecPerKm - b.avgPaceSecPerKm
    );

    // Standard competition ranking: ties on (breaks, isPerfect, pace) share a rank
    let lastRank = 0, lastBreaks = null, lastPerfect = null, lastPace = null;
    leaderboard = leaderboard.map((item, idx) => {
      const tied = lastBreaks === item.breaks && lastPerfect === item.isPerfect
        && lastPace === item.avgPaceSecPerKm;
      const rank = tied ? lastRank : idx + 1;
      lastRank = rank;
      lastBreaks = item.breaks;
      lastPerfect = item.isPerfect;
      lastPace = item.avgPaceSecPerKm;
      return { rank, ...item };
    });

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
