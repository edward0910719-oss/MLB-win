// Shared prediction math — used server-side (app/api/games/route.js, to compute and
// persist the locked-in snapshot) and client-side (app/page.js, for the standings tab's
// winPct sort/display). Kept dependency-free (no DB, no fetch) so it works in both places.

export function winPct(t) {
  return t.w / (t.w + t.l);
}

// "推薦" is auto-picked, purely off the model's 獨贏 (moneyline) win probability — any
// game where the favored side clears this threshold counts as recommended. Shared by
// live display (app/api/games/route.js) and the history tab's stats (app/api/history/route.js)
// so a past game is judged by the same rule regardless of when it was locked.
export const RECOMMEND_WIN_PROB_THRESHOLD = 0.7;
export function isRecommended(homeProb) {
  return Math.max(homeProb, 1 - homeProb) >= RECOMMEND_WIN_PROB_THRESHOLD;
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

// z-unit thresholds for how a factor's actual (weighted) pull on the outcome gets
// described in the auto-generated commentary — calibrated against the z contributions
// this model typically produces (a lopsided starter-ERA matchup lands around 0.5, a
// modest one around 0.15), not against the raw factor-bar values shown elsewhere
function magnitudeLabel(absZ) {
  if (absZ >= 0.35) return "大幅領先";
  if (absZ >= 0.15) return "明顯領先";
  if (absZ >= 0.05) return "略占優勢";
  return null;
}

// Plain-language summary of *why* the model landed where it did — ranks each factor by
// its actual weighted contribution to z (not the raw edge shown in the factor bars, which
// don't reflect each factor's weight), and narrates the top few that cleared the
// "worth mentioning" threshold. Deliberately excludes factors that are either constant
// every game (home-field) or display-only with no effect on the model (park/weather/h2h).
function buildCommentary(home, away, homeProb, contributions) {
  const ranked = contributions
    .map((c) => ({ ...c, mag: magnitudeLabel(Math.abs(c.z)) }))
    .filter((c) => c.mag)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 3);

  const homeFavored = homeProb >= 0.5;
  const favored = homeFavored ? home : away;
  const underdog = homeFavored ? away : home;

  if (ranked.length === 0) {
    return `雙方各項數據相當接近，${favored.zh}僅以些微優勢領先，比賽走向不確定性較高。`;
  }

  const forFavored = ranked.filter((c) => c.z > 0 === homeFavored).map((c) => `${c.label}${c.mag}`);
  const forUnderdog = ranked.filter((c) => c.z > 0 !== homeFavored).map((c) => `${c.label}${c.mag}`);

  // rare edge case: the top-ranked factors all point toward the underdog, but smaller
  // factors below the mention threshold (e.g. home-field bump) still tipped the overall
  // call the other way
  if (forFavored.length === 0) {
    return `雖然${forUnderdog.join("、")}對${underdog.zh}較有利，但${favored.zh}仍在其餘因素上小幅領先。`;
  }

  let text = `${favored.zh}主要受惠於${forFavored.join("、")}`;
  if (forUnderdog.length > 0) text += `；不過${forUnderdog.join("、")}對${underdog.zh}較有利，抵銷了部分差距`;
  text += "。";
  return text;
}

