import { NextRequest, NextResponse } from "next/server";
import { fetchYahooPrices } from "@/lib/prices";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { getCurrentAccount, isMissingTableError } from "@/lib/app-data";
import { calculateInvestedPerformance } from "@/lib/performance";

export async function GET(req: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const db = mysqlAdmin();

  const { data: account, error } = await db
    .from("accounts")
    .select("id, display_name, cash, starting_cash, competition_id, created_at, status")
    .eq("id", accountId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!account || account.status !== "active") return NextResponse.json({ error: "trader not found" }, { status: 404 });

  const profileResult = await db.from("trader_profiles").select("*").eq("account_id", accountId).maybeSingle();
  const profile = profileResult.error && isMissingTableError(profileResult.error) ? null : profileResult.data ?? null;
  const isPublic = (profile as { is_public?: boolean } | null)?.is_public !== false;

  // Public holdings/orders/history are opt-in. A private profile still shows
  // name + return_pct (leaderboard-equivalent visibility) but never the
  // dollar breakdown, position list, or order history.
  const [{ data: positions }, { data: orders }, achievementsResult, { data: snapshots }] = await Promise.all([
    isPublic
      ? db.from("positions").select("symbol, qty, avg_entry_price").eq("account_id", accountId)
      : Promise.resolve({ data: [] as never[] }),
    isPublic
      ? db.from("orders").select("id, symbol, side, qty, status, created_at").eq("account_id", accountId).order("created_at", { ascending: false }).limit(12)
      : Promise.resolve({ data: [] as never[] }),
    db.from("achievements").select("*").eq("account_id", accountId).order("earned_at", { ascending: false }).limit(12),
    isPublic
      ? db.from("equity_snapshots").select("equity, created_at").eq("account_id", accountId).order("created_at", { ascending: true }).limit(200)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const posRows = (positions ?? []) as Array<{ symbol: string; qty: number; avg_entry_price: number }>;
  const prices = posRows.length ? await fetchYahooPrices(posRows.map((p) => p.symbol)) : new Map<string, { price: number }>();
  const holdings = posRows.map((p) => {
    const current_price = prices.get(p.symbol)?.price ?? Number(p.avg_entry_price);
    return {
      symbol: p.symbol,
      qty: Number(p.qty),
      avg_entry_price: Number(p.avg_entry_price),
      current_price,
      market_value: Number(p.qty) * current_price,
    };
  });
  const positionsValue = holdings.reduce((sum, p) => sum + p.market_value, 0);
  const equity = Number(account.cash) + positionsValue;
  const performance = calculateInvestedPerformance(holdings);

  if (!isPublic) {
    // Name + headline return only — same as what the leaderboard already shows publicly.
    return NextResponse.json({
      account: { id: account.id, display_name: account.display_name, status: account.status, return_pct: performance.growth_pct },
      profile: { is_public: false },
      achievements: achievementsResult.error && isMissingTableError(achievementsResult.error) ? [] : achievementsResult.data ?? [],
      positions: [],
      orders: [],
      snapshots: [],
      private: true,
    });
  }

  return NextResponse.json({
    account: { ...account, equity, positions_value: positionsValue, return_pct: performance.growth_pct },
    performance,
    profile,
    achievements: achievementsResult.error && isMissingTableError(achievementsResult.error) ? [] : achievementsResult.data ?? [],
    positions: holdings,
    orders: orders ?? [],
    snapshots: snapshots ?? [],
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  const ctx = await getCurrentAccount(req);
  if ("response" in ctx) return ctx.response;
  const { accountId } = await params;
  if (ctx.account.id !== accountId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const risk = ["conservative", "balanced", "aggressive"].includes(String(body.risk_style)) ? String(body.risk_style) : "balanced";
  const { data, error } = await ctx.db
    .from("trader_profiles")
    .upsert({
      account_id: ctx.account.id,
      bio: String(body.bio ?? "").slice(0, 280) || null,
      strategy: String(body.strategy ?? "").slice(0, 280) || null,
      risk_style: risk,
      is_public: body.is_public !== false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id" })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: isMissingTableError(error) ? 501 : 500 });
  return NextResponse.json({ profile: data });
}

export const dynamic = "force-dynamic";
