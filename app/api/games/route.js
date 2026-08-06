import { NextResponse } from "next/server";
import { TEAM_META } from "@/lib/teamMeta";
import { predictGame, ouLine } from "@/lib/predict";
import { lockPrediction, getLockedPredictions, gradeResult, getManualRecommendations } from "@/lib/db";

// predictions stop updating once a game is within this many minutes of first pitch
const PREDICTION_LOCK_MINUTES = 5;

const MLB_API = "https://statsapi.mlb.com/api/v1";
// how often Next.js may reuse a cached copy of each upstream MLB response
const REVALIDATE_SECONDS = 90;

function etDateString(date) {
  // "YYYY-MM-DD" for America/New_York, which is the date MLB's schedule endpoint keys games by
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Which slate to show flips at 19:00 Taiwan time instead of at the natural ET-midnight
// rollover (which lands around Taiwan noon, mid-review-window). Taiwan is ET+12h, and we
// want the flip delayed from Taiwan-noon to Taiwan-19:00, i.e. delayed by 7 hours — so
// evaluating the ET date 7 hours in the past reproduces exactly that delayed boundary.
// Net effect: from the moment a day's games finish until 19:00 Taiwan time, this keeps
// returning that same (now-final) slate for review; at 19:00 Taiwan it flips to the next
// slate's (pre-game) predictions.
function resolveSlateDate(now) {
  return etDateString(new Date(now.getTime() - 7 * 60 * 60 * 1000));
}

function etTimeString(isoDate) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoDate));
}

function toMLBDateParam(date) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

// Taiwan has no DST (fixed UTC+8), so this fixed-offset arithmetic is safe — unlike the
// ET calculations above, which go through Intl.DateTimeFormat because ET does observe DST.
function secondsUntilNextTaiwan7pm(now) {
  const TAIWAN_OFFSET_MS = 8 * 60 * 60 * 1000;
  const taiwanMs = now.getTime() + TAIWAN_OFFSET_MS;
  const taiwanDate = new Date(taiwanMs);
  const y = taiwanDate.getUTCFullYear(), m = taiwanDate.getUTCMonth(), d = taiwanDate.getUTCDate();
  let next7pmTaiwanMs = Date.UTC(y, m, d, 19, 0, 0);
  if (taiwanMs >= next7pmTaiwanMs) next7pmTaiwanMs = Date.UTC(y, m, d + 1, 19, 0, 0);
  const next7pmRealUtcMs = next7pmTaiwanMs - TAIWAN_OFFSET_MS;
  return Math.max(60, Math.round((next7pmRealUtcMs - now.getTime()) / 1000));
}

function shortPitcherName(fullName) {
  if (!fullName) return "先發未公布";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0][0]}. ${last}`;
}

async function fetchJson(url, revalidateSeconds = REVALIDATE_SECONDS) {
  const res = await fetch(url, { next: { revalidate: revalidateSeconds } });
  if (!res.ok) {
    throw new Error(`MLB Stats API ${res.status} for ${url}`);
  }
  return res.json();
}

// warmer air carries fly balls further, so a simple temperature-only heuristic is used as
// a run-total nudge — wind direction is deliberately left out since getting it wrong (each
// park has a different orientation) would be worse than not modeling it at all. Clamped so
// a single hot/cold reading can't swing the total by more than ~8%.
async function fetchWeatherRunFactor(venue, gameDateIso) {
  if (!venue) return { tempF: null, runFactor: 1 };
  try {
    const points = await fetchJson(`https://api.weather.gov/points/${venue.lat},${venue.lon}`);
    const hourlyUrl = points.properties?.forecastHourly;
    if (!hourlyUrl) return { tempF: null, runFactor: 1 };
    const hourly = await fetchJson(hourlyUrl);
    const periods = hourly.properties?.periods || [];
    const gameMs = new Date(gameDateIso).getTime();
    let closest = null;
    let closestDiffMs = Infinity;
    for (const p of periods) {
      const diff = Math.abs(new Date(p.startTime).getTime() - gameMs);
      if (diff < closestDiffMs) {
        closestDiffMs = diff;
        closest = p;
      }
    }
    if (!closest || typeof closest.temperature !== "number") return { tempF: null, runFactor: 1 };
    const runFactor = Math.min(1.08, Math.max(0.92, 1 + (closest.temperature - 70) * 0.0025));
    return { tempF: closest.temperature, runFactor };
  } catch {
    // weather.gov only covers US locations and can be flaky — a missing forecast just
    // means no adjustment, not a broken page
    return { tempF: null, runFactor: 1 };
  }
}

