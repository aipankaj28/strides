# Strides Event Athlete Portal

**Strides** is a production-grade web application built to onboard participants, capture their event category selection, link Strava athlete profiles, sync sports activities in real time, and calculate leaderboard rankings.

The application is fully responsive (optimized for Chrome/Safari on both mobile and desktop), integrates a hybrid database architecture supporting **local SQLite** and **cloud-native Supabase (PostgreSQL)**, and is configured for instant deployment on **Railway**.

---

## Key Features

1. **Gate Entry**: Dynamic onboarding gate supporting registration form submissions and one-click Email logins.
2. **Event Category Selection**: Athletes choose Run, Cycle, or Mix and their target distance. No payment is collected — there is no merchandise, checkout, or pricing step.
3. **Nodemailer SMTP System**: Dispatches registration receipts via real SMTP mailers, or logs them to the simulation console if SMTP details are omitted.
4. **Strava OAuth 2.0 Integration (Mandatory)**: Every athlete must authorize Strava before reaching their dashboard — there is no skip option. Prompts users to set profiles to **public**.
5. **Strava Webhooks**: Receives real-time push events from Strava (new/updated/deleted activities, deauthorization) instead of relying solely on the 10-minute polling cron — see [Strava Webhook Setup](#strava-webhook-setup) below.
6. **Activity Verification Engine**: Computes athlete metrics against three rules:
   * **Rule 1: Distance match** - Syncs Run (2k to 21k), Cycle (10k to 50k), and Mix (10k to 30k) activities, rejecting entries that fall below the user's selected category.
   * **Rule 2: Daily Consistency streak** - Confirms the user has logged a valid activity every single calendar day starting from **26th July 2026** up to the activity date.
   * **Rule 3: Speed Rankings** - Takes elapsed time in seconds, divides distance in km to calculate average speed, and compiles rankings.
7. **Global Leaderboard**: Shared league table with drop-down filters for category, gender, and age brackets (`Upto 18`, `18-30`, `30-40`, `40-50`, `50-60`, `60+`).
8. **Dev Simulator Toolbar**: Sliding test pane (enabled via `DEV_MODE=true` in `.env`) allowing developers to time-travel (manually inject activities for custom dates like July 26th, 2026), log in as any user, trigger sync cron cycles, view mock email inboxes, and wipe test databases.

---

## Technical Stack
* **Backend**: Node.js & Express.
* **Database**: PostgreSQL (via `pg`) for cloud production, SQLite (`sqlite3`) for offline local testing.
* **Frontend**: HTML5, Vanilla CSS3 (glassmorphic theme), Vanilla JS (SPA routing, event bindings).
* **Mailing**: Nodemailer.

---

## Environment Configuration

Create a `.env` file in the root directory (based on `.env.example`):

```env
# Server Settings
PORT=3000
DEV_MODE=true

# Database connection
# Exclude/comment this line to fall back to a local SQLite database (strides.db)
DATABASE_URL=postgresql://postgres:[password]@db.supabase.co:5432/postgres

# Strava API credentials
STRAVA_CLIENT_ID=your_strava_client_id
STRAVA_CLIENT_SECRET=your_strava_client_secret
# Optional redirect override (falls back to hostname/api/auth/strava/callback)
# STRAVA_REDIRECT_URI=https://your-app.up.railway.app/api/auth/strava/callback

# Strava webhook verify token (any random string — see "Strava Webhook Setup" below)
STRAVA_WEBHOOK_VERIFY_TOKEN=choose_a_random_secret_string

# SMTP Email configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM="Strides Event" <no-reply@strides-event.com>
```

---

## Local Setup & Run

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Start the application**:
   ```bash
   npm start
   ```
3. **Open in browser**:
   Navigate to `http://localhost:3000`.

4. **Verify Database Rules (Unit Tests)**:
   You can run the built-in database schema and consistency rules test script to verify calculations:
   ```bash
   node scratch/test_db.js
   ```

---

## Developer Simulation Guide

Since the event consistency starts on **26th July 2026**, verifying daily consistency and leaderboard sorting using real Strava accounts is difficult today. We have built a complete simulator right into the interface:

1. Look for the floating **Purple Gear icon** on the right side of the screen and click it to slide open the Dev Simulator.
2. Under the **Athletes** tab, you can view registered profiles. Clicking **Log In** will instantly log you in as that athlete.
3. Under the **Add Act** tab, select an athlete and upload mock activities:
   * Select a date (e.g. `2026-07-26`).
   * Select type (Run or Ride).
   * Enter distance (make sure it exceeds the selected target distance for the athlete, e.g. `6.5` km for a 5k runner).
   * Enter elapsed time (e.g. 30 minutes).
   * Click **Upload Mock Activity**.
4. Upload activities for consecutive days (e.g., `2026-07-26`, `2026-07-27`, `2026-07-28`) and watch the **Consistency Streak** increase.
5. In the **Athlete Dashboard**, switch to the **Global Leaderboard** tab and observe how participants are ranked by average speed.
6. Skip a day (e.g. upload an activity for `2026-07-30` but omit `2026-07-29`) to verify that the consistency check fails, marking subsequent activities as invalid for leaderboard consideration.
7. Under the **Emails** tab, view sent confirmation emails, copy the **Link My Strava Account** button URLs to test OAuth callbacks.

---

## Strava Webhook Setup

The app polls Strava every 10 minutes in the background, but webhooks let it react to a new/updated/deleted activity (or a user revoking access) within seconds instead. See [Strava's webhook docs](https://developers.strava.com/docs/webhooks/) for background.

**Endpoints added:**
* `GET /api/strava/webhook` — subscription validation handshake (Strava calls this once when you create the subscription).
* `POST /api/strava/webhook` — event delivery. Acknowledges with `200` immediately, then processes the event:
  * `activity` + `create`/`update` → fetches that single activity from Strava and upserts it (same verification rules as the polling sync).
  * `activity` + `delete` → removes the activity and recalculates the athlete's consistency streak.
  * `athlete` + `update` with `updates.authorized: "false"` → clears the athlete's stored Strava tokens (they revoked access).
* `POST /api/admin/strava/webhook-subscribe`, `GET /api/admin/strava/webhook-subscription`, `DELETE /api/admin/strava/webhook-subscription/:id` — one-time subscription management, gated by passing `?client_secret=<your STRAVA_CLIENT_SECRET>`.

**Important constraints from Strava:**
* Only **one** push subscription is allowed per `client_id`. You only need to create it once, against your production callback URL.
* The callback URL must be **publicly reachable over HTTPS** — `localhost` will not work. Subscribe only after deploying (e.g. to Railway).
* Strava validates the subscription by GETing your callback URL and expects `hub.challenge` echoed back, which is why the GET handler must be deployed and reachable *before* you call the subscribe endpoint.

**Setup steps (run once, after deploying):**

1. Set `STRAVA_WEBHOOK_VERIFY_TOKEN` in your production environment to any random string.
2. Create the subscription by POSTing to your own deployed app:
   ```bash
   curl -X POST "https://your-app.up.railway.app/api/admin/strava/webhook-subscribe?client_secret=YOUR_STRAVA_CLIENT_SECRET"
   ```
   This calls Strava's `push_subscriptions` API with `callback_url` set to `https://your-app.up.railway.app/api/strava/webhook`. Strava will immediately validate it against the `GET` handler before the call succeeds.
3. Confirm it's active:
   ```bash
   curl "https://your-app.up.railway.app/api/admin/strava/webhook-subscription?client_secret=YOUR_STRAVA_CLIENT_SECRET"
   ```
4. To replace it later (e.g. new domain), delete the old one first — Strava rejects a second subscription for the same `client_id`:
   ```bash
   curl -X DELETE "https://your-app.up.railway.app/api/admin/strava/webhook-subscription/SUBSCRIPTION_ID?client_secret=YOUR_STRAVA_CLIENT_SECRET"
   ```

If the subscribe call fails with `"GET to callback URL does not return 200"` even though the GET handler works fine when you curl it directly, pass `callbackUrl` explicitly in the request body — some platforms don't report HTTPS correctly to the app on the very first attempt:
```bash
curl -X POST "https://your-app.up.railway.app/api/admin/strava/webhook-subscribe?client_secret=YOUR_STRAVA_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"callbackUrl": "https://your-app.up.railway.app/api/strava/webhook"}'
```

### Dashboard auto-refresh

Webhook events update the database instantly, but the browser still needs to ask for the new data. While the Athlete Dashboard view is open, the frontend polls `GET /api/user/dashboard` every `DASHBOARD_POLL_INTERVAL_SECONDS` (default `15`) so newly synced activities and streak updates show up without a manual page refresh or "Sync Activities" click. Polling automatically pauses when the browser tab is hidden or the user navigates to another view, and resumes when the dashboard becomes visible/active again.

---

## Deployment on Railway

To host this application on Railway:

1. Create a new project on [Railway](https://railway.app/).
2. Select **Deploy from GitHub** and select your repository.
3. In your Railway project, provision a managed **Supabase** instance or use your external Supabase DB.
4. Add the following environment variables in the **Variables** tab of your Railway service:
   * `DATABASE_URL` (Set to your Supabase PostgreSQL URI Connection String).
   * `STRAVA_CLIENT_ID`
   * `STRAVA_CLIENT_SECRET`
   * `STRAVA_WEBHOOK_VERIFY_TOKEN` (any random string — see [Strava Webhook Setup](#strava-webhook-setup)).
   * `DASHBOARD_POLL_INTERVAL_SECONDS` (optional, defaults to `15` — see [Dashboard auto-refresh](#dashboard-auto-refresh)).
   * `DEV_MODE` (Set to `false` in production to hide the Developer tools pane).
   * SMTP details for emails (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`).
5. Railway will automatically bind the application to the correct `PORT` and run `npm start`.
6. After the first successful deploy, follow [Strava Webhook Setup](#strava-webhook-setup) to register the push subscription.
7. **Important**: Go to the Strava Developer Dashboard and add your Railway domain name (e.g. `your-app.up.railway.app`) as the Authorization Callback Domain.
