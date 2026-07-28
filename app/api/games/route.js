import { NextResponse } from "next/server";
import { TEAM_META } from "@/lib/teamMeta";

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

function shortPitcherName(fullName) {
  if (!fullName) return "先發未公布";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0][0]}. ${last}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { next: { revalidate: REVALIDATE_SECONDS } });
  if (!res.ok) {
    throw new Error(`MLB Stats API ${res.status} for ${url}`);
  }
  return res.json();
}

export async function GET() {
  try {
    const now = new Date();
    const etDate = etDateString(now);
    const season = etDate.slice(0, 4);

    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const startParam = toMLBDateParam(tenDaysAgo);
    const endParam = toMLBDateParam(now);

    const [teamsJson, scheduleJson, standingsJson, seasonPitchingJson, recentPitchingJson] =
      await Promise.all([
        fetchJson(`${MLB_API}/teams?sportId=1&activeStatus=Y`),
        fetchJson(`${MLB_API}/schedule?sportId=1&date=${etDate}&hydrate=team,probablePitcher`),
        fetchJson(`${MLB_API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`),
        fetchJson(`${MLB_API}/teams/stats?stats=season&group=pitching&season=${season}&sportIds=1`),
        fetchJson(
          `${MLB_API}/teams/stats?stats=byDateRange&group=pitching&season=${season}&sportIds=1&startDate=${startParam}&endDate=${endParam}`
        ),
      ]);

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

    // ---- last-10-days team ERA per team, used as a bullpen-form proxy: id -> era ----
    const recentEraMap = {};
    for (const split of recentPitchingJson.stats?.[0]?.splits || []) {
      recentEraMap[split.team.id] = parseFloat(split.stat.era);
    }

    // ---- today's games ----
    const rawGames = (scheduleJson.dates?.[0]?.games || []).filter((g) => {
      const bad = ["Postponed", "Cancelled", "Suspended"];
      return !bad.some((s) => g.status?.detailedState?.includes(s));
    });

    const gameTeamIds = new Set();
    const pitcherIds = new Set();
    for (const g of rawGames) {
      gameTeamIds.add(g.teams.home.team.id);
      gameTeamIds.add(g.teams.away.team.id);
      if (g.teams.home.probablePitcher) pitcherIds.add(g.teams.home.probablePitcher.id);
      if (g.teams.away.probablePitcher) pitcherIds.add(g.teams.away.probablePitcher.id);
    }

    // ---- injuries: only fetched for teams actually playing today ----
    const injuryMap = {};
    await Promise.all(
      [...gameTeamIds].map(async (id) => {
        try {
          const roster = await fetchJson(`${MLB_API}/teams/${id}/roster?rosterType=40Man`);
          injuryMap[id] = (roster.roster || [])
            .filter((p) => p.status?.code?.startsWith("D"))
            .map((p) => `${p.person.fullName}（${p.status.description}）`);
        } catch {
          injuryMap[id] = [];
        }
      })
    );

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
        injuries: injuryMap[id] || [],
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

    const games = rawGames
      .map((g) => {
        const homeId = g.teams.home.team.id;
        const awayId = g.teams.away.team.id;
        const homeAbbr = teamIdentity[homeId]?.abbr;
        const awayAbbr = teamIdentity[awayId]?.abbr;
        if (!homeAbbr || !awayAbbr || !TEAM_META[homeId] || !TEAM_META[awayId]) return null;
        return {
          gamePk: g.gamePk,
          home: homeAbbr,
          away: awayAbbr,
          hp: buildProbablePitcher(homeId, g.teams.home.probablePitcher),
          ap: buildProbablePitcher(awayId, g.teams.away.probablePitcher),
          time: etTimeString(g.gameDate),
          gameDateIso: g.gameDate,
        };
      })
      .filter(Boolean);

    return NextResponse.json({
      date: etDate,
      generatedAt: new Date().toISOString(),
      teams,
      games,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "無法從 MLB Stats API 取得資料，請稍後再試。", detail: String(err?.message || err) },
      { status: 502 }
    );
  }
}
