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
    schemaReady = getSql()`
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
    `;
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
      home_prob, runs_low, runs_high, recommended, pred_json
    ) VALUES (
      ${row.gamePk}, ${row.slateDate}, ${row.homeTeam}, ${row.awayTeam}, ${row.homeZh}, ${row.awayZh},
      ${row.homeProb}, ${row.runsLow}, ${row.runsHigh}, ${row.recommended}, ${JSON.stringify(row.pred)}
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

export async function getRecentPredictions(days) {
  const sqlTag = getSql();
  await ensureSchema();
  return sqlTag`
    SELECT * FROM predictions
    WHERE slate_date >= (CURRENT_DATE - ${days}::int)
    ORDER BY slate_date DESC, locked_at ASC
  `;
}
