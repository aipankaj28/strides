const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const dns = require('dns');

// Force IPv4 DNS resolution — Railway containers cannot reach Supabase over IPv6
dns.setDefaultResultOrder('ipv4first');


let dbType = 'sqlite';
let pgPool = null;
let sqliteDb = null;

const dbUrl = process.env.DATABASE_URL;

if (dbUrl) {
  console.log('Connecting to Cloud PostgreSQL Database...');
  dbType = 'postgres';
  pgPool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.log('Connecting to Local SQLite Database...');
  dbType = 'sqlite';
  const dbDir = path.join(__dirname, 'database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir);
  }
  const dbPath = path.join(dbDir, 'strides.db');
  sqliteDb = new sqlite3.Database(dbPath);
}

// Unified query wrapper
function query(text, params = []) {
  if (dbType === 'postgres') {
    return pgPool.query(text, params);
  } else {
    // Translate $1, $2, ... parameters to ? for SQLite
    const translatedText = text.replace(/\$\d+/g, '?');
    return new Promise((resolve, reject) => {
      sqliteDb.all(translatedText, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve({ rows });
        }
      });
    });
  }
}

// Initialize tables
async function initDb() {
  const usersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      surname VARCHAR(100) NOT NULL,
      dob VARCHAR(20),
      gender VARCHAR(20),
      email VARCHAR(255) UNIQUE NOT NULL,
      mobile VARCHAR(20) NOT NULL,
      activity_type VARCHAR(50) NOT NULL,
      activity_distance VARCHAR(20) NOT NULL,
      tshirt_count INTEGER DEFAULT 0,
      medal_count INTEGER DEFAULT 0,
      payment_id VARCHAR(100),
      total_paid NUMERIC DEFAULT 0,
      is_paid BOOLEAN DEFAULT FALSE,
      strava_id VARCHAR(100),
      strava_access_token VARCHAR(255),
      strava_refresh_token VARCHAR(255),
      strava_token_expires_at BIGINT,
      strava_profile_public BOOLEAN DEFAULT FALSE,
      password_hash VARCHAR(255),
      registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const activitiesTable = `
    CREATE TABLE IF NOT EXISTS activities (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) NOT NULL,
      strava_activity_id VARCHAR(100) UNIQUE NOT NULL,
      type VARCHAR(50) NOT NULL,
      distance NUMERIC NOT NULL,
      elapsed_time NUMERIC NOT NULL,
      has_gps BOOLEAN DEFAULT FALSE,
      start_latlng VARCHAR(255),
      activity_date VARCHAR(20) NOT NULL,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_valid_distance BOOLEAN DEFAULT FALSE,
      is_consistent BOOLEAN DEFAULT FALSE,
      speed NUMERIC DEFAULT 0,
      is_manual BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `;

    try {
      if (dbType === 'postgres') {
        await pgPool.query(usersTable);
        await pgPool.query(activitiesTable);
      } else {
        await new Promise((resolve, reject) => {
          sqliteDb.serialize(() => {
            sqliteDb.run(usersTable, (err) => {
              if (err) return reject(err);
            });
            sqliteDb.run(activitiesTable, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
        });
      }

      // Automatically migrate database if column does not exist
      try {
        await query('ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)');
        console.log('Database Schema Migration: Added password_hash column to users table.');
      } catch (err) {
        // Safe to ignore if column is already present
      }

      try {
        await query('ALTER TABLE users ADD COLUMN last_synced_at TIMESTAMP');
        console.log('Database Schema Migration: Added last_synced_at column to users table.');
      } catch (err) {
        // Safe to ignore if column is already present
      }

      try {
        await query('ALTER TABLE users ADD COLUMN activity_tier VARCHAR(20)');
        console.log('Database Schema Migration: Added activity_tier column to users table.');
      } catch (err) {
        // Safe to ignore if column is already present
      }

      try {
        await query('ALTER TABLE users ADD COLUMN reset_otp_hash VARCHAR(64)');
        console.log('Database Schema Migration: Added reset_otp_hash column to users table.');
      } catch (err) {
        // Safe to ignore if column is already present
      }

      try {
        await query('ALTER TABLE users ADD COLUMN reset_otp_expires_at BIGINT');
        console.log('Database Schema Migration: Added reset_otp_expires_at column to users table.');
      } catch (err) {
        // Safe to ignore if column is already present
      }

      // Mix athletes have no distance requirement, so activity_distance must
      // be nullable for them (Run/Cycle still always set it via app-level
      // validation in server.js). SQLite can't drop a NOT NULL constraint
      // without a full table rebuild, so this only runs against Postgres.
      if (dbType === 'postgres') {
        try {
          await query('ALTER TABLE users ALTER COLUMN activity_distance DROP NOT NULL');
          console.log('Database Schema Migration: Dropped NOT NULL constraint on users.activity_distance.');
        } catch (err) {
          console.error('Failed to drop NOT NULL on users.activity_distance:', err.message);
        }
      }

      // Signup no longer collects date of birth or gender -- both columns
      // must be nullable so new signups can omit them. Existing rows with
      // values are untouched.
      if (dbType === 'postgres') {
        try {
          await query('ALTER TABLE users ALTER COLUMN dob DROP NOT NULL');
          await query('ALTER TABLE users ALTER COLUMN gender DROP NOT NULL');
          console.log('Database Schema Migration: Dropped NOT NULL constraint on users.dob and users.gender.');
        } catch (err) {
          console.error('Failed to drop NOT NULL on users.dob/gender:', err.message);
        }
      }

      // Tracks whether an activity was manually entered on Strava (no device/
      // GPS data) rather than recorded. Manual entries still show up in My
      // Activities as normal, but the leaderboard treats their day as not
      // covered -- see the breaks calculation in /api/leaderboard.
      try {
        await query('ALTER TABLE activities ADD COLUMN is_manual BOOLEAN DEFAULT FALSE');
        console.log('Database Schema Migration: Added is_manual column to activities table.');
      } catch (err) {
        // Safe to ignore if column is already present
      }

      // DB-level backstop preventing two accounts from linking the same Strava
      // athlete (the app-level check in server.js is the primary guard; this
      // catches any race condition or code path that bypasses it). Partial
      // index so unlinked users (strava_id IS NULL) don't collide with each other.
      try {
        await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_strava_id_unique ON users (strava_id) WHERE strava_id IS NOT NULL');
        console.log('Database Schema Migration: Added unique index on users.strava_id.');
      } catch (err) {
        console.error('Failed to create unique index on users.strava_id (likely duplicate strava_id rows already exist):', err.message);
      }

      console.log('Database tables verified/created successfully.');
    } catch (error) {
      console.error('Failed to initialize database tables:', error);
      process.exit(1);
    }
}

module.exports = {
  query,
  initDb,
  getDbType: () => dbType
};
