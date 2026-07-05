# Global Leaderboard: How the Leader Is Decided

This document explains the ranking logic behind the Global Leaderboard (`GET /api/leaderboard`, implemented in [server.js](server.js)). It reflects the "breaks" model, which replaced an earlier all-or-nothing consistency flag.

## Who appears on the leaderboard

Every athlete who has completed registration (`is_paid = TRUE`) appears — **there is no eligibility gate**. An athlete who has never logged a single activity still shows up, ranked at (or near) the bottom. The leaderboard is scoped to one event sub-tab at a time (Running/Walking, Cycling, or Mixed) via the `category` filter.

## Step 1 — Establish each athlete's window

Every athlete is evaluated over a date range: **`[effective start date, today]`**.

- **Effective start date** = the athlete's *earliest logged activity*, if that date is before the official event start (`EVENT_START_DATE`, default `2026-07-26`, configurable via env var).
- Otherwise, effective start = the event start date itself.
- An athlete with **zero activities** simply uses the event start date as-is — meaning an inactive athlete silently accumulates one break for every day since the event began.

This "use their earliest activity if it's earlier" rule exists purely to support testing/simulation before the real event start; once the event start date has passed, it has no effect (every athlete's window begins on the same day).

## Step 2 — Classify every day in that window

For each calendar day in the athlete's window, the day is classified as:

| Day status | Condition |
|---|---|
| **Break** | No activity logged that day, **or** the only activity(ies) logged were the wrong type for the athlete's category |
| **Covered, not met** | At least one correctly-typed activity was logged, but none of them reached the target distance |
| **Covered, met** | At least one correctly-typed activity reached the target distance |

**Type matching** (from `isActivityTypeMatch()` in [strava-sync.js](strava-sync.js)):

| Athlete's category | Strava activity types that count |
|---|---|
| Run | `Run` only |
| Cycle | `Ride` or `VirtualRide` |
| Mix | `Run`, `Ride`, or `VirtualRide` |

Anything else Strava can report — Swim, Hike, Walk, Yoga, Golf, etc. — never matches any category, so a day where the athlete only logged one of those is treated as a **break**, identical to not logging anything at all.

If multiple activities are logged on the same day, the day is judged generously: it's "met" if **any** activity that day satisfies distance + type, even if others that day didn't.

## Step 3 — Compute two numbers per athlete

- **`breaks`** — total count of "Break" days across the whole window.
- **`isPerfect`** — `true` only if `breaks === 0` **and** every single covered day was "met" (never just "covered, not met"). One short-distance day anywhere in the window disqualifies an athlete from Perfect status, even with zero breaks.

Additionally:

- **`totalDistance`** — the sum of every activity's distance ever logged by the athlete, **regardless of whether it was valid, the right type, or on a break day**. A swim, a short run, all of it counts toward this number. This is deliberately unfiltered — it rewards total effort/volume independent of the consistency scoring above.
- **`avgPaceSecPerKm`** — total elapsed time across every logged activity divided by `totalDistance` (seconds per km — lower is faster). Same unfiltered scope as `totalDistance`: every logged activity contributes, valid or not. Athletes with zero logged distance get `Infinity`, so they never win a pace comparison.

## Step 4 — The three tiers, in ranking order

| Tier | Condition | Meaning |
|---|---|---|
| **1 — Perfect** | `breaks = 0` and `isPerfect = true` | Logged the correct activity type, meeting the distance target, on every single required day |
| **2 — Consistent (Short)** | `breaks = 0` and `isPerfect = false` | Never missed a day, but fell short of the distance target on at least one covered day |
| **3 — N Breaks** | `breaks ≥ 1` | Missed at least one day entirely (or only logged a wrong-type activity that day); ranked worse the more breaks accumulated |

This maps directly to the sort:

```js
leaderboard.sort((a, b) =>
  a.breaks - b.breaks ||                       // fewer breaks always wins
  (b.isPerfect - a.isPerfect) ||                // among equal breaks, Perfect beats Consistent(Short)
  b.totalDistance - a.totalDistance ||          // next tie-break: more distance wins
  a.avgPaceSecPerKm - b.avgPaceSecPerKm         // final tie-break: faster average pace wins
);
```

An athlete with 1 break can never outrank an athlete with 0 breaks, no matter how much further the 1-break athlete ran. Consistency always dominates volume; volume only decides ties; pace only decides ties that survive both of the above.

**Pace example:** two athletes both at 0 breaks, Perfect, and 21 km total distance — one averaging 6:00/km, the other 7:00/km — the 6:00/km athlete ranks higher, since a faster pace at equal distance means more effort per kilometer covered.

## Step 5 — Assigning rank numbers (joint leaders)

Ranks use **standard competition ranking** ("1-2-2-4"), not simple row position. Two or more athletes who are perfectly tied — same `breaks`, same `isPerfect`, same `totalDistance`, **and** same `avgPaceSecPerKm` — share the exact same rank number. The next distinct athlete's rank then resumes at their true position in the list, skipping ranks, rather than continuing sequentially.

Example: if three athletes tie for 1st, they all show `#1`, and the next athlete shows `#4` (not `#2`).

```js
let lastRank = 0, lastBreaks = null, lastPerfect = null, lastDistance = null, lastPace = null;
leaderboard = leaderboard.map((item, idx) => {
  const tied = lastBreaks === item.breaks && lastPerfect === item.isPerfect
    && lastDistance === item.totalDistance && lastPace === item.avgPaceSecPerKm;
  const rank = tied ? lastRank : idx + 1;
  lastRank = rank;
  lastBreaks = item.breaks;
  lastPerfect = item.isPerfect;
  lastDistance = item.totalDistance;
  lastPace = item.avgPaceSecPerKm;
  return { rank, ...item };
});
```

## Worked example

| Athlete | Breaks | Perfect? | Total Distance | Avg Pace | Rank |
|---|---|---|---|---|---|
| A | 0 | ✅ | 150.5 km | 5:30 /km | #1 |
| B | 0 | ✅ | 150.5 km | 5:30 /km | #1 *(tied with A — joint leaders)* |
| C | 0 | ❌ (one short day) | 300 km | 6:10 /km | #3 |
| D | 1 | ❌ | 500 km | 5:00 /km | #4 |
| E | 2 | ❌ | 50 km | 4:45 /km | #5 |
| F | 0 | ✅ | 150.5 km | 6:00 /km | #6 |

Note that **C outranks D and E** despite fewer breaks not applying — C has 0 breaks (Tier 2) vs. D and E's 1+ breaks (Tier 3), regardless of D having far more total distance than C. Consistency (breaks, then Perfect status) always outweighs raw volume. Also note **F ranks below A/B** despite matching them on breaks, Perfect status, and total distance — F's slower 6:00/km pace is the deciding factor, since pace is only reached once everything else ties exactly.

## What the UI shows

The "Status" column on the leaderboard displays one of three labels per athlete, computed client-side in [app.js](public/js/app.js) (`formatLeaderboardStatus`):

| `breaks` / `isPerfect` | Label shown |
|---|---|
| `breaks = 0`, `isPerfect = true` | **Perfect** |
| `breaks = 0`, `isPerfect = false` | **Consistent (Short)** |
| `breaks ≥ 1` | **N Break(s)** |

The "Avg Pace" column shows `avgPaceSecPerKm` formatted as `M:SS /km` (`formatPace` in app.js). Athletes with zero logged distance show a dash (`—`) instead of a pace, since `avgPaceSecPerKm` is `Infinity` for them.

## Known caveats

- **"Today" is the real server clock**, not a fixed event date. If test/seed data is dated in the future relative to the actual server date, that athlete's window hasn't "started" yet and they'll show `breaks = 0, isPerfect = false` regardless of the pattern in their seeded data — this is expected, not a bug, but worth knowing when testing with fabricated dates.
- **`EVENT_START_DATE` is configurable** via environment variable (defaults to `2026-07-26`) — changing it shifts every athlete's window start uniformly, except for athletes whose real earliest activity predates it.
- **Total Distance has no ceiling and no validity filter** — an athlete could pad this number with activities that don't count toward their streak at all (wrong type, short distance, etc.). This is intentional per current design, but is the one place where "junk" activity still influences the leaderboard.
