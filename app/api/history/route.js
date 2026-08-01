import { NextResponse } from "next/server";
import { getAllPredictions } from "@/lib/db";

function toDateKey(slateDate) {
  // The driver parses a DATE column into a JS Date at *local* midnight for that
  // calendar date. Reading it back with local getters (not toISOString's UTC ones)
  // reverses that consistently, regardless of which timezone this process runs in.
  const d = new Date(slateDate);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function GET() {
  try {
    const rows = await getAllPredictions();

    const byDate = {};
    for (const r of rows) {
      const dateKey = toDateKey(r.slate_date);
      if (!byDate[dateKey]) {
        byDate[dateKey] = { date: dateKey, winTotal: 0, winCorrect: 0, runsTotal: 0, runsCorrect: 0, games: [] };
      }
      if (r.win_correct !== null) {
        byDate[dateKey].winTotal += 1;
        if (r.win_correct) byDate[dateKey].winCorrect += 1;
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
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const recommendedRows = rows.filter((r) => r.recommended && r.win_correct !== null);
    const recommendedCorrect = recommendedRows.filter((r) => r.win_correct).length;

    return NextResponse.json({
      days,
      recommended: {
        total: recommendedRows.length,
        correct: recommendedCorrect,
        rate: recommendedRows.length > 0 ? recommendedCorrect / recommendedRows.length : null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "無法取得歷史預測資料，請稍後再試。", detail: String(err?.message || err) },
      { status: 502 }
    );
  }
}
