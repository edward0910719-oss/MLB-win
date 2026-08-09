import { neon } from "@neondatabase/serverless";

let sql;
function getSql() {
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

let schemaReady;
// idempotent — safe to call on every request; only actually runs the DDL once per
// warm serverless instance thanks to the cached promise
export function ensureSchema() {
  if (!schemaReady) {
    const sqlTag = getSql();
    schemaReady = sqlTag`
      CREATE TABLE IF NOT EXISTS predictions (
        game_pk INTEGER NOT NULL,
        slate_date DATE NOT NULL,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        home_zh TEXT NOT NULL,
        away_zh TEXT NOT NULL,
        home_prob REAL NOT NULL,
        runs_low REAL NOT NULL,
        runs_high REAL NOT NULL,
        recommended BOOLEAN NOT NULL DEFAULT FALSE,
        pred_json JSONB NOT NULL,
        locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        home_score INTEGER,
        away_score INTEGER,
        win_correct BOOLEAN,
        runs_correct BOOLEAN,
        graded_at TIMESTAMPTZ,
        PRIMARY KEY (game_pk, slate_date)
      )
    `.then(() =>
      // added after the initial release — ALTER so tables created before this exists
      // still get the column. slate_date is the US ET schedule date (used for locking
      // keys); game_date_iso is the real first-pitch instant, used to show which
      // Taiwan calendar day the game actually fell on.
      sqlTag`ALTER TABLE predictions ADD COLUMN IF NOT EXISTS game_date_iso TIMESTAMPTZ`
    ).then(
      () => sqlTag`
        CREATE TABLE IF NOT EXISTS manual_recommendations (
          slate_date DATE NOT NULL,
          game_pk INTEGER NOT NULL,
          PRIMARY KEY (slate_date, game_pk)
        )
      `
    );
  }
  return schemaReady;
}

// Insert the locked-in prediction for a game the first time it's seen past the lock
// threshold. ON CONFLICT DO NOTHING makes this safe to call from concurrent requests —
// whichever request gets there first wins, and that's the snapshot everyone sees after.
export async function lockPrediction(row) {
  const sqlTag = getSql();
  await ensureSchema();
  await sqlTag`
    INSERT INTO predictions (
      game_pk, slate_date, home_team, away_team, home_zh, away_zh,
      home_prob, runs_low, runs_high, recommended, pred_json, game_date_iso
    ) VALUES (
      ${row.gamePk}, ${row.slateDate}, ${row.homeTeam}, ${row.awayTeam}, ${row.homeZh}, ${row.awayZh},
      ${row.homeProb}, ${row.runsLow}, ${row.runsHigh}, ${row.recommended}, ${JSON.stringify(row.pred)}, ${row.gameDateIso}
    )
    ON CONFLICT (game_pk, slate_date) DO NOTHING
  `;
}

export async function getLockedPredictions(gamePks, slateDate) {
  if (gamePks.length === 0) return [];
  const sqlTag = getSql();
  await ensureSchema();
  return sqlTag`
    SELECT * FROM predictions
    WHERE slate_date = ${slateDate} AND game_pk = ANY(${gamePks})
  `;
}

// Records the real outcome once a game goes Final; only fires once per game since a
// later call would just overwrite the same values (graded_at guards against being
// re-run needlessly but isn't load-bearing for correctness).
export async function gradeResult(gamePk, slateDate, homeScore, awayScore, winCorrect, runsCorrect) {
  const sqlTag = getSql();
  await ensureSchema();
  await sqlTag`
    UPDATE predictions
    SET home_score = ${homeScore}, away_score = ${awayScore},
        win_correct = ${winCorrect}, runs_correct = ${runsCorrect}, graded_at = now()
    WHERE game_pk = ${gamePk} AND slate_date = ${slateDate} AND graded_at IS NULL
  `;
}

// Rows still missing a graded result, regardless of slate_date — used to catch up games
// whose slate already flipped away (past the 19:00 Taiwan boundary) before anyone loaded
// the site while that slate was still "current", since normal grading only re-checks
// games belonging to the currently-fetched slate.
export async function getUngradedPredictions() {
  const sqlTag = getSql();
  await ensureSchema();
  return sqlTag`
    SELECT game_pk, slate_date, home_prob, pred_json FROM predictions WHERE graded_at IS NULL
  `;
}

// admin-picked recommended games for a given slate, set via the password-protected panel.
// Consulted whenever a game's "recommended" flag needs deciding — live (not yet locked)
// display and the value baked into predictions.recommended at lock time both read this.
export async function getManualRecommendations(slateDate) {
  const sqlTag = getSql();
  await ensureSchema();
  const rows = await sqlTag`SELECT game_pk FROM manual_recommendations WHERE slate_date = ${slateDate}`;
  return rows.map((r) => r.game_pk);
}

// full replace for the date — whatever was checked in the panel becomes the whole set
export async function setManualRecommendations(slateDate, gamePks) {
  const sqlTag = getSql();
  await ensureSchema();
  await sqlTag`DELETE FROM manual_recommendations WHERE slate_date = ${slateDate}`;
  for (const gamePk of gamePks) {
    await sqlTag`INSERT INTO manual_recommendations (slate_date, game_pk) VALUES (${slateDate}, ${gamePk}) ON CONFLICT DO NOTHING`;
  }
}

// kept for the whole season (regular season + postseason) — nothing prunes this table
// automatically; when a new season starts, clear old rows with a one-off
// `DELETE FROM predictions WHERE slate_date < 'YYYY-MM-DD'`
export async function getAllPredictions() {
  const sqlTag = getSql();
  await ensureSchema();
  return sqlTag`
    SELECT * FROM predictions
    ORDER BY slate_date DESC, locked_at ASC
  `;
}
