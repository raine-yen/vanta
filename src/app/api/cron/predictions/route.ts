import { NextRequest, NextResponse } from "next/server";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { syncPredictionCatalog } from "@/lib/prediction-sync";

// Refreshes the persisted prediction-markets catalog from Polymarket Gamma.
// The hPanel cron handler refreshes this catalog daily.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const synced = await syncPredictionCatalog(mysqlAdmin());
    return NextResponse.json({ ok: true, synced });
  } catch (e) {
    console.error("prediction catalog sync failed", e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;
