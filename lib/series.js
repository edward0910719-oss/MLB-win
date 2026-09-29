// Postseason series-advancement probability — a second layer on top of the existing
// single-game predictGame(). Combines: (a) already-played games in the series (real
// results, from the schedule API's per-series game list), (b) the next unplayed game if
// it's part of today's already-computed single-game predictions (real starters, full
// model), and (c) any further-out games in the series whose starters aren't announced yet
// (simplified team-strength model, no pitcher/lineup/weather input since none exists yet).
// Home/away for every remaining game — including "if necessary" games — comes straight
// from the schedule API, which already encodes each round's actual format (e.g. Wild Card
// hosted entirely at the higher seed, Division Series 2-2-1), so no format table is
// hardcoded here.

import { winPct } from "./predict.js";

function runDiffPerGame(t) {
  return (t.rs - t.ra) / (t.w + t.l);
}

// Deliberately lighter than predictGame's full weight set — these are hypothetical games
// with no announced starter, no known lineup, no forecast yet, so only the inputs that
// exist regardless of who's pitching are used. wBullpen (recent team ERA) carries a bit
// more of the "pitching strength" load here since there's no starter-specific ERA at all.
const S_WIN_PCT = 0.40;
const S_RUN_DIFF = 0.24;
const S_BULLPEN = 0.14;
const S_INJURY = 0.12;
const S_HOME = 0.06;

export function simplifiedHomeWinProb(home, away) {
  const winPctEdge = winPct(home) - winPct(away);
  const runDiffEdge = (runDiffPerGame(home) - runDiffPerGame(away)) / 3;
  const bullpenEdge = (away.bp10 - home.bp10) / 3;
  const injuryEdge = (away.significantInjuryCount - home.significantInjuryCount) * 0.08;
  const z =
    S_WIN_PCT * winPctEdge * 4 + S_RUN_DIFF * runDiffEdge * 4 + S_BULLPEN * bullpenEdge * 4 + S_INJURY * injuryEdge * 4 + S_HOME;
  const p = 1 / (1 + Math.exp(-z));
  return Math.min(0.93, Math.max(0.07, p));
}

// seriesGames: ordered (by seriesGameNumber) list of every game in the series, each
// { homeAbbr, awayAbbr, status: "Final"|..., homeScore, awayScore, fullPred } — fullPred
// is predictGame()'s output when the game is part of today's already-computed slate,
// otherwise null (falls back to simplifiedHomeWinProb for that game).
export function computeSeriesProbability({ teamAAbbr, teamBAbbr, gamesInSeries, seriesGames, teamMap }) {
  const target = Math.ceil(gamesInSeries / 2);

  let winsA = 0;
  let winsB = 0;
  const upcoming = [];
  for (const sg of seriesGames) {
    if (sg.status === "Final" && sg.homeScore !== null && sg.awayScore !== null) {
      const winnerAbbr = sg.homeScore > sg.awayScore ? sg.homeAbbr : sg.awayAbbr;
      if (winnerAbbr === teamAAbbr) winsA++;
      else if (winnerAbbr === teamBAbbr) winsB++;
      continue;
    }
    upcoming.push(sg);
  }

  // P(team A wins) for each remaining game, converted to a consistent "team A" frame
  // regardless of which side A happens to be home/away for that particular slot
  const pAWinsEach = upcoming.map((sg) => {
    const pHomeWins = sg.fullPred ? sg.fullPred.homeProb : simplifiedHomeWinProb(teamMap[sg.homeAbbr], teamMap[sg.awayAbbr]);
    return sg.homeAbbr === teamAAbbr ? pHomeWins : 1 - pHomeWins;
  });

  function recurse(wa, wb, idx) {
    if (wa >= target) return 1;
    if (wb >= target) return 0;
    if (idx >= pAWinsEach.length) return wa > wb ? 1 : 0; // shouldn't happen once target math is right
    const p = pAWinsEach[idx];
    return p * recurse(wa + 1, wb, idx + 1) + (1 - p) * recurse(wa, wb + 1, idx + 1);
  }

  const probA = recurse(winsA, winsB, 0);
  return { winsA, winsB, target, probA, probB: 1 - probA };
}
