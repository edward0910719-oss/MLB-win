"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { winPct, ouLine } from "@/lib/predict";

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

const INNING_HALF_ZH = { Top: "上", Bottom: "下", Middle: "中", End: "末" };

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

// grades the (locked-in) prediction against the real final score once a game is over —
// null fields mean "not graded yet" (game isn't final, or the score hasn't come back)
function getGrade(g) {
  if (!g.timing.isFinal || g.homeScore === null || g.awayScore === null) {
    return { winCorrect: null, runsCorrect: null, actualTotal: null };
  }
  const predictedHomeWin = g.pred.homeProb >= 0.5;
  const actualHomeWin = g.homeScore > g.awayScore;
  const actualTotal = g.homeScore + g.awayScore;
  const { line, isOver } = ouLine(g.pred);
  return {
    winCorrect: predictedHomeWin === actualHomeWin,
    runsCorrect: isOver ? actualTotal > line : actualTotal < line,
    actualTotal,
  };
}

// single betting-board-style O/U label, e.g. "大9.5" or "小9.5"
function ouLabel(pred) {
  const { line, isOver } = ouLine(pred);
  return `${isOver ? "大" : "小"}${line}`;
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

function GradeMark({ correct }) {
  if (correct === null) return null;
  return correct ? (
    <span className="grade-mark grade-correct" aria-label="預測正確">✓</span>
  ) : (
    <span className="grade-mark grade-wrong" aria-label="預測錯誤">✗</span>
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

// scoreboard-style matchup shown only while a game is live: team name + big centered
// score, inning in the middle, and whichever of "打者"/"投手" applies to each side
function formatAtBatLabel(atBat, isBatting) {
  if (isBatting) {
    const extras = [];
    if (atBat.battingOrder) extras.push(`${atBat.battingOrder}棒`);
    if (atBat.batterAvg) extras.push(atBat.batterAvg);
    return `打者 ${atBat.batter}${extras.length ? `（${extras.join(" ")}）` : ""}`;
  }
  return `投手 ${atBat.pitcher}${atBat.pitcherEra ? `（${atBat.pitcherEra} ERA）` : ""}`;
}

function BaseDiamond({ bases }) {
  return (
    <div className="base-diamond">
      <span className={`base-marker base-2${bases.second ? " on" : ""}`} />
      <span className={`base-marker base-3${bases.third ? " on" : ""}`} />
      <span className={`base-marker base-1${bases.first ? " on" : ""}`} />
    </div>
  );
}

function LiveMatchup({ g, home, away, awayColor }) {
  const half = INNING_HALF_ZH[g.liveInning?.half] || "";
  const awayLabel =
    g.liveAtBat?.battingSide === "away"
      ? formatAtBatLabel(g.liveAtBat, true)
      : g.liveAtBat?.battingSide === "home"
        ? formatAtBatLabel(g.liveAtBat, false)
        : null;
  const homeLabel =
    g.liveAtBat?.battingSide === "home"
      ? formatAtBatLabel(g.liveAtBat, true)
      : g.liveAtBat?.battingSide === "away"
        ? formatAtBatLabel(g.liveAtBat, false)
        : null;

  return (
    <div className="live-matchup">
      <div className="live-team">
        <div className="live-team-name">
          <span className="team-dot" style={{ background: awayColor, boxShadow: `0 0 0 2px ${away.accent} inset` }} />
          <span className="team-zh">{away.zh}<span className="team-role">（客）</span></span>
        </div>
        <div className="live-score" style={{ color: awayColor }}>{g.awayScore ?? "-"}</div>
        {awayLabel && <div className="live-atbat">{awayLabel}</div>}
      </div>
      <div className="live-inning">
        {g.timing.isFinal ? (
          <div className="live-inning-num">比賽結束</div>
        ) : (
          <>
            {g.liveInning && <div className="live-inning-num">{g.liveInning.number}局{half}</div>}
            {g.liveAtBat && (
              <>
                <BaseDiamond bases={g.liveAtBat.bases} />
                <div className="live-count">
                  {g.liveAtBat.balls}-{g.liveAtBat.strikes}・{g.liveAtBat.outs}出局
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="live-team">
        <div className="live-team-name">
          <span className="team-zh"><span className="team-role">（主）</span>{home.zh}</span>
          <span className="team-dot" style={{ background: home.color, boxShadow: `0 0 0 2px ${home.accent} inset` }} />
        </div>
        <div className="live-score" style={{ color: home.color }}>{g.homeScore ?? "-"}</div>
        {homeLabel && <div className="live-atbat">{homeLabel}</div>}
      </div>
    </div>
  );
}

function GameCard({ g, onOpen, teamMap, isAdmin, isSelected, onToggleSelect }) {
  const home = teamMap[g.home];
  const away = teamMap[g.away];
  const awayColor = getAwayDisplayColor(home, away);
  const favored = g.pred.homeProb >= 0.5 ? home : away;
  const favPct = Math.max(g.pred.homeProb, g.pred.awayProb);
  const grade = getGrade(g);
  const canSelect = isAdmin && !g.timing.isLive && !g.timing.isFinal;

  return (
    <div className="game-card-wrapper">
      {canSelect && (
        <label className="game-card-checkbox" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(g.gamePk)} />
        </label>
      )}
      <button className="game-card" onClick={() => onOpen(g)}>
      <div className="game-card-top">
        <span className="game-time">🕒 {g.twTime}（台灣時間）</span>
      </div>

      {(g.recommended || g.timing.isLive || g.timing.isFinal) && (
        <div className="game-card-badges">
          {g.recommended && <span className="badge badge-recommend">推薦</span>}
          {g.timing.isLive && <span className="badge badge-live">（比賽進行中）</span>}
          {g.timing.isFinal && <span className="badge badge-final">（比賽已結束）</span>}
        </div>
      )}

      {g.timing.isLive || g.timing.isFinal ? (
        <LiveMatchup g={g} home={home} away={away} awayColor={awayColor} />
      ) : (
        <>
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
        </>
      )}

      <ProbBar homeProb={g.pred.homeProb} homeColor={home.color} awayColor={awayColor} />

      <div className="digits-row">
        <ScoreDigits pct={g.pred.awayProb} color={awayColor} />
        <ScoreDigits pct={g.pred.homeProb} color={home.color} />
      </div>

      <div className="extra-preds">
        <span className="game-fav">
          獨贏 {favored.zh} {Math.round(favPct * 100)}% <GradeMark correct={grade.winCorrect} />
        </span>
        <span>
          總分預測 <strong>{ouLabel(g.pred)}</strong> <GradeMark correct={grade.runsCorrect} />
        </span>
        <span>{favored.zh} 贏球差距 &gt;1.5分機率 <strong>{Math.round(g.pred.marginProb * 100)}%</strong></span>
      </div>
      </button>
    </div>
  );
}

// reference-only display: pitch counts don't get "worse" beyond casual reading past a
// normal 3-day workload, so the bar scale caps at a fixed 30 pitches rather than scaling
// to whoever happens to be the busiest arm shown
const BULLPEN_BAR_MAX_PITCHES = 30;

function BullpenColumn({ team, list, color }) {
  return (
    <div className="bullpen-col">
      <p className="bullpen-col-heading">{team.zh}</p>
      {list.length === 0 && <p className="bullpen-empty">近3日無出賽紀錄</p>}
      {list.map((p, i) => {
        const pct = Math.min(100, (p.pitches / BULLPEN_BAR_MAX_PITCHES) * 100);
        return (
          <div className="bullpen-row" key={i}>
            <span className="bullpen-name">{p.hand ? `(${p.hand}) ` : ""}{p.name}</span>
            <span className="bullpen-bar-track">
              <span className="bullpen-bar-fill" style={{ width: `${pct}%`, background: color }} />
            </span>
            <span className="bullpen-pitches">{p.pitches}</span>
          </div>
        );
      })}
    </div>
  );
}

function GameDetail({ g, onClose, teamMap }) {
  const home = teamMap[g.home];
  const away = teamMap[g.away];
  const awayColor = getAwayDisplayColor(home, away);
  const grade = getGrade(g);
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

        {(g.timing.isLive || g.timing.isFinal) && <LiveMatchup g={g} home={home} away={away} awayColor={awayColor} />}

        <ProbBar homeProb={g.pred.homeProb} homeColor={home.color} awayColor={awayColor} />
        <div className="digits-row" style={{ marginBottom: "0.8rem" }}>
          <ScoreDigits pct={g.pred.awayProb} color={awayColor} />
          <ScoreDigits pct={g.pred.homeProb} color={home.color} />
        </div>

        <div className="stat-pill-row">
          <span className="stat-pill">
            總分預測 <strong>{ouLabel(g.pred)}</strong> <GradeMark correct={grade.runsCorrect} />
          </span>
          <span className="stat-pill">
            {(g.pred.homeProb >= 0.5 ? home.zh : away.zh)} 贏球差距 &gt;1.5分機率 <strong>{Math.round(g.pred.marginProb * 100)}%</strong> <GradeMark correct={grade.winCorrect} />
          </span>
        </div>

        {g.pred.commentary && <p className="commentary-note">{g.pred.commentary}</p>}
        {g.pred.ouCommentary && <p className="commentary-note">{g.pred.ouCommentary}</p>}

        <h4 className="factor-heading">預測因子拆解</h4>
        <div className="factor-list">
          {g.pred.factors.map((f, i) => {
            // full-width, two-segment bar (away left, home right) — same left/right
            // convention as the win-probability bar above, so a longer segment on either
            // side reads the same way in both places
            const homePct = Math.min(100, Math.max(0, 50 + f.value * 110));
            return (
              <div className="factor-row" key={i}>
                <span className="factor-label">{f.label}</span>
                <span className="factor-bar-track">
                  <span className="factor-bar-fill" style={{ width: `${100 - homePct}%`, background: awayColor }} />
                  <span className="factor-bar-fill" style={{ width: `${homePct}%`, background: home.color }} />
                </span>
                <span className="factor-note">{f.note}</span>
              </div>
            );
          })}
        </div>

        {g.bullpen && (g.bullpen.home.length > 0 || g.bullpen.away.length > 0) && (
          <div className="bullpen-box">
            <h4 className="factor-heading">牛棚可用性（近3日用球數，僅供參考）</h4>
            <div className="bullpen-columns">
              <BullpenColumn team={away} list={g.bullpen.away} color={awayColor} />
              <BullpenColumn team={home} list={g.bullpen.home} color={home.color} />
            </div>
          </div>
        )}

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

function pctLabel(rate, total) {
  if (total === 0) return "—";
  return `${Math.round(rate * 100)}%`;
}

function HistoryGameRow({ g }) {
  const favoredZh = g.pred.homeProb >= 0.5 ? g.homeZh : g.awayZh;
  const favPct = Math.round(Math.max(g.pred.homeProb, g.pred.awayProb) * 100);
  const { line, isOver } = ouLine(g.pred);
  return (
    <div className="history-game-row">
      <span className="history-game-matchup">
        {g.recommended && <span className="badge badge-recommend" style={{ marginRight: "0.4rem" }}>推薦</span>}
        {g.awayZh} @ {g.homeZh}
      </span>
      <span>獨贏 {favoredZh} {favPct}% <GradeMark correct={g.winCorrect} /></span>
      <span>大小分 {isOver ? "大" : "小"}{line} <GradeMark correct={g.runsCorrect} /></span>
      <span className="muted">{g.awayScore !== null ? `終場 ${g.awayScore}:${g.homeScore}` : "尚未完賽"}</span>
    </div>
  );
}

function HistoryTable({ data, status }) {
  const [expandedDate, setExpandedDate] = useState(null);

  if (status === "loading" || status === "idle") {
    return <p className="muted" style={{ padding: "1.4rem 2rem" }}>正在讀取本季的預測紀錄…</p>;
  }
  if (status === "error") {
    return <p className="muted" style={{ padding: "1.4rem 2rem" }}>讀取歷史預測資料失敗，請稍後再試。</p>;
  }
  if (!data || data.days.length === 0) {
    return <p className="muted" style={{ padding: "1.4rem 2rem" }}>還沒有已鎖定並完賽的比賽紀錄。</p>;
  }

  return (
    <div className="standings-wrap">
      <p className="muted" style={{ fontSize: "0.78rem", margin: "0 0 0.6rem" }}>點擊日期可展開查看當天賽事結果</p>
      <div className="standings-group">
        <table className="standings-table history-table">
          <thead>
            <tr>
              <th>比賽日</th>
              <th>獨贏預測場次</th>
              <th>獨贏正確</th>
              <th>獨贏成功率</th>
              <th>大小分預測場次</th>
              <th>大小分正確</th>
              <th>大小分成功率</th>
              <th>推薦場次</th>
              <th>推薦正確</th>
              <th>推薦成功率</th>
            </tr>
          </thead>
          <tbody>
            <tr className="history-totals-row">
              <td className="mono">本季累計</td>
              <td>{data.totals.winTotal}</td>
              <td>{data.totals.winCorrect}</td>
              <td className="mono">{pctLabel(data.totals.winRate, data.totals.winTotal)}</td>
              <td>{data.totals.runsTotal}</td>
              <td>{data.totals.runsCorrect}</td>
              <td className="mono">{pctLabel(data.totals.runsRate, data.totals.runsTotal)}</td>
              <td>{data.totals.recTotal}</td>
              <td>{data.totals.recCorrect}</td>
              <td className="mono">{pctLabel(data.totals.recRate, data.totals.recTotal)}</td>
            </tr>
            {data.days.map((d) => (
              <React.Fragment key={d.date}>
                <tr className="history-date-row" onClick={() => setExpandedDate(expandedDate === d.date ? null : d.date)}>
                  <td className="mono">{expandedDate === d.date ? "▾ " : "▸ "}{d.date}</td>
                  <td>{d.winTotal}</td>
                  <td>{d.winCorrect}</td>
                  <td className="mono">{pctLabel(d.winRate, d.winTotal)}</td>
                  <td>{d.runsTotal}</td>
                  <td>{d.runsCorrect}</td>
                  <td className="mono">{pctLabel(d.runsRate, d.runsTotal)}</td>
                  <td>{d.recTotal}</td>
                  <td>{d.recCorrect}</td>
                  <td className="mono">{pctLabel(d.recRate, d.recTotal)}</td>
                </tr>
                {expandedDate === d.date && (
                  <tr>
                    <td colSpan={10} style={{ padding: 0 }}>
                      <div className="history-game-list">
                        {d.games.map((g) => (
                          <HistoryGameRow key={g.gamePk} g={g} />
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
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

  const [historyData, setHistoryData] = useState(null);
  const [historyStatus, setHistoryStatus] = useState("idle"); // idle | loading | ready | error

  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminLoginError, setAdminLoginError] = useState("");
  const [selectedGamePks, setSelectedGamePks] = useState(new Set());
  const [saveRecStatus, setSaveRecStatus] = useState("idle"); // idle | saving | saved | error

  useEffect(() => {
    fetch("/api/admin/login")
      .then((res) => res.json())
      .then((json) => setIsAdmin(Boolean(json.authenticated)))
      .catch(() => {});
  }, []);

  const handleAdminLogin = useCallback(async () => {
    setAdminLoginError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "登入失敗");
      setIsAdmin(true);
      setShowAdminLogin(false);
      setAdminPassword("");
    } catch (err) {
      setAdminLoginError(err.message || "登入失敗");
    }
  }, [adminPassword]);

  const handleAdminLogout = useCallback(async () => {
    await fetch("/api/admin/login", { method: "DELETE" }).catch(() => {});
    setIsAdmin(false);
  }, []);

  const toggleGamePk = useCallback((gamePk) => {
    setSelectedGamePks((prev) => {
      const next = new Set(prev);
      if (next.has(gamePk)) next.delete(gamePk);
      else next.add(gamePk);
      return next;
    });
  }, []);

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

  useEffect(() => {
    if (view !== "history" || historyStatus !== "idle") return;
    setHistoryStatus("loading");
    fetch("/api/history")
      .then((res) => res.json().then((json) => ({ ok: res.ok, json })))
      .then(({ ok, json }) => {
        if (!ok) throw new Error(json.error || "取得歷史資料失敗");
        setHistoryData(json);
        setHistoryStatus("ready");
      })
      .catch(() => setHistoryStatus("error"));
  }, [view, historyStatus]);

  const teams = data?.teams || [];
  const rawGames = data?.games || [];

  const teamMap = useMemo(() => Object.fromEntries(teams.map((t) => [t.id, t])), [teams]);

  const divisions = useMemo(
    () => ["all", ...Array.from(new Set(teams.map((t) => t.div)))],
    [teams]
  );

  // pred, recommended, and the lock/grade state are all computed and persisted
  // server-side (app/api/games/route.js) so every visitor sees the same numbers —
  // this just adds the display-only bits
  const GAMES = useMemo(() => {
    if (!teams.length) return [];
    return rawGames
      .filter((g) => teamMap[g.home] && teamMap[g.away])
      .map((g) => ({
        ...g,
        twTime: toTaiwanTime(g.gameDateIso),
        timing: { isLive: g.status.abstract === "Live", isFinal: g.status.abstract === "Final" },
      }));
  }, [rawGames, teamMap]);

  useEffect(() => {
    if (isAdmin && GAMES.length) {
      setSelectedGamePks(new Set(GAMES.filter((g) => g.recommended).map((g) => g.gamePk)));
    }
  }, [isAdmin, GAMES]);

  const handleSaveRecommendations = useCallback(async () => {
    setSaveRecStatus("saving");
    try {
      const res = await fetch("/api/admin/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slateDate: data?.date, gamePks: [...selectedGamePks] }),
      });
      if (!res.ok) throw new Error();
      setSaveRecStatus("saved");
      loadGames();
    } catch {
      setSaveRecStatus("error");
    }
  }, [data?.date, selectedGamePks, loadGames]);

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
    // all games sorted by start time; "推薦" is now just a badge, not a sort key
    return [...filtered].sort((a, b) => new Date(a.gameDateIso) - new Date(b.gameDateIso));
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
        .hero-admin-link {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.72rem;
          background: transparent;
          border: 1px solid rgba(255,255,255,0.2);
          color: #D7D9CE;
          padding: 0.4rem 0.8rem;
          border-radius: 999px;
          cursor: pointer;
        }
        .hero-admin-link:hover { background: rgba(255,255,255,0.1); }
        .admin-login-box { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.7rem; }
        .admin-login-input {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.78rem;
          padding: 0.4rem 0.7rem;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.3);
          background: rgba(255,255,255,0.1);
          color: #F5F3EC;
        }
        .admin-login-input::placeholder { color: #A9AC9E; }
        .admin-login-error { font-size: 0.74rem; color: var(--bulb); }

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

        .game-card-wrapper { position: relative; }
        .game-card-wrapper .game-card { display: block; width: 100%; }
        .game-card-checkbox {
          position: absolute;
          top: 0.7rem;
          right: 0.7rem;
          z-index: 2;
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 0.2rem;
          display: flex;
          cursor: pointer;
        }
        .game-card-checkbox input { width: 18px; height: 18px; cursor: pointer; margin: 0; }

        .admin-rec-toolbar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.7rem;
          padding: 0.6rem 2rem;
          max-width: 1200px;
          margin: 0 auto;
          font-size: 0.82rem;
          color: var(--muted);
        }
        .admin-save-ok { color: #1B7A43; font-weight: 700; }

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

        .grade-mark { font-weight: 700; margin-left: 0.15rem; }
        .grade-correct { color: #1B7A43; }
        .grade-wrong { color: #B3261E; }

        .matchup-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .vs { font-family: 'Oswald', sans-serif; color: var(--muted); font-size: 0.85rem; }

        .live-matchup {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: start;
          gap: 0.5rem;
          margin-bottom: 0.7rem;
        }
        .live-team { text-align: center; min-width: 0; }
        .live-team-name { display: flex; align-items: center; justify-content: center; gap: 0.4rem; margin-bottom: 0.3rem; }
        .live-score { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 2.4rem; line-height: 1; }
        .live-atbat { font-size: 0.68rem; color: var(--muted); margin-top: 0.3rem; }
        .live-inning { text-align: center; padding: 1.6rem 0.4rem 0; }
        .live-inning-num { font-family: 'Oswald', sans-serif; font-weight: 700; font-size: 0.95rem; color: var(--ink); white-space: nowrap; }

        .base-diamond { position: relative; width: 22px; height: 22px; margin: 0.5rem auto 0; }
        .base-marker {
          position: absolute;
          width: 8px;
          height: 8px;
          background: var(--line);
          border: 1px solid var(--muted);
          transform: rotate(45deg);
        }
        .base-marker.on { background: var(--clay); border-color: var(--clay); }
        .base-2 { top: 0; left: 50%; margin-left: -4px; }
        .base-3 { top: 50%; left: 0; margin-top: -4px; }
        .base-1 { top: 50%; right: 0; margin-top: -4px; }
        .live-count { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: var(--muted); margin-top: 0.35rem; white-space: nowrap; }

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

        .commentary-note {
          font-size: 0.82rem;
          line-height: 1.55;
          color: var(--ink);
          background: var(--line);
          border-left: 3px solid var(--clay);
          border-radius: 6px;
          padding: 0.6rem 0.8rem;
          margin: 0.9rem 0 0.4rem;
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
          display: flex;
          overflow: hidden;
        }
        .factor-bar-fill { display: block; height: 100%; }
        .factor-note { font-size: 0.72rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }

        .injury-box p { font-size: 0.82rem; margin: 0.2rem 0; color: var(--clay); }

        .bullpen-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1.2rem; }
        .bullpen-col-heading { font-size: 0.8rem; font-weight: 700; margin: 0 0 0.4rem; }
        .bullpen-row { display: grid; grid-template-columns: 78px 1fr 24px; align-items: center; gap: 0.4rem; margin-bottom: 0.35rem; }
        .bullpen-name { font-size: 0.7rem; font-family: 'IBM Plex Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bullpen-bar-track { height: 6px; background: var(--line); border-radius: 999px; overflow: hidden; }
        .bullpen-bar-fill { display: block; height: 100%; }
        .bullpen-pitches { font-size: 0.72rem; font-family: 'IBM Plex Mono', monospace; text-align: right; color: var(--muted); }
        .bullpen-empty { font-size: 0.72rem; color: var(--muted); }

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
        .history-date-row { cursor: pointer; }
        .history-date-row:hover { background: var(--bg); }
        .history-totals-row { background: var(--field); color: #fff; font-weight: 700; }
        .history-totals-row td { border-bottom: none; }
        .history-table th:nth-child(4),
        .history-table td:nth-child(4),
        .history-table th:nth-child(7),
        .history-table td:nth-child(7) {
          border-right: 1px solid var(--line);
        }
        .history-totals-row th:nth-child(4),
        .history-totals-row td:nth-child(4),
        .history-totals-row th:nth-child(7),
        .history-totals-row td:nth-child(7) {
          border-right: 1px solid rgba(255,255,255,0.3);
        }
        .history-game-list { background: var(--bg); padding: 0.8rem 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
        .history-game-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem 1rem;
          align-items: center;
          font-size: 0.82rem;
          padding-bottom: 0.6rem;
          border-bottom: 1px dashed var(--line);
        }
        .history-game-row:last-child { border-bottom: none; padding-bottom: 0; }
        .history-game-matchup { font-family: 'Oswald', sans-serif; font-weight: 700; min-width: 140px; }
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
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.6rem", marginTop: "1rem" }}>
          <button className="hero-refresh" onClick={loadGames} disabled={status === "loading"}>
            {status === "loading" ? "更新中…" : `重新整理${data ? `（美東 ${data.date}・更新於 ${toTaiwanClock(data.generatedAt)}）` : ""}`}
          </button>
          {isAdmin ? (
            <button className="hero-admin-link" onClick={handleAdminLogout}>管理模式（登出）</button>
          ) : (
            <button className="hero-admin-link" onClick={() => setShowAdminLogin((v) => !v)}>管理</button>
          )}
        </div>

        {showAdminLogin && !isAdmin && (
          <div className="admin-login-box">
            <input
              type="password"
              className="admin-login-input"
              placeholder="管理密碼"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdminLogin()}
            />
            <button className="hero-admin-link" onClick={handleAdminLogin}>登入</button>
            {adminLoginError && <span className="admin-login-error">{adminLoginError}</span>}
          </div>
        )}
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
              <button className={`tab-btn ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>
                歷史預測
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
            <>
              {isAdmin && (
                <div className="admin-rec-toolbar">
                  <span>管理模式：勾選要標記「推薦」的比賽（僅限尚未開賽），已選 {selectedGamePks.size} 場</span>
                  <button className="hero-admin-link" onClick={handleSaveRecommendations} disabled={saveRecStatus === "saving"}>
                    {saveRecStatus === "saving" ? "儲存中…" : "確定"}
                  </button>
                  {saveRecStatus === "saved" && <span className="admin-save-ok">已儲存</span>}
                  {saveRecStatus === "error" && <span className="admin-login-error">儲存失敗，請再試一次</span>}
                </div>
              )}
              <div className="games-grid">
                {filteredGames.length === 0 && (
                  <p className="muted" style={{ gridColumn: "1/-1" }}>
                    {GAMES.length === 0 ? "今天沒有安排 MLB 賽事。" : "找不到符合條件的比賽，換個關鍵字試試。"}
                  </p>
                )}
                {filteredGames.map((g) => (
                  <GameCard
                    key={g.gamePk}
                    g={g}
                    onOpen={setOpenGame}
                    teamMap={teamMap}
                    isAdmin={isAdmin}
                    isSelected={selectedGamePks.has(g.gamePk)}
                    onToggleSelect={toggleGamePk}
                  />
                ))}
              </div>
            </>
          ) : view === "standings" ? (
            <StandingsTable teams={teams} query={query} />
          ) : (
            <HistoryTable data={historyData} status={historyStatus} />
          )}

          <p className="disclaimer">
            賽程、球隊戰績與先發投手數據即時取自 MLB 官方 Stats API（statsapi.mlb.com），約每 90 秒更新一次；
            牛棚近況以球隊近10日整體投手 ERA 概估，傷兵名單取自 40 人名單狀態。
            預測勝率為本站以上述數據推算的模型結果，僅供參考，非官方數據亦非投注建議。
            每場比賽開打前5分鐘預測會鎖定不再變動；比賽結束後至台灣時間晚上7點前，會用 ✓／✗ 標示該場預測是否命中，
            晚上7點後才會切換顯示隔天賽事的預測。
            Data provided by MLB Advanced Media, L.P.
          </p>

          {openGame && <GameDetail g={openGame} onClose={() => setOpenGame(null)} teamMap={teamMap} />}
        </>
      )}
    </div>
  );
}
