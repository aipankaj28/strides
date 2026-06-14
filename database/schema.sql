-- PostgreSQL Schema for Strides Application
-- Can be run directly in the Supabase SQL Editor

-- 1. Create Users Table
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
  registered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Create Activities Table
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
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  is_valid_distance BOOLEAN DEFAULT FALSE,
  is_consistent BOOLEAN DEFAULT FALSE,
  speed NUMERIC DEFAULT 0,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Create indexes for performance optimization on key lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_activities_user_id ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(activity_date);
