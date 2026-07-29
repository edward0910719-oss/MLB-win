"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";

/* ============================================================
   DESIGN TOKENS — Ballpark Scoreboard
   bg chalk:  #F5F3EC
   field:     #16342B  (deep outfield green)
   clay:      #A6491F  (infield dirt)
   ink:       #16213A  (scorebook navy)
   bulb:      #F3B62A  (scoreboard amber)
   chalk-line:#DCD8C8
   ============================================================ */

// convert a game's UTC ISO datetime into a Taiwan-time display string
function toTaiwanTime(gameDateIso) {
  const utcInstant = new Date(gameDateIso);
  const dateLabel = utcInstant.toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
  const timeLabel = utcInstant.toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${dateLabel} ${timeLabel}`;
}

// last-refresh timestamp, Taiwan time, down to the second
function toTaiwanClock(iso) {
  return new Date(iso).toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// predictions stop updating once a game is within this many minutes of first pitch
const PREDICTION_LOCK_MINUTES = 5;

function getGameTiming(gameDateIso, status) {
  const startMs = new Date(gameDateIso).getTime();
  const lockMs = startMs - PREDICTION_LOCK_MINUTES * 60 * 1000;
  const isLive = status?.abstract === "Live";
  const isFinal = status?.abstract === "Final";
  const isLocked = !isLive && !isFinal && Date.now() >= lockMs;
  return { isLive, isFinal, isLocked, frozen: isLive || isFinal || isLocked };
}

// once a game enters its prediction-lock window, freeze whatever prediction was showing at
// that moment in localStorage so later refreshes (new pitcher/lineup data, etc.) can't change
// the number retroactively — there is no backend, so the browser's own storage is the only
// place this can live
function getStablePrediction(storageKey, freshPred, shouldFreeze) {
  if (!shouldFreeze || typeof window === "undefined") return freshPred;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) return JSON.parse(stored);
    window.localStorage.setItem(storageKey, JSON.stringify(freshPred));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — just fall through to freshPred
  }
  return freshPred;
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

// ---- color contrast helpers ----
function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}
function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
// if home/away primary colors are too close, swap the away display color to
// whichever of away.color / away.accent contrasts more with home's color
const COLOR_CLASH_THRESHOLD = 90;
function getAwayDisplayColor(home, away) {
  const distPrimary = colorDistance(home.color, away.color);
  if (distPrimary >= COLOR_CLASH_THRESHOLD) return away.color;
  const distAccent = colorDistance(home.color, away.accent);
  return distAccent > distPrimary ? away.accent : away.color;
}

function winPct(t) {
  return t.w / (t.w + t.l);
}
function runDiffPerGame(t) {
  return (t.rs - t.ra) / (t.w + t.l);
}
function last10Pct(t) {
  const [w, l] = t.last10.split("-").map(Number);
  return w / (w + l);
}

// ---- prediction model ----
// weighted logistic blend of: season win%, run-diff/game, starter ERA edge,
// bullpen recent form, recent team form (last10), home-field bump, injury penalty
function predictGame(g, teamMap, leagueAvgEra) {
  const home = teamMap[g.home];
  const away = teamMap[g.away];

  const wWinPct = 0.30;
  const wRunDiff = 0.18;
  const wPitcher = 0.20;
  const wBullpen = 0.10;
  const wForm = 0.12;
  const wHome = 0.06;
  const wLineup = 0.08;

  const winPctEdge = winPct(home) - winPct(away);
  const runDiffEdge = (runDiffPerGame(home) - runDiffPerGame(away)) / 3; // scaled
  const pitcherEdge = (g.ap.era - g.hp.era) / 3; // lower ERA is better, so away-home
  const bullpenEdge = (away.bp10 - home.bp10) / 3; // lower bullpen ERA (last 10) is better
  const formEdge = last10Pct(home) - last10Pct(away);
  const homeBump = 1;

  // ratio of today's actual (or, if unpublished, season-average) lineup OPS to the
  // team's own season OPS — 1.0 means an average lineup, >1 a stronger-than-usual one
  const homeLineupFactor = g.homeLineupOps / (home.ops || g.homeLineupOps);
  const awayLineupFactor = g.awayLineupOps / (away.ops || g.awayLineupOps);
  const lineupEdge = homeLineupFactor - awayLineupFactor;

  const injuryPenaltyHome = home.injuries.length * 0.03;
  const injuryPenaltyAway = away.injuries.length * 0.03;

  let z =
    wWinPct * winPctEdge * 4 +
    wRunDiff * runDiffEdge * 4 +
    wPitcher * pitcherEdge * 4 +
    wBullpen * bullpenEdge * 4 +
    wForm * formEdge * 4 +
    wLineup * lineupEdge * 4 +
    wHome * homeBump -
    injuryPenaltyHome * 4 +
    injuryPenaltyAway * 4;

  const homeProb = 1 / (1 + Math.exp(-z));
  const clamped = Math.min(0.93, Math.max(0.07, homeProb));

  // ---- expected total runs (+-1) ----
  const gamesHome = home.w + home.l;
  const gamesAway = away.w + away.l;
  const homeRunsPerGame = home.rs / gamesHome;
  const awayRunsPerGame = away.rs / gamesAway;
  // batting average adjusted by opposing starter's ERA vs league-average ERA, and by
  // how today's actual lineup compares to the team's usual offensive output
  const homeExpRuns = homeRunsPerGame * (g.ap.era / leagueAvgEra) * homeLineupFactor;
  const awayExpRuns = awayRunsPerGame * (g.hp.era / leagueAvgEra) * awayLineupFactor;
  const totalExpRuns = homeExpRuns + awayExpRuns;

  // ---- probability favored team wins by more than 1 run ----
  const marginMeanHome = homeExpRuns - awayExpRuns; // positive favors home
  const marginStd = Math.sqrt(Math.max(totalExpRuns, 1.5));
  let marginProb;
  if (clamped >= 0.5) {
    // home favored: P(home margin > 1)
    marginProb = 1 - normCdf((1 - marginMeanHome) / marginStd);
  } else {
    // away favored: P(home margin < -1)  == P(away wins by more than 1)
    marginProb = normCdf((-1 - marginMeanHome) / marginStd);
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
      { label: "先發投手 ERA", value: -pitcherEdge, note: `${g.hp.name} ${g.hp.era.toFixed(2)} vs ${g.ap.name} ${g.ap.era.toFixed(2)}` },
      { label: "牛棚近況ERA", value: bullpenEdge, note: `${home.id} ${home.bp10.toFixed(2)} vs ${away.id} ${away.bp10.toFixed(2)}` },
      { label: "近10場戰績", value: formEdge, note: `${home.id} ${home.last10} vs ${away.id} ${away.last10}` },
      {
        label: "打線攻擊力(OPS)",
        value: lineupEdge,
        note: `${home.id} ${g.homeLineupOps.toFixed(3)}${g.homeLineupConfirmed ? "(先發已公布)" : "(球隊平均)"} vs ${away.id} ${g.awayLineupOps.toFixed(3)}${g.awayLineupConfirmed ? "(先發已公布)" : "(球隊平均)"}`,
      },
      { label: "主場優勢", value: homeBump * 0.06, note: "固定加成" },
      { label: "傷兵影響", value: injuryPenaltyAway - injuryPenaltyHome, note: `${home.id}: ${home.injuries.length} 筆 / ${away.id}: ${away.injuries.length} 筆` },
    ],
  };
}

/* ================= UI ================= */

function ScoreDigits({ pct, color }) {
  const val = Math.round(pct * 100);
  return (
    <div className="digits" style={{ color }}>
      {String(val).padStart(2, "0")}
      <span className="pct-sign">%</span>
    </div>
  );
}

function ProbBar({ homeProb, homeColor, awayColor }) {
  const homePct = Math.round(homeProb * 100);
  return (
    <div className="probbar">
      {/* away is always displayed on the left (see TeamTag usage) and home on the right,
          so the bar segments must follow the same order to line up with the team tags */}
      <div className="probbar-fill" style={{ width: `${100 - homePct}%`, background: awayColor }} />
      <div className="probbar-fill" style={{ width: `${homePct}%`, background: homeColor }} />
    </div>
  );
}

function TeamTag({ team, align, isHome, displayColor }) {
  const dotColor = displayColor || team.color;
  return (
    <div className={`team-tag ${align}`}>
      <span className="team-dot" style={{ background: dotColor, boxShadow: `0 0 0 2px ${team.accent} inset` }} />
      <span className="team-main">
        <span className="team-zh">{team.zh}</span>
        <span className="team-role">{isHome ? "（主）" : "（客）"}</span>
      </span>
    </div>
  );
}

function GameCard({ g, onOpen, teamMap }) {
  const home = teamMap[g.home];
  const away = teamMap[g.away];
  const awayColor = getAwayDisplayColor(home, away);
  const favored = g.pred.homeProb >= 0.5 ? home : away;
  const favPct = Math.max(g.pred.homeProb, g.pred.awayProb);

  return (
    <button className="game-card" onClick={() => onOpen(g)}>
      <div className="game-card-top">
        <span className="game-time">🕒 {g.twTime}（台灣時間）</span>
        <span className="game-fav">獨贏 {favored.zh} {Math.round(favPct * 100)}%</span>
      </div>

      {(g.recommended || g.timing.isLive || g.timing.isFinal) && (
        <div className="game-card-badges">
          {g.recommended && <span className="badge badge-recommend">推薦</span>}
          {g.timing.isLive && <span className="badge badge-live">（比賽進行中）</span>}
          {g.timing.isFinal && <span className="badge badge-final">（比賽已結束）</span>}
        </div>
      )}

      <div className="matchup-row">
        <TeamTag team={away} align="left" isHome={false} displayColor={awayColor} />
        <span className="vs">@</span>
        <TeamTag team={home} align="right" isHome={true} />
      </div>

      <div className="pitchers-row">
        <span>{g.ap.name} <em>{g.ap.era.toFixed(2)} ERA</em></span>
        <span className="pitchers-sep">vs</span>
        <span>{g.hp.name} <em>{g.hp.era.toFixed(2)} ERA</em></span>
      </div>

      <ProbBar homeProb={g.pred.homeProb} homeColor={home.color} awayColor={awayColor} />

      <div className="digits-row">
        <ScoreDigits pct={g.pred.awayProb} color={awayColor} />
        <ScoreDigits pct={g.pred.homeProb} color={home.color} />
      </div>

      <div className="extra-preds">
        <span>總分預測 <strong>{Math.round(g.pred.runs.low)}–{Math.round(g.pred.runs.high)}</strong> 分</span>
        <span>{favored.zh} 贏球差距 &gt;1分機率 <strong>{Math.round(g.pred.marginProb * 100)}%</strong></span>
      </div>
    </button>
  );
}

function GameDetail({ g, onClose, teamMap }) {
  const home = teamMap[g.home];
  const away = teamMap[g.away];
  const awayColor = getAwayDisplayColor(home, away);
  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <TeamTag team={away} align="left" isHome={false} displayColor={awayColor} />
          <span className="vs">@</span>
          <TeamTag team={home} align="right" isHome={true} />
          <button className="close-btn" onClick={onClose} aria-label="關閉">✕</button>
        </div>

        <p className="detail-time">🕒 {g.twTime}（台灣時間，原始賽程為美東 {g.time}）</p>

        {(g.recommended || g.timing.isLive || g.timing.isFinal) && (
          <div className="game-card-badges" style={{ marginBottom: "0.8rem" }}>
            {g.recommended && <span className="badge badge-recommend">推薦</span>}
            {g.timing.isLive && <span className="badge badge-live">（比賽進行中）</span>}
            {g.timing.isFinal && <span className="badge badge-final">（比賽已結束）</span>}
          </div>
        )}

        <ProbBar homeProb={g.pred.homeProb} homeColor={home.color} awayColor={awayColor} />
        <div className="digits-row" style={{ marginBottom: "0.8rem" }}>
          <ScoreDigits pct={g.pred.awayProb} color={awayColor} />
          <ScoreDigits pct={g.pred.homeProb} color={home.color} />
        </div>

        <div className="stat-pill-row">
          <span className="stat-pill">
            預測總分 <strong>{Math.round(g.pred.runs.total)}</strong> 分（區間 {Math.round(g.pred.runs.low)}–{Math.round(g.pred.runs.high)}）
          </span>
          <span className="stat-pill">
            {(g.pred.homeProb >= 0.5 ? home.zh : away.zh)} 贏球差距 &gt;1分機率 <strong>{Math.round(g.pred.marginProb * 100)}%</strong>
          </span>
        </div>

        <h4 className="factor-heading">預測因子拆解</h4>
        <div className="factor-list">
          {g.pred.factors.map((f, i) => (
            <div className="factor-row" key={i}>
              <span className="factor-label">{f.label}</span>
              <span className="factor-bar-track">
                <span
                  className="factor-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.abs(f.value) * 220)}%`,
                    marginLeft: f.value < 0 ? "auto" : 0,
                    background: f.value >= 0 ? home.color : awayColor,
                  }}
                />
              </span>
              <span className="factor-note">{f.note}</span>
            </div>
          ))}
        </div>

        {(home.injuries.length > 0 || away.injuries.length > 0) && (
          <div className="injury-box">
            <h4 className="factor-heading">傷兵名單備註</h4>
            {home.injuries.map((t, i) => <p key={"h" + i}>⚠ {home.zh}：{t}</p>)}
            {away.injuries.map((t, i) => <p key={"a" + i}>⚠ {away.zh}：{t}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}

const DIVISION_ORDER = ["AL East", "AL Central", "AL West", "NL East", "NL Central", "NL West"];

function StandingsTable({ teams, query }) {
  const filtered = teams.filter((t) =>
    query
      ? t.name.toLowerCase().includes(query.toLowerCase()) ||
        t.city.toLowerCase().includes(query.toLowerCase()) ||
        t.id.toLowerCase().includes(query.toLowerCase()) ||
        t.zh.includes(query)
      : true
  );

  const presentDivisions = Array.from(new Set(teams.map((t) => t.div)));
  const divisionOrder = [
    ...DIVISION_ORDER.filter((d) => presentDivisions.includes(d)),
    ...presentDivisions.filter((d) => !DIVISION_ORDER.includes(d)),
  ];

  const groups = divisionOrder
    .map((div) => ({
      div,
      teams: filtered.filter((t) => t.div === div).sort((a, b) => winPct(b) - winPct(a)),
    }))
    .filter((g) => g.teams.length > 0);

  if (groups.length === 0) {
    return <p className="muted" style={{ padding: "1.4rem 2rem" }}>找不到符合條件的球隊，換個關鍵字試試。</p>;
  }

  return (
    <div className="standings-wrap">
      {groups.map((g) => (
        <div className="standings-group" key={g.div}>
          <h3 className="standings-div-heading">{g.div}</h3>
          <table className="standings-table">
            <thead>
              <tr>
                <th>球隊</th>
                <th>戰績</th>
                <th>勝率</th>
                <th>得失分差</th>
                <th>近10場</th>
                <th>先發ERA</th>
              </tr>
            </thead>
            <tbody>
              {g.teams.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="team-dot small" style={{ background: t.color, boxShadow: `0 0 0 2px ${t.accent} inset` }} />
                    {t.zh}
                  </td>
                  <td>{t.w}-{t.l}</td>
                  <td className="mono">{(winPct(t) * 100).toFixed(1)}%</td>
                  <td className={t.rs - t.ra >= 0 ? "pos" : "neg"}>{t.rs - t.ra >= 0 ? "+" : ""}{t.rs - t.ra}</td>
                  <td>{t.last10}</td>
                  <td className="mono">{t.era.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export default function MLBWinPredictor() {
  const [view, setView] = useState("games");
  const [query, setQuery] = useState("");
  const [division, setDivision] = useState("all");
  const [openGame, setOpenGame] = useState(null);

  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=IBM+Plex+Mono:wght@500;700&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  const loadGames = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");
    try {
      const res = await fetch("/api/games", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "取得資料失敗");
      setData(json);
      setStatus("ready");
    } catch (err) {
      setErrorMsg(err.message || "取得資料失敗");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    loadGames();
  }, [loadGames]);

  const teams = data?.teams || [];
  const rawGames = data?.games || [];

  const teamMap = useMemo(() => Object.fromEntries(teams.map((t) => [t.id, t])), [teams]);
  const leagueAvgEra = useMemo(
    () => (teams.length ? teams.reduce((s, t) => s + t.era, 0) / teams.length : 4.0),
    [teams]
  );

  const divisions = useMemo(
    () => ["all", ...Array.from(new Set(teams.map((t) => t.div)))],
    [teams]
  );

  const GAMES = useMemo(() => {
    if (!teams.length) return [];
    const withPred = rawGames
      .filter((g) => teamMap[g.home] && teamMap[g.away])
      .map((g) => {
        const timing = getGameTiming(g.gameDateIso, g.status);
        const freshPred = predictGame(g, teamMap, leagueAvgEra);
        const storageKey = `mlbpred:${data?.date}:${g.gamePk}`;
        const pred = getStablePrediction(storageKey, freshPred, timing.frozen);
        return { ...g, twTime: toTaiwanTime(g.gameDateIso), timing, pred, confidence: Math.abs(pred.homeProb - 0.5) };
      });
    const top3 = new Set(
      [...withPred]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3)
        .map((g) => g.gamePk)
    );
    return withPred.map((g) => ({ ...g, recommended: top3.has(g.gamePk) }));
  }, [rawGames, teamMap, leagueAvgEra, data?.date]);

  const filteredGames = useMemo(() => {
    const filtered = GAMES.filter((g) => {
      const home = teamMap[g.home];
      const away = teamMap[g.away];
      const matchesQuery = query
        ? [home, away].some(
            (t) =>
              t.name.toLowerCase().includes(query.toLowerCase()) ||
              t.city.toLowerCase().includes(query.toLowerCase()) ||
              t.id.toLowerCase().includes(query.toLowerCase()) ||
              t.zh.includes(query)
          )
        : true;
      const matchesDiv = division === "all" ? true : home.div === division || away.div === division;
      return matchesQuery && matchesDiv;
    });
    // recommended (top-3 most confident) games lead the list; everything else keeps its original order
    const recommended = filtered.filter((g) => g.recommended).sort((a, b) => b.confidence - a.confidence);
    const rest = filtered.filter((g) => !g.recommended);
    return [...recommended, ...rest];
  }, [GAMES, query, division, teamMap]);

  return (
    <div className="app-root">
      <style>{`
        .app-root {
          --bg: #F5F3EC;
          --field: #16342B;
          --field-light: #1E4638;
          --clay: #A6491F;
          --ink: #16213A;
          --bulb: #F3B62A;
          --line: #DCD8C8;
          --muted: #6B7280;
          font-family: 'Inter', sans-serif;
          background: var(--bg);
          color: var(--ink);
          min-height: 100vh;
          padding: 0 0 3rem 0;
        }
        .app-root * { box-sizing: border-box; }

        .hero {
          background: var(--field);
          background-image:
            repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0 2px, transparent 2px 140px);
          color: #F5F3EC;
          padding: 2.4rem 2rem 2rem;
          border-bottom: 6px solid var(--clay);
          position: relative;
        }
        .hero-eyebrow {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.78rem;
          letter-spacing: 0.18em;
          color: var(--bulb);
          text-transform: uppercase;
          margin: 0 0 0.4rem 0;
        }
        .hero h1 {
          font-family: 'Oswald', sans-serif;
          font-weight: 700;
          font-size: clamp(1.8rem, 4vw, 2.8rem);
          letter-spacing: 0.01em;
          margin: 0 0 0.5rem 0;
          text-transform: uppercase;
        }
        .hero p {
          max-width: 620px;
          color: #D7D9CE;
          line-height: 1.6;
          margin: 0;
          font-size: 0.95rem;
        }
        .hero-refresh {
          margin-top: 1rem;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.78rem;
          background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.3);
          color: #F5F3EC;
          padding: 0.4rem 0.9rem;
          border-radius: 999px;
          cursor: pointer;
        }
        .hero-refresh:hover { background: rgba(255,255,255,0.18); }
        .hero-refresh:disabled { opacity: 0.5; cursor: default; }

        .toolbar {
          display: flex;
          flex-wrap: wrap;
          gap: 0.8rem;
          align-items: center;
          padding: 1.4rem 2rem 0;
          max-width: 1200px;
          margin: 0 auto;
        }
        .tab-group {
          display: flex;
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 4px;
        }
        .tab-btn {
          font-family: 'Oswald', sans-serif;
          font-size: 0.85rem;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          border: none;
          background: transparent;
          color: var(--ink);
          padding: 0.5rem 1.1rem;
          border-radius: 999px;
          cursor: pointer;
        }
        .tab-btn.active {
          background: var(--field);
          color: #fff;
        }
        .search-input {
          flex: 1;
          min-width: 180px;
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 0.55rem 1rem;
          font-size: 0.9rem;
          font-family: 'Inter', sans-serif;
          background: #fff;
        }
        .search-input:focus { outline: 2px solid var(--clay); outline-offset: 1px; }
        .div-select {
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 0.55rem 1rem;
          font-size: 0.85rem;
          background: #fff;
          font-family: 'Inter', sans-serif;
        }

        .games-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 1rem;
          padding: 1.4rem 2rem;
          max-width: 1200px;
          margin: 0 auto;
        }

        .game-card {
          text-align: left;
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 1rem 1.1rem 1.2rem;
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
          font-family: inherit;
        }
        .game-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(22,52,43,0.12);
          border-color: var(--clay);
        }
        .game-card:focus-visible { outline: 2px solid var(--clay); outline-offset: 2px; }

        .game-card-top {
          display: flex;
          justify-content: space-between;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.72rem;
          color: var(--muted);
          margin-bottom: 0.6rem;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .game-card-badges { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.6rem; }
        .badge {
          display: inline-block;
          font-family: 'Oswald', sans-serif;
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          padding: 0.15rem 0.55rem;
          border-radius: 999px;
        }
        .badge-recommend { background: var(--bulb); color: var(--ink); }
        .badge-live { background: #C6011F; color: #fff; }
        .badge-final { background: var(--line); color: var(--muted); }
        .game-fav { color: var(--clay); font-weight: 700; }

        .matchup-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .vs { font-family: 'Oswald', sans-serif; color: var(--muted); font-size: 0.85rem; }

        .team-tag { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
        .team-tag.right { flex-direction: row-reverse; text-align: right; }
        .team-dot { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
        .team-dot.small { display: inline-block; margin-right: 0.4rem; }
        .team-abbr { font-family: 'Oswald', sans-serif; font-weight: 700; font-size: 0.95rem; }
        .team-main { display: flex; align-items: baseline; gap: 0.15rem; min-width: 0; }
        .team-tag.right .team-main { flex-direction: row-reverse; }
        .team-zh { font-family: 'Oswald', sans-serif; font-weight: 700; font-size: 1rem; letter-spacing: 0.02em; white-space: nowrap; }
        .team-role { font-size: 0.72rem; color: var(--muted); white-space: nowrap; }

        .pitchers-row {
          display: flex;
          justify-content: space-between;
          font-size: 0.78rem;
          color: var(--ink);
          margin-bottom: 0.7rem;
          gap: 0.4rem;
        }
        .pitchers-row em { font-style: normal; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
        .pitchers-sep { color: var(--muted); }

        .probbar {
          display: flex;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: var(--line);
          margin-bottom: 0.6rem;
        }
        .probbar-fill { height: 100%; }

        .digits-row { display: flex; justify-content: space-between; }

        .extra-preds {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
          margin-top: 0.7rem;
          padding-top: 0.6rem;
          border-top: 1px dashed var(--line);
          font-size: 0.74rem;
          color: var(--muted);
          font-family: 'IBM Plex Mono', monospace;
        }
        .extra-preds strong { color: var(--ink); }

        .detail-time {
          font-size: 0.78rem;
          color: var(--muted);
          font-family: 'IBM Plex Mono', monospace;
          margin: -0.4rem 0 0.8rem;
        }
        .stat-pill-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-bottom: 0.4rem;
        }
        .stat-pill {
          background: var(--bg);
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 0.4rem 0.8rem;
          font-size: 0.76rem;
          color: var(--muted);
        }
        .stat-pill strong { color: var(--clay); font-family: 'IBM Plex Mono', monospace; }
        .digits {
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 700;
          font-size: 1.6rem;
          display: flex;
          align-items: baseline;
          gap: 2px;
        }
        .pct-sign { font-size: 0.85rem; }

        .detail-overlay {
          position: fixed; inset: 0;
          background: rgba(22,33,58,0.55);
          display: flex; align-items: center; justify-content: center;
          padding: 1.5rem;
          z-index: 50;
        }
        .detail-panel {
          background: #fff;
          border-radius: 16px;
          max-width: 560px;
          width: 100%;
          max-height: 85vh;
          overflow-y: auto;
          padding: 1.6rem 1.6rem 1.8rem;
          border-top: 6px solid var(--clay);
        }
        .detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.6rem;
          margin-bottom: 1rem;
        }
        .close-btn {
          border: none; background: var(--line); border-radius: 50%;
          width: 28px; height: 28px; cursor: pointer; font-size: 0.85rem;
        }

        .factor-heading {
          font-family: 'Oswald', sans-serif;
          text-transform: uppercase;
          font-size: 0.85rem;
          letter-spacing: 0.05em;
          color: var(--muted);
          margin: 1.2rem 0 0.6rem;
        }
        .factor-row {
          display: grid;
          grid-template-columns: 110px 1fr;
          grid-template-rows: auto auto;
          gap: 0.15rem 0.6rem;
          margin-bottom: 0.7rem;
          align-items: center;
        }
        .factor-label { font-size: 0.8rem; font-weight: 600; grid-row: 1 / 3; }
        .factor-bar-track {
          height: 8px;
          background: var(--line);
          border-radius: 999px;
          display: block;
          position: relative;
          overflow: hidden;
        }
        .factor-bar-fill { display: block; height: 100%; border-radius: 999px; }
        .factor-note { font-size: 0.72rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }

        .injury-box p { font-size: 0.82rem; margin: 0.2rem 0; color: var(--clay); }

        .standings-wrap { padding: 1.4rem 2rem; max-width: 1200px; margin: 0 auto; }
        .standings-group { margin-bottom: 1.6rem; overflow-x: auto; }
        .standings-group:last-child { margin-bottom: 0; }
        .standings-div-heading {
          font-family: 'Oswald', sans-serif;
          text-transform: uppercase;
          font-size: 0.9rem;
          letter-spacing: 0.05em;
          color: var(--clay);
          margin: 0 0 0.5rem;
        }
        .standings-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; }
        .standings-table th {
          font-family: 'Oswald', sans-serif;
          text-transform: uppercase;
          font-size: 0.72rem;
          letter-spacing: 0.04em;
          color: #fff;
          background: var(--field);
          padding: 0.6rem 0.8rem;
          text-align: left;
        }
        .standings-table td {
          padding: 0.55rem 0.8rem;
          border-bottom: 1px solid var(--line);
          font-size: 0.85rem;
          white-space: nowrap;
        }
        .standings-table tr:last-child td { border-bottom: none; }
        .muted { color: var(--muted); }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .pos { color: #1B7A43; font-family: 'IBM Plex Mono', monospace; }
        .neg { color: #B3261E; font-family: 'IBM Plex Mono', monospace; }

        .disclaimer {
          max-width: 1200px;
          margin: 0.4rem auto 0;
          padding: 0 2rem;
          font-size: 0.75rem;
          color: var(--muted);
          line-height: 1.6;
        }

        .state-box {
          max-width: 1200px;
          margin: 2rem auto;
          padding: 2rem;
          text-align: center;
          color: var(--muted);
          font-family: 'IBM Plex Mono', monospace;
        }
        .state-box button {
          margin-top: 0.8rem;
          font-family: 'Oswald', sans-serif;
          background: var(--clay);
          color: #fff;
          border: none;
          padding: 0.5rem 1.2rem;
          border-radius: 999px;
          cursor: pointer;
        }

        @media (max-width: 520px) {
          .hero { padding: 1.8rem 1.2rem 1.6rem; }
          .toolbar, .games-grid, .standings-wrap, .disclaimer { padding-left: 1.2rem; padding-right: 1.2rem; }
          .factor-row { grid-template-columns: 90px 1fr; }
        }
      `}</style>

      <div className="hero">
        <p className="hero-eyebrow">MLB Win Probability Board · Live Data</p>
        <h1>MLB賽事勝率預測</h1>
        <p>
          結合球季戰績、得失分差、先發投手 ERA、近況走勢與傷兵名單，即時計算每場比賽的預測勝率。
          點擊任一場比賽可展開因子拆解。
        </p>
        <button className="hero-refresh" onClick={loadGames} disabled={status === "loading"}>
          {status === "loading" ? "更新中…" : `重新整理${data ? `（美東 ${data.date}・更新於 ${toTaiwanClock(data.generatedAt)}）` : ""}`}
        </button>
      </div>

      {status === "loading" && !data && (
        <div className="state-box">正在向 MLB Stats API 取得今日賽程與球隊數據…</div>
      )}

      {status === "error" && (
        <div className="state-box">
          {errorMsg || "取得資料時發生錯誤"}
          <br />
          <button onClick={loadGames}>重試</button>
        </div>
      )}

      {data && (
        <>
          <div className="toolbar">
            <div className="tab-group">
              <button className={`tab-btn ${view === "games" ? "active" : ""}`} onClick={() => setView("games")}>
                今日賽事
              </button>
              <button className={`tab-btn ${view === "standings" ? "active" : ""}`} onClick={() => setView("standings")}>
                戰績排行
              </button>
            </div>
            <input
              className="search-input"
              placeholder="搜尋球隊名稱或縮寫，如 道奇 / LAD"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {view === "games" && (
              <select className="div-select" value={division} onChange={(e) => setDivision(e.target.value)}>
                {divisions.map((d) => (
                  <option key={d} value={d}>{d === "all" ? "全部分區" : d}</option>
                ))}
              </select>
            )}
          </div>

          {view === "games" ? (
            <div className="games-grid">
              {filteredGames.length === 0 && (
                <p className="muted" style={{ gridColumn: "1/-1" }}>
                  {GAMES.length === 0 ? "今天沒有安排 MLB 賽事。" : "找不到符合條件的比賽，換個關鍵字試試。"}
                </p>
              )}
              {filteredGames.map((g) => (
                <GameCard key={g.gamePk} g={g} onOpen={setOpenGame} teamMap={teamMap} />
              ))}
            </div>
          ) : (
            <StandingsTable teams={teams} query={query} />
          )}

          <p className="disclaimer">
            賽程、球隊戰績與先發投手數據即時取自 MLB 官方 Stats API（statsapi.mlb.com），約每 90 秒更新一次；
            牛棚近況以球隊近10日整體投手 ERA 概估，傷兵名單取自 40 人名單狀態。
            預測勝率為本站以上述數據推算的模型結果，僅供參考，非官方數據亦非投注建議。
            Data provided by MLB Advanced Media, L.P.
          </p>

          {openGame && <GameDetail g={openGame} onClose={() => setOpenGame(null)} teamMap={teamMap} />}
        </>
      )}
    </div>
  );
}
