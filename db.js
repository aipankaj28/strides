const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

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
      dob VARCHAR(20) NOT NULL,
      gender VARCHAR(20) NOT NULL,
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
