import { NextResponse } from "next/server";
import { getAllPredictions } from "@/lib/db";

// Groups by the Taiwan calendar day the game actually started on, not the US ET
// schedule date stored in slate_date — those two dates commonly differ, since an
// evening ET game lands as early-morning-to-noon the *next* day in Taiwan. Falls back
// to locked_at (never null) for rows locked before game_date_iso started being stored.
function toTaiwanDateKey(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export async function GET() {
  try {
    const rows = await getAllPredictions();

    const byDate = {};
    for (const r of rows) {
      const dateKey = toTaiwanDateKey(r.game_date_iso || r.locked_at);
      if (!byDate[dateKey]) {
        byDate[dateKey] = {
          date: dateKey,
          winTotal: 0,
          winCorrect: 0,
          runsTotal: 0,
          runsCorrect: 0,
          recTotal: 0,
          recCorrect: 0,
          games: [],
        };
      }
      if (r.win_correct !== null) {
        byDate[dateKey].winTotal += 1;
        if (r.win_correct) byDate[dateKey].winCorrect += 1;
        if (r.recommended) {
          byDate[dateKey].recTotal += 1;
          if (r.win_correct) byDate[dateKey].recCorrect += 1;
        }
      }
      if (r.runs_correct !== null) {
        byDate[dateKey].runsTotal += 1;
        if (r.runs_correct) byDate[dateKey].runsCorrect += 1;
      }
      byDate[dateKey].games.push({
        gamePk: r.game_pk,
        homeTeam: r.home_team,
        awayTeam: r.away_team,
        homeZh: r.home_zh,
        awayZh: r.away_zh,
        recommended: r.recommended,
        pred: r.pred_json,
        homeScore: r.home_score,
        awayScore: r.away_score,
        winCorrect: r.win_correct,
        runsCorrect: r.runs_correct,
      });
    }

    const days = Object.values(byDate)
      .map((d) => ({
        ...d,
        winRate: d.winTotal > 0 ? d.winCorrect / d.winTotal : null,
        runsRate: d.runsTotal > 0 ? d.runsCorrect / d.runsTotal : null,
        recRate: d.recTotal > 0 ? d.recCorrect / d.recTotal : null,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    return NextResponse.json({ days });
  } catch (err) {
    return NextResponse.json(
      { error: "無法取得歷史預測資料，請稍後再試。", detail: String(err?.message || err) },
      { status: 502 }
    );
  }
}
