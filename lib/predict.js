// Shared prediction math — used server-side (app/api/games/route.js, to compute and
// persist the locked-in snapshot) and client-side (app/page.js, for the standings tab's
// winPct sort/display). Kept dependency-free (no DB, no fetch) so it works in both places.

export function winPct(t) {
  return t.w / (t.w + t.l);
}

// single over/under line closest to the model's raw total (not the rounded total), so
// e.g. 9.22 -> "小9.5" and 9.7 -> "大9.5". Shared by the display label and by grading
// (app/page.js's getGrade, app/api/games/route.js's win/O-U correctness check) so both
// always agree on the same line.
export function ouLine(pred) {
  const total = pred.runs.total;
  const line = Math.floor(total) + 0.5;
  return { line, isOver: total >= line };
}
function runDiffPerGame(t) {
  return (t.rs - t.ra) / (t.w + t.l);
}

// standard normal CDF via Abramowitz-Stegun erf approximation
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

// ---- prediction model ----
// weighted logistic blend of: season win%, run-diff/game, starter ERA edge,
// recent team pitching form, lineup strength, home-field bump, and penalties for
// significant injuries / a fatigued bullpen.
//
// Deliberately NOT included: last-10-games win/loss record. It's one of the more
// well-known false signals in sports analytics — 10 games is too small a sample to add
// information beyond what's already in the season-long stats, so it was dropped rather
// than left in as noise.
export function predictGame(g, teamMap, leagueAvgEra) {
  const home = teamMap[g.home];
  const away = teamMap[g.away];

  const wWinPct = 0.38;
  const wRunDiff = 0.22;
  const wPitcher = 0.20;
  const wBullpen = 0.10;
  const wHome = 0.06;
  const wLineup = 0.08;
  const wInjury = 0.10;
  // narrower and shorter-lived than wBullpen/wInjury — hits only the 3-5 relievers who
  // actually pitched extra frames, and usually resolves within a day or two via rest, a
  // fresh call-up, or simply not needing the pen if tonight's starter goes deep
  const wFatigue = 0.05;

  const winPctEdge = winPct(home) - winPct(away);
  const runDiffEdge = (runDiffPerGame(home) - runDiffPerGame(away)) / 3; // scaled
  const pitcherEdge = (g.ap.era - g.hp.era) / 3; // lower ERA is better, so away-home
  const bullpenEdge = (away.bp10 - home.bp10) / 3; // lower recent team ERA is better
  const homeBump = 1;

  // ratio of today's actual (or, if unpublished, season-average) lineup OPS to the
  // team's own season OPS — 1.0 means an average lineup, >1 a stronger-than-usual one
  const homeLineupFactor = g.homeLineupOps / (home.ops || g.homeLineupOps);
  const awayLineupFactor = g.awayLineupOps / (away.ops || g.awayLineupOps);
  const lineupEdge = homeLineupFactor - awayLineupFactor;

  // only rotation-caliber pitchers (>=5 starts this season) and regular position players
  // (>=150 plate appearances) count here — a stack of minor/bench IL stints shouldn't be
  // penalized the same as losing an actual starter
  const injuryPenaltyHome = home.significantInjuryCount * 0.08;
  const injuryPenaltyAway = away.significantInjuryCount * 0.08;

  // a bullpen that threw extra innings within the last 2 days is a flat fragility penalty
  const fatiguePenaltyHome = g.homeBullpenFatigued ? 0.15 : 0;
  const fatiguePenaltyAway = g.awayBullpenFatigued ? 0.15 : 0;

  let z =
    wWinPct * winPctEdge * 4 +
    wRunDiff * runDiffEdge * 4 +
    wPitcher * pitcherEdge * 4 +
    wBullpen * bullpenEdge * 4 +
    wLineup * lineupEdge * 4 +
    wHome * homeBump +
    wInjury * (injuryPenaltyAway - injuryPenaltyHome) * 4 +
    wFatigue * (fatiguePenaltyAway - fatiguePenaltyHome) * 4;

  const homeProb = 1 / (1 + Math.exp(-z));
  const clamped = Math.min(0.93, Math.max(0.07, homeProb));

  // ---- expected total runs (+-1) ----
  const gamesHome = home.w + home.l;
  const gamesAway = away.w + away.l;
  const homeRunsPerGame = home.rs / gamesHome;
  const awayRunsPerGame = away.rs / gamesAway;
  // batting average adjusted by opposing starter's ERA vs league-average ERA, by how
  // today's actual lineup compares to the team's usual offensive output, and by the
  // home park's run environment and forecast temperature (both apply to both teams,
  // since they're playing in the same park under the same sky)
  const parkWeatherFactor = (home.parkFactor / 100) * g.weatherRunFactor;
  const homeExpRuns = homeRunsPerGame * (g.ap.era / leagueAvgEra) * homeLineupFactor * parkWeatherFactor;
  const awayExpRuns = awayRunsPerGame * (g.hp.era / leagueAvgEra) * awayLineupFactor * parkWeatherFactor;
  const totalExpRuns = homeExpRuns + awayExpRuns;

  // ---- probability favored team wins by more than the MLB run-line's usual 1.5 runs ----
  const MARGIN_THRESHOLD = 1.5;
  const marginMeanHome = homeExpRuns - awayExpRuns; // positive favors home
  const marginStd = Math.sqrt(Math.max(totalExpRuns, 1.5));
  let marginProb;
  if (clamped >= 0.5) {
    // home favored: P(home margin > 1.5)
    marginProb = 1 - normCdf((MARGIN_THRESHOLD - marginMeanHome) / marginStd);
  } else {
    // away favored: P(home margin < -1.5)  == P(away wins by more than 1.5)
    marginProb = normCdf((-MARGIN_THRESHOLD - marginMeanHome) / marginStd);
  }
  marginProb = Math.min(0.95, Math.max(0.05, marginProb));

  return {
    homeProb: clamped,
    awayProb: 1 - clamped,
    runs: {
      home: homeExpRuns,
      away: awayExpRuns,
      total: totalExpRuns,
      low: Math.max(0, totalExpRuns - 1),
      high: totalExpRuns + 1,
    },
    marginProb,
    factors: [
      { label: "球季戰績", value: winPctEdge, note: `${home.id} ${(winPct(home) * 100).toFixed(1)}% vs ${away.id} ${(winPct(away) * 100).toFixed(1)}%` },
      { label: "得失分差/場", value: runDiffEdge, note: `${runDiffPerGame(home).toFixed(2)} vs ${runDiffPerGame(away).toFixed(2)}` },
      { label: "先發投手 ERA", value: pitcherEdge, note: `${home.id} ${g.hp.name} ${g.hp.era.toFixed(2)} vs ${away.id} ${g.ap.name} ${g.ap.era.toFixed(2)}` },
      { label: "近況投手戰力(ERA)", value: bullpenEdge, note: `${home.id} ${home.bp10.toFixed(2)} vs ${away.id} ${away.bp10.toFixed(2)}（近10日球隊整體，非純牛棚）` },
      {
        label: "打線攻擊力(OPS)",
        value: lineupEdge,
        note: `${home.id} ${g.homeLineupOps.toFixed(3)}${g.homeLineupConfirmed ? "(先發近10場)" : "(近10天平均)"} vs ${away.id} ${g.awayLineupOps.toFixed(3)}${g.awayLineupConfirmed ? "(先發近10場)" : "(近10天平均)"}`,
      },
      { label: "主場優勢", value: homeBump * 0.06, note: "固定加成" },
      {
        label: "重大傷兵影響",
        value: injuryPenaltyAway - injuryPenaltyHome,
        note: `${home.id}: ${home.significantInjuryCount} 筆重大 / ${home.injuries.length} 筆總計・${away.id}: ${away.significantInjuryCount} 筆重大 / ${away.injuries.length} 筆總計`,
      },
      {
        label: "牛棚疲勞",
        value: fatiguePenaltyAway - fatiguePenaltyHome,
        note:
          g.homeBullpenFatigued || g.awayBullpenFatigued
            ? `${g.homeBullpenFatigued ? home.id + " 近2日曾打延長賽" : home.id + " 正常"} / ${g.awayBullpenFatigued ? away.id + " 近2日曾打延長賽" : away.id + " 正常"}`
            : "雙方近2日皆無延長賽",
      },
      // park + weather affect the run environment for both teams equally (they influence
      // the total-runs number, not who's favored), so they're shown here with no lean
      { label: "球場因素", value: 0, note: `${home.id} 主場 ${home.parkFactor}（100為中性，數字越高對打者越有利）` },
      {
        label: "預估氣溫",
        value: 0,
        note: g.weatherTempF !== null ? `${Math.round(((g.weatherTempF - 32) * 5) / 9)}°C` : "室內球場或無預報資料",
      },
      // informational only — not fed into the model (see route.js comment: with MLB's
      // unbalanced schedule most pairs only meet 2-6 times this season, too small a
      // sample to have real predictive value)
      {
        label: "本季交手戰績",
        value: 0,
        note:
          g.h2h.homeWins + g.h2h.awayWins > 0
            ? `${home.id} ${g.h2h.homeWins}勝 - ${away.id} ${g.h2h.awayWins}勝（本季，僅供參考）`
            : "本季尚未交手",
      },
    ],
  };
}
