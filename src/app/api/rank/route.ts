// Dedicated rank drill-in endpoint. The leaderboard list intentionally never
// includes tier/division/movement (keeps the board lean, per product
// decision); tapping a trader's rank icon calls this to fetch that detail.
// Scoped to the viewer's own competition — same visibility boundary as the
// leaderboard list itself, not a wider account-lookup surface.
import { NextRequest, NextResponse } from "next/server";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { getSessionUser } from "@/lib/session-user";
import { calculateInvestedPerformance } from "@/lib/performance";
import { rankForAccount, rankMovement } from "@/lib/ranks";
import { fetchYahooPrices } from "@/lib/prices";
import { getCurrentAccount } from "@/lib/app-data";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const accountId = req.nextUrl.searchParams.get("account_id");
  if (!accountId) return NextResponse.json({ error: "account_id is required" }, { status: 400 });

  const context = await getCurrentAccount(req);
  if ("response" in context) return context.response;
  const db = context.db;
  const viewerAccount = context.account;

  const { data: target, error: tErr } = await db
    .from("accounts")
    .select("id, display_name, cash, starting_cash, competition_id")
    .eq("id", accountId)
    .eq("competition_id", viewerAccount.competition_id) // same board only
    .maybeSingle();
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: "trader not found on your board" }, { status: 404 });

  const { data: positions } = await db
    .from("positions")
    .select("symbol, qty, avg_entry_price")
    .eq("account_id", accountId);
  const posRows = (positions ?? []) as { symbol: string; qty: number; avg_entry_price: number }[];
  const symbols = Array.from(new Set(posRows.map((p) => p.symbol)));
  const priceMap = symbols.length > 0 ? await fetchYahooPrices(symbols) : new Map<string, { price: number }>();
  const missing = symbols.filter((s) => !priceMap.has(s));
  if (missing.length > 0) {
    const { data: cached } = await db.from("prices").select("symbol, price").in("symbol", missing);
    for (const row of (cached ?? []) as { symbol: string; price: number }[]) priceMap.set(row.symbol, { price: Number(row.price) } as never);
  }
  const enriched = posRows.map((p) => ({
    qty: Number(p.qty),
    avg_entry_price: Number(p.avg_entry_price),
    current_price: (priceMap.get(p.symbol) as { price: number } | undefined)?.price ?? Number(p.avg_entry_price),
  }));
  const performance = calculateInvestedPerformance(enriched);
  const equity = Number(target.cash) + performance.market_value;
  const rank = rankForAccount({ equity, startingCash: Number(target.starting_cash) });

  // Latest persisted leader_history row gives real movement (position delta);
  // fall back to "new" if this account has no snapshot yet.
  const { data: history } = await db
    .from("leader_history")
    .select("position, recorded_at")
    .eq("account_id", accountId)
    .order("recorded_at", { ascending: false })
    .limit(2);
  const rows = (history ?? []) as { position: number; recorded_at: string }[];
  const mv = rankMovement({
    current: rows[0]?.position ?? 0,
    previous: rows[1]?.position ?? null,
    previousSeen: rows.length > 1,
  });

  return NextResponse.json({
    account_id: target.id,
    display_name: target.display_name,
    tier: rank.tier,
    tier_name: rank.tierName,
    division: rank.division,
    rank_points: rank.rankPoints,
    return_pct: rank.returnPct,
    movement: mv.movement,
    movement_amount: mv.movementAmount,
  });
}

export const dynamic = "force-dynamic";
