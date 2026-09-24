import { NextRequest, NextResponse } from "next/server";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { fetchYahooPrices } from "@/lib/prices";
import { getSessionUser } from "@/lib/session-user";
import { calculateInvestedPerformance } from "@/lib/performance";
import { rankForAccount, rankMovement, type RankMovement } from "@/lib/ranks";
import { getCurrentAccount } from "@/lib/app-data";

const RECOMPUTE_COOLDOWN_MS = 60_000;
const lastRecompute = new Map<string, number>();

interface StandingRow {
  account_id: string;
  competition_id: string;
  display_name: string;
  raw_display_name: string;
  equity: number;
  starting_cash: number;
  cost_basis: number;
  gain_amount: number;
  return_pct: number;
  score: number;
  invested_growth_pct: number;
  position: number;
  /** Internal-only: used to persist ranks/leader_history, stripped before the response goes out. */
  _tier: number;
  _tier_name: string;
  _division: number;
  _rank_points: number;
  _movement: RankMovement;
  _movement_amount: number;
}

async function recomputeRanks(competitionId: string, standings: StandingRow[]): Promise<void> {
  const db = mysqlAdmin();
  const now = Date.now();
  if (now - (lastRecompute.get(competitionId) ?? 0) < RECOMPUTE_COOLDOWN_MS) return;
  lastRecompute.set(competitionId, now);

  const { data: season } = await db
    .from("seasons")
    .select("id")
    .eq("competition_id", competitionId)
    .eq("status", "active")
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const seasonId = (season as { id: string } | null)?.id ?? null;

  // Previous snapshot (before this recompute) for movement deltas.
  const previousPositions = new Map<string, number>();
  if (standings.length > 0) {
    const ids = standings.map((s) => s.account_id);
    const { data: history } = await db
      .from("leader_history")
      .select("account_id, position")
      .in("account_id", ids)
      .order("recorded_at", { ascending: false })
      .limit(ids.length * 5);
    for (const row of (history ?? []) as { account_id: string; position: number }[]) {
      if (!previousPositions.has(row.account_id)) previousPositions.set(row.account_id, Number(row.position));
    }
  }

  for (const entry of standings) {
    const mv = rankMovement({ current: entry.position, previous: previousPositions.get(entry.account_id) ?? null });
    entry._movement = mv.movement;
    entry._movement_amount = mv.movementAmount;

    await db.from("leaderboard").upsert({
      account_id: entry.account_id,
      competition_id: competitionId,
      position: entry.position,
      equity: entry.equity,
      return_pct: entry.return_pct,
      score: entry.score,
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id" });

    await db.from("ranks").upsert(
      {
        account_id: entry.account_id,
        season_id: seasonId,
        tier: entry._tier,
        division: entry._division,
        rank_points: entry._rank_points,
        position_in_tier: entry.position,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "account_id,season_id" },
    );

    if (!previousPositions.has(entry.account_id) || previousPositions.get(entry.account_id) !== entry.position) {
      await db.from("leader_history").insert({
        account_id: entry.account_id,
        season_id: seasonId,
        position: entry.position,
        tier: entry._tier,
        division: entry._division,
        rank_points: entry._rank_points,
      });
    }
  }

  // Trim history to the latest 20 snapshots per account.
  const stale = await db
    .from("leader_history")
    .select("id, account_id")
    .in("account_id", standings.map((s) => s.account_id))
    .order("recorded_at", { ascending: false })
    .limit(500);
  const keep = new Map<string, number>();
  const dropIds: string[] = [];
  for (const row of (stale.data ?? []) as { id: string; account_id: string }[]) {
    const count = keep.get(row.account_id) ?? 0;
    if (count >= 20) dropIds.push(row.id);
    keep.set(row.account_id, count + 1);
  }
  if (dropIds.length > 0) await db.from("leader_history").delete().in("id", dropIds);
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const context = await getCurrentAccount(req);
  if ("response" in context) return context.response;
  const db = context.db;
  const viewerAccount = context.account;

  const accountQuery = db
    .from("accounts")
    .select("id, display_name, cash, starting_cash, competition_id, equity")
    .eq("status", "active")
    .eq("competition_id", viewerAccount.competition_id)
    .limit(100);

  const { data: accounts, error: acctErr } = await accountQuery;
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 });
  if (!accounts || accounts.length === 0) return NextResponse.json({ entries: [] });
  const scoringResult = await db.from("competitions").select("scoring_method").eq("id", viewerAccount.competition_id).maybeSingle();
  const scoringMethod = scoringResult.error ? "return_pct" : scoringResult.data?.scoring_method === "net_profit" ? "net_profit" : "return_pct";

  // Fetch all positions for these accounts (include avg_entry_price as price fallback)
  const accountIds = (accounts as { id: string }[]).map((a) => a.id);
  const { data: positions } = await db
    .from("positions")
    .select("account_id, symbol, qty, avg_entry_price")
    .in("account_id", accountIds);

  const posRows = (positions ?? []) as { account_id: string; symbol: string; qty: number; avg_entry_price: number }[];

  // Fetch live prices for all held symbols
  const symbols = Array.from(new Set(posRows.map((p) => p.symbol)));
  const priceMap = symbols.length > 0 ? await fetchYahooPrices(symbols) : new Map<string, { price: number }>();

  // Fall back to prices table for any missing symbols
  const missingSymbols = symbols.filter((s) => !priceMap.has(s));
  if (missingSymbols.length > 0) {
    const { data: cached } = await db.from("prices").select("symbol, price").in("symbol", missingSymbols);
    for (const row of (cached ?? []) as { symbol: string; price: number }[]) {
      priceMap.set(row.symbol, { price: Number(row.price) } as never);
    }
  }

  // Build account_id -> positions market value map
  // Falls back to avg_entry_price when live price is unavailable so equity never shows as just cash
  const positionsByAccount = new Map<string, Array<{ qty: number; avg_entry_price: number; current_price: number }>>();
  for (const p of posRows) {
    const priceData = priceMap.get(p.symbol) as { price: number } | undefined;
    const price = priceData ? priceData.price : Number(p.avg_entry_price);
    positionsByAccount.set(p.account_id, [
      ...(positionsByAccount.get(p.account_id) ?? []),
      { qty: Number(p.qty), avg_entry_price: Number(p.avg_entry_price), current_price: price },
    ]);
  }

  type AccountRow = {
    id: string;
    display_name: string;
    cash: number;
    starting_cash: number;
    competition_id: string;
  };

  const duplicateNameCounts = new Map<string, number>();
  for (const a of accounts as AccountRow[]) {
    const key = a.display_name.trim().toLowerCase();
    duplicateNameCounts.set(key, (duplicateNameCounts.get(key) ?? 0) + 1);
  }

  // Live equity; primary sort metric is PORTFOLIO-RELATIVE return against the
  // account's own starting capital (never a fixed 10k assumption and never
  // invested-cost-basis growth, which leaves cash-heavy traders unrankable).
  const standings: StandingRow[] = (accounts as AccountRow[])
    .map((a) => {
      const performance = calculateInvestedPerformance(positionsByAccount.get(a.id) ?? []);
      const posValue = performance.market_value;
      const liveEquity = Number(a.cash) + posValue;
      const rank = rankForAccount({ equity: liveEquity, startingCash: Number(a.starting_cash) });
      const duplicateName = (duplicateNameCounts.get(a.display_name.trim().toLowerCase()) ?? 0) > 1;
      const safeSuffix = a.id.replace(/-/g, "").slice(0, 4).toUpperCase();
      return {
        account_id: a.id,
        competition_id: a.competition_id,
        display_name: duplicateName ? `${a.display_name} #${safeSuffix}` : a.display_name,
        raw_display_name: a.display_name,
        equity: liveEquity,
        starting_cash: Number(a.starting_cash),
        cost_basis: performance.cost_basis,
        gain_amount: performance.gain_amount,
        return_pct: rank.returnPct,
        score: scoringMethod === "net_profit" ? liveEquity - Number(a.starting_cash) : rank.returnPct,
        invested_growth_pct: performance.growth_pct,
        position: 0,
        _tier: rank.tier,
        _tier_name: rank.tierName,
        _division: rank.division,
        _rank_points: rank.rankPoints,
        _movement: "new" as RankMovement,
        _movement_amount: 0,
      };
    })
    .sort((a, b) => b.score - a.score);

  standings.forEach((entry, index) => {
    entry.position = index + 1;
  });

  try {
    await recomputeRanks(viewerAccount.competition_id as string, standings);
  } catch {
    // Rank persistence is best-effort: the board must still render if writes fail.
  }

  // Public leaderboard is intentionally lean: no tier/division/movement here.
  // Those live behind the dedicated GET /api/rank drill-in (tap-to-open icon),
  // per product decision — the list itself must not show rank badges.
  const entries = standings.map(({ _tier, _tier_name, _division, _rank_points, _movement, _movement_amount, ...rest }) => rest);

  return NextResponse.json({ entries, scoring_method: scoringMethod });
}

export const dynamic = "force-dynamic";
