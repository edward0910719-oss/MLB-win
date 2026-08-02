import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { setManualRecommendations } from "@/lib/db";

export async function POST(request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "未登入管理密碼。" }, { status: 401 });
  }

  const { slateDate, gamePks } = await request.json().catch(() => ({}));
  if (!slateDate || !Array.isArray(gamePks)) {
    return NextResponse.json({ error: "缺少 slateDate 或 gamePks。" }, { status: 400 });
  }

  try {
    await setManualRecommendations(slateDate, gamePks);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "寫入推薦場次失敗，請稍後再試。", detail: String(err?.message || err) },
      { status: 502 }
    );
  }
}
