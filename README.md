# Strides Event Athlete Portal

**Strides** is a production-grade web application built to onboard participants, manage merchandise selections, facilitate checkout, link Strava athlete profiles, sync sports activities in real time, and calculate leaderboard rankings. 

The application is fully responsive (optimized for Chrome/Safari on both mobile and desktop), integrates a hybrid database architecture supporting **local SQLite** and **cloud-native Supabase (PostgreSQL)**, and is configured for instant deployment on **Railway**.

---

## Key Features

1. **Gate Entry**: Dynamic onboarding gate supporting registration form submissions and one-click Email logins.
2. **Interactive Cart**: Base registration fee (₹199) with increments for adding official T-Shirts (₹799) and commemorative Medals (₹399). Computes live 18% GST subtotals.
3. **Simulated Payments**: Renders premium mock checkout processes (simulating Razorpay card interface, dynamic QR scanning, or UPI notification request).
4. **Nodemailer SMTP System**: Dispatches registration receipts via real SMTP mailers, or logs them to the simulation console if SMTP details are omitted.
5. **Strava OAuth 2.0 Integration**: Authorizes participant athletes to retrieve profile and activity logs. Prompts users to set profiles to **public**.
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

## Deployment on Railway

To host this application on Railway:

1. Create a new project on [Railway](https://railway.app/).
2. Select **Deploy from GitHub** and select your repository.
3. In your Railway project, provision a managed **Supabase** instance or use your external Supabase DB.
4. Add the following environment variables in the **Variables** tab of your Railway service:
   * `DATABASE_URL` (Set to your Supabase PostgreSQL URI Connection String).
   * `STRAVA_CLIENT_ID`
   * `STRAVA_CLIENT_SECRET`
   * `DEV_MODE` (Set to `false` in production to hide the Developer tools pane).
   * SMTP details for emails (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`).
5. Railway will automatically bind the application to the correct `PORT` and run `npm start`.
6. **Important**: Go to the Strava Developer Dashboard and add your Railway domain name (e.g. `your-app.up.railway.app`) as the Authorization Callback Domain.