// Plain-language summary of the total-runs (O/U) call. Deliberately does NOT claim these
// reasons explain which side of the line (大/小) the prediction landed on — the line is
// `Math.floor(total) + 0.5`, so 大 vs 小 is decided purely by the fractional part of the
// raw total (e.g. a 10.28-run estimate reads as "小10.5" even though 10.28 is itself a
// high total), which has nothing to do with ERA/park/weather. Those inputs explain why
// the total *level* is elevated or suppressed; the line itself is stated as a separate,
// plain fact rather than something the reasons "caused".
function buildOuCommentary(g, home, hpEra, apEra, leagueAvgEra, isOver, line) {
  const reasons = [];
  let levelSign = 0; // net direction the cited reasons point: + more runs, - fewer runs

  const avgStarterEra = (hpEra + apEra) / 2;
  const eraDiff = avgStarterEra - leagueAvgEra; // positive = worse than average -> more runs expected
  if (eraDiff <= -0.4) {
    reasons.push("雙方先發投手ERA都優於聯盟平均");
    levelSign -= 1;
  } else if (eraDiff >= 0.4) {
    reasons.push("雙方先發投手ERA都高於聯盟平均");
    levelSign += 1;
  }

  if (home.parkFactor >= 105) {
    reasons.push(`${home.zh}主場偏向打者有利（球場因素${home.parkFactor}）`);
    levelSign += 1;
  } else if (home.parkFactor <= 95) {
    reasons.push(`${home.zh}主場偏向投手有利（球場因素${home.parkFactor}）`);
    levelSign -= 1;
  }

  // coarse temperature-only heuristic (no wind/humidity) — kept as a secondary note, so
  // only surfaced for genuinely extreme forecasts (~32°C+ / ~10°C-) rather than an
  // ordinary warm day, so it doesn't read as carrying equal weight to starter ERA
  if (g.weatherTempF !== null) {
    if (g.weatherRunFactor >= 1.05) {
      reasons.push("預估氣溫偏高，可能略為有利長打");
      levelSign += 1;
    } else if (g.weatherRunFactor <= 0.95) {
      reasons.push("預估氣溫偏低，可能略為壓低長打");
      levelSign -= 1;
    }
  }

  const dirLabel = isOver ? "大" : "小";
  if (reasons.length === 0) {
    return `雙方先發戰力與球場條件接近聯盟平均，大小分抓在${dirLabel}${line}屬中性判斷。`;
  }
  const levelText = levelSign > 0 ? "預期總分偏高" : levelSign < 0 ? "預期總分偏低" : "多項條件互相牽制，預期總分接近中性";
  return `${levelText}（${reasons.join("；")}），大小分抓在${dirLabel}${line}。`;
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
  // clamped per side (not just the total) so a single wildly-unrepresentative input —
  // e.g. an emergency call-up starter with a 1-inning, 20+ ERA small sample — can't blow
  // the multiplicative formula out to an implausible total (this happened live: a bad
  // probable-pitcher ERA briefly produced a "26.5" run total before the data settled).
  // Mirrors the homeProb clamp above; range is generous (a real single-team MLB total
  // above ~9 is already an outlier) rather than tight, so it's a backstop, not a model input.
  const RUNS_PER_TEAM_MIN = 1.5;
  const RUNS_PER_TEAM_MAX = 9;
  const homeExpRuns = Math.min(
    RUNS_PER_TEAM_MAX,
    Math.max(RUNS_PER_TEAM_MIN, homeRunsPerGame * (g.ap.era / leagueAvgEra) * homeLineupFactor * parkWeatherFactor)
  );
  const awayExpRuns = Math.min(
    RUNS_PER_TEAM_MAX,
    Math.max(RUNS_PER_TEAM_MIN, awayRunsPerGame * (g.hp.era / leagueAvgEra) * awayLineupFactor * parkWeatherFactor)
  );
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

  // same z-unit contributions used inside the `z` sum above, kept separate (rather than
  // read off the factors[] list below) since the factors' `value` is the raw unweighted
  // edge — this is what actually moved the probability, weight included
  const contributions = [
    { label: "球季戰績", z: wWinPct * winPctEdge * 4 },
    { label: "得失分差", z: wRunDiff * runDiffEdge * 4 },
    { label: "先發投手ERA", z: wPitcher * pitcherEdge * 4 },
    { label: "近況投手戰力", z: wBullpen * bullpenEdge * 4 },
    { label: "打線攻擊力(OPS)", z: wLineup * lineupEdge * 4 },
    { label: "重大傷兵影響", z: wInjury * (injuryPenaltyAway - injuryPenaltyHome) * 4 },
    { label: "牛棚疲勞", z: wFatigue * (fatiguePenaltyAway - fatiguePenaltyHome) * 4 },
  ];

  // same line/isOver math as the standalone ouLine() export above, computed inline here
  // since ouLine() takes the already-built pred object as input
  const ouLineValue = Math.floor(totalExpRuns) + 0.5;
  const ouIsOver = totalExpRuns >= ouLineValue;

  return {
    homeProb: clamped,
    awayProb: 1 - clamped,
    commentary: buildCommentary(home, away, clamped, contributions),
    ouCommentary: buildOuCommentary(g, home, g.hp.era, g.ap.era, leagueAvgEra, ouIsOver, ouLineValue),
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
      // informational only — not fed into the model. Same reasoning as the last-10-games
      // exclusion from the win-probability weights above: 10 games is too small a sample
      // to add real predictive signal beyond what's already in the season-long stats
      { label: "近10場戰績", value: 0, note: `${home.id} ${home.last10} vs ${away.id} ${away.last10}` },
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
