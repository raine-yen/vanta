import { NextRequest, NextResponse } from "next/server";
import { mysqlForRequest } from "@/lib/mysql/request";
import { fetchYahooPrices } from "@/lib/prices";
import { getSessionUser } from "@/lib/session-user";
import { getSelectedCompetitionAccount, isMissingTableError } from "@/lib/app-data";
import { calculateInvestedPerformance } from "@/lib/performance";
import { ensurePaperAccount } from "@/lib/ensure-paper-account";
import { portfolioReturnPct } from "@/lib/ranks";
import { liveMidpoint, type PredictionMarketRow } from "@/lib/prediction-sync";

// Authenticated dashboard endpoint — returns the current user's account, positions, recent orders.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = await mysqlForRequest(req);

  try {
    await ensurePaperAccount(user, db);
  } catch (provisionError) {
    return NextResponse.json(
      { error: provisionError instanceof Error ? provisionError.message : "Could not activate your paper account." },
      { status: 500 }
    );
  }

  const { data: account } = await getSelectedCompetitionAccount(db, user.id, req.cookies.get("vanta_competition")?.value);

  if (!account) return NextResponse.json({ account: null });

  const [
    { data: positions },
    { data: orders },
    { data: fills },
    { data: snapshots },
    watchlistResult,
    alertsResult,
    profileResult,
    messagesResult,
    { data: predictionPositions },
    { data: predictionFills },
  ] = await Promise.all([
    db.from("positions").select("*").eq("account_id", account.id),
    db
      .from("orders")
      .select("*")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(25),
    db
      .from("fills")
      .select("*")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(25),
    db
      .from("equity_snapshots")
      .select("equity, created_at")
      .eq("account_id", account.id)
      .order("created_at", { ascending: true })
      .limit(500),
    db.from("watchlists").select("id, symbol, note, created_at").eq("account_id", account.id).order("created_at", { ascending: false }).limit(12),
    db.from("price_alerts").select("id, symbol, direction, target_price, move_pct, status, created_at").eq("account_id", account.id).neq("status", "deleted").order("created_at", { ascending: false }).limit(12),
    db.from("trader_profiles").select("*").eq("account_id", account.id).maybeSingle(),

    db.from("direct_messages").select("id").eq("recipient_account_id", account.id).is("read_at", null).eq("hidden_by_admin", false),
    db.from("prediction_positions").select("*").eq("account_id", account.id).gt("shares", 0),
    db
      .from("prediction_fills")
      .select("*")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const symbols = (positions ?? []).map((p: { symbol: string }) => p.symbol);
  const priceMap = await fetchYahooPrices(symbols);

  const positionsWithMarket = (positions ?? []).map((p: { symbol: string; qty: number; avg_entry_price: number; id: string }) => {
    const cp = priceMap.get(p.symbol)?.price ?? Number(p.avg_entry_price);
    const marketValue = Number(p.qty) * cp;
    const costBasis = Number(p.qty) * Number(p.avg_entry_price);
    const unrealizedPL = marketValue - costBasis;
    return {
      ...p,
      current_price: cp,
      market_value: marketValue,
      cost_basis: costBasis,
      unrealized_pl: unrealizedPL,
      unrealized_plpc: costBasis === 0 ? 0 : (unrealizedPL / costBasis) * 100,
    };
  });

  const positionsValue = positionsWithMarket.reduce((s: number, p: { market_value: number }) => s + p.market_value, 0);

  // Enrich prediction positions with a live CLOB midpoint (fallback to the
  // persisted catalog price), matching how /api/prediction-markets prices them.
  const predMarketIds = Array.from(new Set((predictionPositions ?? []).map((p: { market_id: string }) => p.market_id)));
  const predMarketRows = predMarketIds.length
    ? (await db.from("prediction_markets").select("*").in("id", predMarketIds)).data ?? []
    : [];
  const predMarketById = new Map((predMarketRows as PredictionMarketRow[]).map((m) => [m.id, m]));
  const predictionPositionsWithMarket = await Promise.all(
    (predictionPositions ?? []).map(async (p: { id: string; market_id: string; outcome: string; shares: number; avg_cost: number }) => {
      const market = predMarketById.get(p.market_id);
      const tokenId = (p.outcome === "yes" ? market?.yes_token_id : market?.no_token_id) ?? null;
      const fallback = (p.outcome === "yes" ? market?.yes_price : market?.no_price) ?? null;
      const price = (await liveMidpoint(tokenId, fetch, fallback)) ?? Number(p.avg_cost);
      const shares = Number(p.shares);
      const marketValue = shares * price;
      const costBasis = shares * Number(p.avg_cost);
      return {
        ...p,
        question: market?.question ?? null,
        current_price: price,
        market_value: marketValue,
        cost_basis: costBasis,
        unrealized_pl: marketValue - costBasis,
      };
    }),
  );
  const predictionPositionsValue = predictionPositionsWithMarket.reduce((s, p) => s + p.market_value, 0);

  const equity = Number(account.cash) + positionsValue + predictionPositionsValue;
  const performance = calculateInvestedPerformance(positionsWithMarket);
  const leaderboard = await db
    .from("accounts")
    .select("id, cash, starting_cash, status")
    .eq("competition_id", account.competition_id)
    .eq("status", "active");
  const accountIds = ((leaderboard.data ?? []) as Array<{ id: string }>).map((a) => a.id);
  const rankPositions = accountIds.length
    ? await db.from("positions").select("account_id, symbol, qty, avg_entry_price").in("account_id", accountIds)
    : { data: [] };
  const rankSymbols = Array.from(new Set(((rankPositions.data ?? []) as Array<{ symbol: string }>).map((p) => p.symbol)));
  const rankPrices = rankSymbols.length ? await fetchYahooPrices(rankSymbols) : new Map<string, { price: number }>();
  const positionValueByAccount = new Map<string, number>();
  const positionCostByAccount = new Map<string, number>();
  for (const p of (rankPositions.data ?? []) as Array<{ account_id: string; symbol: string; qty: number; avg_entry_price: number }>) {
    const price = rankPrices.get(p.symbol)?.price ?? Number(p.avg_entry_price);
    positionValueByAccount.set(p.account_id, (positionValueByAccount.get(p.account_id) ?? 0) + Number(p.qty) * price);
    positionCostByAccount.set(p.account_id, (positionCostByAccount.get(p.account_id) ?? 0) + Number(p.qty) * Number(p.avg_entry_price));
  }
  const ranked = ((leaderboard.data ?? []) as Array<{ id: string; cash: number; starting_cash: number }>).map((row) => {
    const liveEquity = Number(row.cash) + (positionValueByAccount.get(row.id) ?? 0);
    return {
      id: row.id,
      equity: liveEquity,
      // Portfolio-relative: measured against the account's own starting capital.
      return_pct: portfolioReturnPct({ equity: liveEquity, startingCash: Number(row.starting_cash) }),
    };
  }).sort((a, b) => b.return_pct - a.return_pct);
  const rankIndex = ranked.findIndex((row) => row.id === account.id);

  return NextResponse.json({
    user: { id: user.id, email: user.email },
    is_admin: user.role === "owner" || user.role === "manager",
    account: { ...account, equity, positions_value: positionsValue, prediction_positions_value: predictionPositionsValue },
    performance,
    positions: positionsWithMarket,
    orders: orders ?? [],
    fills: fills ?? [],
    snapshots: snapshots ?? [],
    watchlist: watchlistResult.error && isMissingTableError(watchlistResult.error) ? [] : watchlistResult.data ?? [],
    alerts: alertsResult.error && isMissingTableError(alertsResult.error) ? [] : alertsResult.data ?? [],
    profile: profileResult.error && isMissingTableError(profileResult.error) ? null : profileResult.data ?? null,
    unread_messages: messagesResult.error && isMissingTableError(messagesResult.error) ? 0 : messagesResult.data?.length ?? 0,
    prediction_positions: predictionPositionsWithMarket,
    prediction_positions_value: predictionPositionsValue,
    prediction_fills: predictionFills ?? [],
    competition: {
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
      participants: ranked.length,
      return_pct: ranked[rankIndex]?.return_pct ?? performance.growth_pct,
    },
  });
}

export const dynamic = "force-dynamic";
