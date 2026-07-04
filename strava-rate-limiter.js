/**
 * Strava API rate limit tracker and throttled fetch wrapper.
 *
 * Strava limits: 100 reads / 15 min, 1,000 reads / day (default tier).
 * Headers: X-ReadRateLimit-Limit and X-ReadRateLimit-Usage (format: "15min,daily").
 *
 * This module wraps fetch for all Strava API calls and:
 *   - Reads response headers to track real usage
 *   - Pauses automatically before each request when usage >= 85% of the 15-min bucket
 *   - Retries once with the correct delay on a 429 response
 */

const state = {
  read15Limit: 100,
  read15Usage: 0,
  readDayLimit: 1000,
  readDayUsage: 0,
  // Timestamp (ms) of the next 15-min window reset, computed lazily
  nextWindowMs: 0,
};

/**
 * Computes the ms timestamp of the next Strava 15-min window boundary
 * (Strava resets at :00, :15, :30, :45 past each hour).
 */
function nextWindowReset() {
  const now = new Date();
  const minutes = now.getMinutes();
  const nextQuarter = (Math.floor(minutes / 15) + 1) * 15;
  const reset = new Date(now);
  if (nextQuarter >= 60) {
    reset.setHours(reset.getHours() + 1, 0, 0, 0);
  } else {
    reset.setMinutes(nextQuarter, 0, 0);
  }
  return reset.getTime();
}

function parseRateLimitHeader(header) {
  if (!header) return null;
  const parts = header.split(',').map(s => parseInt(s.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { per15: parts[0], perDay: parts[1] };
  }
  return null;
}

function updateFromHeaders(headers) {
  const limit = parseRateLimitHeader(headers.get('x-readratelimit-limit'));
  const usage = parseRateLimitHeader(headers.get('x-readratelimit-usage'));
  if (limit) {
    state.read15Limit = limit.per15;
    state.readDayLimit = limit.perDay;
  }
  if (usage) {
    state.read15Usage = usage.per15;
    state.readDayUsage = usage.perDay;
    console.log(`[RateLimit] 15-min: ${state.read15Usage}/${state.read15Limit}  Day: ${state.readDayUsage}/${state.readDayLimit}`);
  }
}

async function waitIfNeeded() {
  // Stop entirely if daily limit exhausted
  if (state.readDayUsage >= state.readDayLimit - 10) {
    const msToMidnight = new Date().setHours(24, 0, 0, 0) - Date.now();
    console.warn(`[RateLimit] Daily limit nearly exhausted. Pausing ${Math.round(msToMidnight / 1000)}s until midnight UTC.`);
    await delay(msToMidnight);
    return;
  }

  // Pause until next 15-min window if 85% of the bucket is consumed
  const threshold = Math.floor(state.read15Limit * 0.85);
  if (state.read15Usage >= threshold) {
    const waitMs = Math.max(nextWindowReset() - Date.now(), 0) + 2000; // +2s buffer
    console.warn(`[RateLimit] 15-min bucket at ${state.read15Usage}/${state.read15Limit}. Pausing ${Math.round(waitMs / 1000)}s.`);
    await delay(waitMs);
    state.read15Usage = 0; // reset optimistically; will be corrected by next response header
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Drop-in replacement for fetch() for all Strava API read calls.
 * Updates rate limit state from response headers and retries once on 429.
 */
async function throttledFetch(url, options = {}) {
  await waitIfNeeded();

  const response = await fetch(url, options);
  updateFromHeaders(response.headers);

  if (response.status === 429) {
    // Strava returned Too Many Requests — wait for next window and retry once
    const waitMs = Math.max(nextWindowReset() - Date.now(), 0) + 3000;
    console.warn(`[RateLimit] 429 received. Retrying after ${Math.round(waitMs / 1000)}s.`);
    await delay(waitMs);
    state.read15Usage = 0;
    const retry = await fetch(url, options);
    updateFromHeaders(retry.headers);
    return retry;
  }

  return response;
}

function getUsage() {
  return {
    per15: `${state.read15Usage}/${state.read15Limit}`,
    perDay: `${state.readDayUsage}/${state.readDayLimit}`,
  };
}

module.exports = { throttledFetch, getUsage };
