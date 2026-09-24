// On-demand catalog + settlement refresh. Since the Hobby cron ceiling is
// once/day, the market list can go stale for up to 24h via cron alone. This
// endpoint lets the client (or an admin) force a refresh — e.g. on app open,
// or after a user reports a market missing/still showing as open. Rate-limited
// lightly by requiring a session (any signed-in user can trigger it; it only
// re-reads public Polymarket data and touches no user-owned rows other than
// their own settlement payout).
import { NextRequest, NextResponse } from "next/server";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { syncPredictionCatalog } from "@/lib/prediction-sync";
import { settlePredictionMarkets } from "@/lib/prediction-settle";
import { getSessionUser } from "@/lib/session-user";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const db = mysqlAdmin();
    const synced = await syncPredictionCatalog(db);
    const settled = await settlePredictionMarkets({ db: db as any });
    return NextResponse.json({ ok: true, synced, settled });
  } catch (e) {
    console.error("on-demand prediction refresh failed", e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;