export async function GET() {
  try {
    const now = new Date();
    const etDate = resolveSlateDate(now);
    const season = etDate.slice(0, 4);

    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const startParam = toMLBDateParam(tenDaysAgo);
    const endParam = toMLBDateParam(now);

    const yesterday = etDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const twoDaysAgo = etDateString(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));

    // anchored to etDate (stable across a whole 7pm-to-7pm Taiwan cycle) rather than the
    // live `now`, so this call's URL — and therefore its cache entry — stays identical for
    // the whole cycle instead of drifting every request
    const slateAnchor = new Date(`${etDate}T00:00:00Z`);
    const recentHittingEndParam = toMLBDateParam(slateAnchor);
    const recentHittingStartParam = toMLBDateParam(new Date(slateAnchor.getTime() - 10 * 24 * 60 * 60 * 1000));
    const secondsUntil7pm = secondsUntilNextTaiwan7pm(now);

    const [teamsJson, scheduleJson, standingsJson, seasonPitchingJson, recentPitchingJson, seasonHittingJson, recentGamesJson, recentHittingJson] =
      await Promise.all([
        fetchJson(`${MLB_API}/teams?sportId=1&activeStatus=Y`),
        fetchJson(`${MLB_API}/schedule?sportId=1&date=${etDate}&hydrate=team,probablePitcher,lineups,linescore`),
        fetchJson(`${MLB_API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`),
        fetchJson(`${MLB_API}/teams/stats?stats=season&group=pitching&season=${season}&sportIds=1`),
        fetchJson(
          `${MLB_API}/teams/stats?stats=byDateRange&group=pitching&season=${season}&sportIds=1&startDate=${startParam}&endDate=${endParam}`
        ),
        fetchJson(`${MLB_API}/teams/stats?stats=season&group=hitting&season=${season}&sportIds=1`),
        fetchJson(`${MLB_API}/schedule?sportId=1&startDate=${twoDaysAgo}&endDate=${yesterday}&hydrate=linescore`),
        // 打線攻擊力(OPS) fallback: last-10-days team hitting, fixed until the next 19:00
        // Taiwan slate flip instead of the usual 90s revalidate
        fetchJson(
          `${MLB_API}/teams/stats?stats=byDateRange&group=hitting&season=${season}&sportIds=1&startDate=${recentHittingStartParam}&endDate=${recentHittingEndParam}`,
          secondsUntil7pm
        ),
      ]);

    // ---- bullpen fatigue: teams that played an extra-inning game in the last 2 days ----
    const fatiguedTeamIds = new Set();
    for (const day of recentGamesJson.dates || []) {
      for (const g of day.games || []) {
        if (g.status?.abstractGameState === "Final" && (g.linescore?.currentInning ?? 0) > 9) {
          fatiguedTeamIds.add(g.teams.home.team.id);
          fatiguedTeamIds.add(g.teams.away.team.id);
        }
      }
    }

    // ---- team identity: id -> { abbr, city, name } from live team list ----
    const teamIdentity = {};
    for (const t of teamsJson.teams || []) {
      teamIdentity[t.id] = {
        abbr: t.abbreviation,
        city: t.locationName,
        name: t.teamName,
      };
    }

    // ---- standings: id -> { w, l, rs, ra, last10 } ----
    const standingsMap = {};
    for (const record of standingsJson.records || []) {
      for (const tr of record.teamRecords || []) {
        const lastTen = (tr.records?.splitRecords || []).find((s) => s.type === "lastTen");
        standingsMap[tr.team.id] = {
          w: tr.leagueRecord?.wins ?? 0,
          l: tr.leagueRecord?.losses ?? 0,
          rs: tr.runsScored ?? 0,
          ra: tr.runsAllowed ?? 0,
          last10: lastTen ? `${lastTen.wins}-${lastTen.losses}` : "0-0",
        };
      }
    }

    // ---- season ERA per team: id -> era ----
    const eraMap = {};
    for (const split of seasonPitchingJson.stats?.[0]?.splits || []) {
      eraMap[split.team.id] = parseFloat(split.stat.era);
    }

    // ---- last-10-days team ERA per team: id -> era. This is the whole team's recent
    // pitching (starters included), not an isolated bullpen number — MLB's public API
    // doesn't expose a reliever-only split — so it's used as a "recent pitching form"
    // signal rather than being labeled as bullpen-specific ----
    const recentEraMap = {};
    for (const split of recentPitchingJson.stats?.[0]?.splits || []) {
      recentEraMap[split.team.id] = parseFloat(split.stat.era);
    }

    // ---- season OPS per team, used both as a display stat and as the lineup-strength
    // ratio's denominator: id -> ops ----
    const teamOpsMap = {};
    for (const split of seasonHittingJson.stats?.[0]?.splits || []) {
      teamOpsMap[split.team.id] = parseFloat(split.stat.ops);
    }

    // ---- last-10-days team OPS, used as the 打線攻擊力(OPS) fallback before a lineup is
    // confirmed — refreshed once per 19:00 Taiwan cycle rather than every request: id -> ops ----
    const recentOpsMap = {};
    for (const split of recentHittingJson.stats?.[0]?.splits || []) {
      recentOpsMap[split.team.id] = parseFloat(split.stat.ops);
    }

    // ---- today's games ----
    const rawGames = (scheduleJson.dates?.[0]?.games || []).filter((g) => {
      const bad = ["Postponed", "Cancelled", "Suspended"];
      return !bad.some((s) => g.status?.detailedState?.includes(s));
    });

    const gameTeamIds = new Set();
    const pitcherIds = new Set();
    const hitterIds = new Set();
    for (const g of rawGames) {
      gameTeamIds.add(g.teams.home.team.id);
      gameTeamIds.add(g.teams.away.team.id);
      if (g.teams.home.probablePitcher) pitcherIds.add(g.teams.home.probablePitcher.id);
      if (g.teams.away.probablePitcher) pitcherIds.add(g.teams.away.probablePitcher.id);
      for (const p of g.lineups?.homePlayers || []) hitterIds.add(p.id);
      for (const p of g.lineups?.awayPlayers || []) hitterIds.add(p.id);
    }

    // ---- injuries: only fetched for teams actually playing today ----
    // keep the raw injured-player list per team (for the full display list) as well as
    // enough info (id + position) to later work out which injuries are actually significant
    const injuredPlayersByTeam = {};
    await Promise.all(
      [...gameTeamIds].map(async (id) => {
        try {
          const roster = await fetchJson(`${MLB_API}/teams/${id}/roster?rosterType=40Man`);
          injuredPlayersByTeam[id] = (roster.roster || [])
            .filter((p) => p.status?.code?.startsWith("D"))
            .map((p) => ({
              id: p.person.id,
              name: p.person.fullName,
              description: p.status.description,
              isPitcher: p.position?.code === "1",
            }));
        } catch {
          injuredPlayersByTeam[id] = [];
        }
      })
    );
    const injuryMap = {};
    for (const [id, players] of Object.entries(injuredPlayersByTeam)) {
      injuryMap[id] = players.map((p) => `${p.name}（${p.description}）`);
    }

    // ---- probable pitcher season stats (ERA / WHIP), fetched in one bulk call ----
    const pitcherStatsMap = {};
    if (pitcherIds.size > 0) {
      const people = await fetchJson(
        `${MLB_API}/people?personIds=${[...pitcherIds].join(",")}&hydrate=stats(group=[pitching],type=[season],season=${season})`
      );
      for (const person of people.people || []) {
        const split = person.stats?.[0]?.splits?.[0];
        if (split) {
          pitcherStatsMap[person.id] = {
            era: parseFloat(split.stat.era),
            whip: parseFloat(split.stat.whip),
          };
        }
      }
    }

    // ---- confirmed starting lineup hitters' last-10-games OPS (their own season OPS as a
    // per-player fallback for anyone without 10 games yet — call-ups, injury returns, etc.),
    // fetched in one bulk call ----
    const hitterOpsMap = {};
    if (hitterIds.size > 0) {
      const hitters = await fetchJson(
        `${MLB_API}/people?personIds=${[...hitterIds].join(",")}&hydrate=stats(group=[hitting],type=[lastXGames,season],limit=10,season=${season})`
      );
      for (const person of hitters.people || []) {
        const last10 = person.stats?.find((s) => s.type?.displayName === "lastXGames")?.splits?.[0];
        const seasonStat = person.stats?.find((s) => s.type?.displayName === "season")?.splits?.[0];
        const ops = parseFloat(last10?.stat?.ops ?? seasonStat?.stat?.ops);
        if (!Number.isNaN(ops)) hitterOpsMap[person.id] = ops;
      }
    }

    // average OPS of the confirmed starting lineup; falls back to the team's last-10-days
    // OPS (more form-sensitive than a season average, and symmetric with how bp10 already
    // uses recent pitching) when MLB hasn't posted a lineup yet (typically until ~1-2
    // hours before first pitch)
    function lineupOps(teamId, players) {
      const opsValues = (players || []).map((p) => hitterOpsMap[p.id]).filter((v) => v !== undefined);
      if (opsValues.length >= 5) {
        return { ops: opsValues.reduce((s, v) => s + v, 0) / opsValues.length, confirmed: true };
      }
      return { ops: recentOpsMap[teamId] ?? teamOpsMap[teamId] ?? 0.7, confirmed: false };
    }

    // ---- classify which injuries are actually significant (rotation starter / regular
    // contributor) vs bench/depth pieces, so the injury penalty isn't just a headcount ----
    const injuredPitcherIds = new Set();
    const injuredHitterIds = new Set();
    for (const players of Object.values(injuredPlayersByTeam)) {
      for (const p of players) {
        (p.isPitcher ? injuredPitcherIds : injuredHitterIds).add(p.id);
      }
    }
    const SIGNIFICANT_GAMES_STARTED = 5; // rotation-caliber pitcher
    const SIGNIFICANT_PLATE_APPEARANCES = 150; // regular-contributor position player
    const gamesStartedMap = {};
    const plateAppearancesMap = {};
    const [injuredPitchersJson, injuredHittersJson] = await Promise.all([
      injuredPitcherIds.size > 0
        ? fetchJson(
            `${MLB_API}/people?personIds=${[...injuredPitcherIds].join(",")}&hydrate=stats(group=[pitching],type=[season],season=${season})`
          )
        : Promise.resolve({ people: [] }),
      injuredHitterIds.size > 0
        ? fetchJson(
            `${MLB_API}/people?personIds=${[...injuredHitterIds].join(",")}&hydrate=stats(group=[hitting],type=[season],season=${season})`
          )
        : Promise.resolve({ people: [] }),
    ]);
    for (const person of injuredPitchersJson.people || []) {
      gamesStartedMap[person.id] = person.stats?.[0]?.splits?.[0]?.stat?.gamesStarted ?? 0;
    }
    for (const person of injuredHittersJson.people || []) {
      plateAppearancesMap[person.id] = person.stats?.[0]?.splits?.[0]?.stat?.plateAppearances ?? 0;
    }
    const significantInjuryCountMap = {};
    for (const [teamId, players] of Object.entries(injuredPlayersByTeam)) {
      significantInjuryCountMap[teamId] = players.filter((p) =>
        p.isPitcher
          ? gamesStartedMap[p.id] >= SIGNIFICANT_GAMES_STARTED
          : plateAppearancesMap[p.id] >= SIGNIFICANT_PLATE_APPEARANCES
      ).length;
    }

    // ---- head-to-head record this season (display-only — with MLB's unbalanced schedule
    // most pairs only meet 2-6 times, too small a sample to feed into the win-probability
    // model, but still useful as reference info) ----
    const h2hPairs = new Map();
    for (const g of rawGames) {
      const homeId = g.teams.home.team.id;
      const awayId = g.teams.away.team.id;
      h2hPairs.set(`${homeId}-${awayId}`, { homeId, awayId });
    }
    const h2hMap = {};
    await Promise.all(
      [...h2hPairs.entries()].map(async ([key, { homeId, awayId }]) => {
        try {
          const json = await fetchJson(
            `${MLB_API}/schedule?sportId=1&teamId=${homeId}&opponentId=${awayId}&season=${season}&gameType=R`
          );
          let homeWins = 0;
          let awayWins = 0;
          for (const day of json.dates || []) {
            for (const game of day.games || []) {
              if (game.status?.abstractGameState !== "Final") continue;
              const hs = game.teams.home.score;
              const as = game.teams.away.score;
              if (typeof hs !== "number" || typeof as !== "number") continue;
              const winnerId = hs > as ? game.teams.home.team.id : game.teams.away.team.id;
              if (winnerId === homeId) homeWins++;
              else if (winnerId === awayId) awayWins++;
            }
          }
          h2hMap[key] = { homeWins, awayWins };
        } catch {
          h2hMap[key] = { homeWins: 0, awayWins: 0 };
        }
      })
    );

    // ---- weather at each home park's coordinates, around first pitch (skipped for domes) ----
    const weatherMap = {};
    await Promise.all(
      rawGames.map(async (g) => {
        const homeMeta = TEAM_META[g.teams.home.team.id];
        if (!homeMeta || homeMeta.isDome) {
          weatherMap[g.gamePk] = { tempF: null, runFactor: 1 };
          return;
        }
        weatherMap[g.gamePk] = await fetchWeatherRunFactor(homeMeta.venue, g.gameDate);
      })
    );

    // ---- assemble TEAMS (all 30 clubs, for the standings tab) ----
    const teams = Object.entries(TEAM_META).map(([idStr, meta]) => {
      const id = Number(idStr);
      const identity = teamIdentity[id] || {};
      const standing = standingsMap[id] || { w: 0, l: 0, rs: 0, ra: 0, last10: "0-0" };
      const era = eraMap[id] ?? 4.0;
      return {
        id: identity.abbr || idStr,
        zh: meta.zh,
        city: identity.city || "",
        name: identity.name || "",
        div: meta.div,
        color: meta.color,
        accent: meta.accent,
        w: standing.w,
        l: standing.l,
        rs: standing.rs,
        ra: standing.ra,
        last10: standing.last10,
        era,
        bp10: recentEraMap[id] ?? era,
        ops: teamOpsMap[id] ?? 0.7,
        parkFactor: meta.parkFactor,
        injuries: injuryMap[id] || [],
        significantInjuryCount: significantInjuryCountMap[id] ?? 0,
      };
    });
    function buildProbablePitcher(teamId, probablePitcher) {
      const stats = probablePitcher ? pitcherStatsMap[probablePitcher.id] : null;
      if (probablePitcher && stats) {
        return { name: shortPitcherName(probablePitcher.fullName), era: stats.era, whip: stats.whip };
      }
      // fall back to the team's season ERA so the prediction model still has a usable number
      const fallbackEra = eraMap[teamId] ?? 4.0;
      return {
        name: probablePitcher ? shortPitcherName(probablePitcher.fullName) : "先發未公布",
        era: fallbackEra,
        whip: 1.3,
      };
    }

    // ---- current batter's AVG / current pitcher's ERA for live games — these can be
    // substitutes not in the pre-game lineup/probable-pitcher, so they need their own
    // lookup rather than reusing hitterOpsMap/pitcherStatsMap ----
    const liveBatterIds = new Set();
    const livePitcherIds = new Set();
    for (const g of rawGames) {
      if (g.status?.abstractGameState !== "Live") continue;
      if (g.linescore?.offense?.batter?.id) liveBatterIds.add(g.linescore.offense.batter.id);
      if (g.linescore?.defense?.pitcher?.id) livePitcherIds.add(g.linescore.defense.pitcher.id);
    }
    const liveBatterAvgMap = {};
    const livePitcherEraMap = {};
    const [liveBattersJson, livePitchersJson] = await Promise.all([
      liveBatterIds.size > 0
        ? fetchJson(
            `${MLB_API}/people?personIds=${[...liveBatterIds].join(",")}&hydrate=stats(group=[hitting],type=[season],season=${season})`
          )
        : Promise.resolve({ people: [] }),
      livePitcherIds.size > 0
        ? fetchJson(
            `${MLB_API}/people?personIds=${[...livePitcherIds].join(",")}&hydrate=stats(group=[pitching],type=[season],season=${season})`
          )
        : Promise.resolve({ people: [] }),
    ]);
    for (const person of liveBattersJson.people || []) {
      liveBatterAvgMap[person.id] = person.stats?.[0]?.splits?.[0]?.stat?.avg ?? null;
    }
    for (const person of livePitchersJson.people || []) {
      livePitcherEraMap[person.id] = person.stats?.[0]?.splits?.[0]?.stat?.era ?? null;
    }

    const games = rawGames
      .map((g) => {
        const homeId = g.teams.home.team.id;
        const awayId = g.teams.away.team.id;
        const homeAbbr = teamIdentity[homeId]?.abbr;
        const awayAbbr = teamIdentity[awayId]?.abbr;
        if (!homeAbbr || !awayAbbr || !TEAM_META[homeId] || !TEAM_META[awayId]) return null;
        const homeLineup = lineupOps(homeId, g.lineups?.homePlayers);
        const awayLineup = lineupOps(awayId, g.lineups?.awayPlayers);
        const weather = weatherMap[g.gamePk] || { tempF: null, runFactor: 1 };
        return {
          gamePk: g.gamePk,
          home: homeAbbr,
          away: awayAbbr,
          hp: buildProbablePitcher(homeId, g.teams.home.probablePitcher),
          ap: buildProbablePitcher(awayId, g.teams.away.probablePitcher),
          time: etTimeString(g.gameDate),
          gameDateIso: g.gameDate,
          homeLineupOps: homeLineup.ops,
          awayLineupOps: awayLineup.ops,
          homeLineupConfirmed: homeLineup.confirmed,
          awayLineupConfirmed: awayLineup.confirmed,
          homeBullpenFatigued: fatiguedTeamIds.has(homeId),
          awayBullpenFatigued: fatiguedTeamIds.has(awayId),
          weatherTempF: weather.tempF,
          weatherRunFactor: weather.runFactor,
          h2h: h2hMap[`${homeId}-${awayId}`] || { homeWins: 0, awayWins: 0 },
          homeScore: typeof g.teams.home.score === "number" ? g.teams.home.score : null,
          awayScore: typeof g.teams.away.score === "number" ? g.teams.away.score : null,
          liveInning:
            g.status?.abstractGameState === "Live" && g.linescore?.currentInning
              ? { number: g.linescore.currentInning, half: g.linescore.inningState || null }
              : null,
          liveAtBat:
            g.status?.abstractGameState === "Live" && g.linescore?.offense?.batter
              ? {
                  battingSide: g.linescore.offense.team?.id === homeId ? "home" : "away",
                  batter: g.linescore.offense.batter?.fullName || null,
                  battingOrder: g.linescore.offense.battingOrder ?? null,
                  batterAvg: liveBatterAvgMap[g.linescore.offense.batter?.id] ?? null,
                  pitcher: g.linescore.defense?.pitcher?.fullName || null,
                  pitcherEra: livePitcherEraMap[g.linescore.defense?.pitcher?.id] ?? null,
                }
              : null,
          status: {
            abstract: g.status?.abstractGameState || "Preview",
            detailed: g.status?.detailedState || "Scheduled",
          },
        };
      })
      .filter(Boolean);

    // ---- predictions: compute fresh, then read/write the lock+grade state in Postgres so
    // every visitor (and the 歷史預測 history tab) sees the same locked-in snapshot ----
    const teamMap = Object.fromEntries(teams.map((t) => [t.id, t]));
    const leagueAvgEra = teams.length ? teams.reduce((s, t) => s + t.era, 0) / teams.length : 4.0;

    function isGameLocked(g) {
      const lockMs = new Date(g.gameDateIso).getTime() - PREDICTION_LOCK_MINUTES * 60 * 1000;
      return g.status.abstract === "Live" || g.status.abstract === "Final" || Date.now() >= lockMs;
    }

    let lockedByGamePk = {};
    try {
      const shouldLockGamePks = games.filter(isGameLocked).map((g) => g.gamePk);
      const lockedRows = shouldLockGamePks.length ? await getLockedPredictions(shouldLockGamePks, etDate) : [];
      lockedByGamePk = Object.fromEntries(lockedRows.map((r) => [Number(r.game_pk), r]));
    } catch {
      // DB unreachable — degrade to always-fresh predictions rather than breaking the page
    }

    const freshPredByGamePk = Object.fromEntries(games.map((g) => [g.gamePk, predictGame(g, teamMap, leagueAvgEra)]));
    const predByGamePk = Object.fromEntries(
      games.map((g) => [g.gamePk, lockedByGamePk[g.gamePk]?.pred_json ?? freshPredByGamePk[g.gamePk]])
    );

    // "推薦" is set manually via the password-protected panel (not auto-picked) — see
    // /api/admin/recommendations. Empty by default until something's been chosen for the day.
    let manualRecGamePks = new Set();
    try {
      manualRecGamePks = new Set(await getManualRecommendations(etDate));
    } catch {
      // DB unreachable — no recommendations shown rather than breaking the page
    }

    await Promise.all(
      games
        .filter((g) => isGameLocked(g) && !lockedByGamePk[g.gamePk])
        .map((g) =>
          lockPrediction({
            gamePk: g.gamePk,
            slateDate: etDate,
            homeTeam: g.home,
            awayTeam: g.away,
            homeZh: teamMap[g.home].zh,
            awayZh: teamMap[g.away].zh,
            homeProb: freshPredByGamePk[g.gamePk].homeProb,
            runsLow: freshPredByGamePk[g.gamePk].runs.low,
            runsHigh: freshPredByGamePk[g.gamePk].runs.high,
            recommended: manualRecGamePks.has(g.gamePk),
            pred: freshPredByGamePk[g.gamePk],
            gameDateIso: g.gameDateIso,
          }).catch(() => {})
        )
    );

    await Promise.all(
      games
        .filter((g) => {
          const row = lockedByGamePk[g.gamePk];
          return g.status.abstract === "Final" && row && !row.graded_at && g.homeScore !== null && g.awayScore !== null;
        })
        .map((g) => {
          const row = lockedByGamePk[g.gamePk];
          const predictedHomeWin = row.home_prob >= 0.5;
          const actualHomeWin = g.homeScore > g.awayScore;
          const actualTotal = g.homeScore + g.awayScore;
          const winCorrect = predictedHomeWin === actualHomeWin;
          const { line, isOver } = ouLine(row.pred_json);
          const runsCorrect = isOver ? actualTotal > line : actualTotal < line;
          return gradeResult(g.gamePk, etDate, g.homeScore, g.awayScore, winCorrect, runsCorrect).catch(() => {});
        })
    );

    const gamesWithPred = games.map((g) => ({
      ...g,
      pred: predByGamePk[g.gamePk],
      recommended: lockedByGamePk[g.gamePk]?.recommended ?? manualRecGamePks.has(g.gamePk),
    }));

    return NextResponse.json({
      date: etDate,
      generatedAt: new Date().toISOString(),
      teams,
      games: gamesWithPred,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "無法從 MLB Stats API 取得資料，請稍後再試。", detail: String(err?.message || err) },
      { status: 502 }
    );
  }
}
