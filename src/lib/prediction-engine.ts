// Paper prediction trading engine. Follows src/lib/engine.ts conventions:
// service-role db handle, explicit cash checks, idempotency via client_order_id.
import { mysqlAdmin } from "@/lib/mysql/admin";
import { fetchUpstreamPredictionMarketState, liveMidpoint, type PredictionMarketRow } from "@/lib/prediction-sync";
import {
  isOutcome,
  quoteBuy,
  quoteSell,
  round2,
  type Outcome,
} from "@/lib/prediction-math";

export interface PredictionEngineDb {
  from(table: string): any;
}

export interface PredictionBuyInput {
  accountId: string;
  marketId: string;
  outcome: string;
  stakeUsd: number;
  clientOrderId?: string;
}

export type EngineResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export interface BuyResult {
  shares: number;
  cost: number;
  price: number;
  cash_after: number;
  duplicate: boolean;
}

export interface EngineDeps {
  db?: PredictionEngineDb;
  fetchImpl?: typeof fetch;
}

/** Buy whole outcome shares for a dollar stake against the shared paper cash. */
export async function buyPredictionShares(input: PredictionBuyInput, deps: EngineDeps = {}): Promise<EngineResult<BuyResult>> {
  const db = (deps.db ?? (mysqlAdmin() as unknown as PredictionEngineDb));
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!isOutcome(input.outcome)) return { ok: false, error: "outcome must be yes or no" };
  const outcome = input.outcome;

  // Idempotent replay (double-submit guard), mirrors placeOrder().
  if (input.clientOrderId) {
    const { data: existing } = await db
      .from("prediction_fills")
      .select("*")
      .eq("account_id", input.accountId)
      .eq("client_order_id", input.clientOrderId)
      .maybeSingle();
    if (existing) {
      return {
        ok: true,
        result: {
          shares: Number(existing.shares),
          cost: Number(existing.total),
          price: Number(existing.price),
          cash_after: Number(existing.cash_after),
          duplicate: true,
        },
      };
    }
  }

  const { data: market, error: mErr } = await db
    .from("prediction_markets")
    .select("*")
    .eq("id", input.marketId)
    .maybeSingle();
  if (mErr) return { ok: false, error: mErr.message ?? "market lookup failed" };
  if (!market) return { ok: false, error: "market not found" };
  if (market.status !== "active") return { ok: false, error: "market is not active" };

  const row = market as PredictionMarketRow;
  const upstream = await fetchUpstreamPredictionMarketState(row, fetchImpl);
  if (!upstream) return { ok: false, error: "market status could not be verified; try again shortly" };
  if (!upstream.tradable) {
    await db.from("prediction_markets").update({
      status: upstream.resolved ? "resolved" : "closed",
      resolved_outcome: upstream.resolvedOutcome,
      updated_at: new Date().toISOString(),
    }).eq("id", input.marketId);
    return { ok: false, error: upstream.resolved ? "market resolved; trading is closed" : "market closed; trading is unavailable" };
  }
  const tokenId = outcome === "yes" ? row.yes_token_id : row.no_token_id;
  const fallback = outcome === "yes" ? row.yes_price : row.no_price;
  const price = await liveMidpoint(tokenId, fetchImpl, fallback);
  if (price == null || price <= 0 || price >= 1) {
    return { ok: false, error: "no live price for this outcome" };
  }

  const q = quoteBuy(input.stakeUsd, price);
  if (!q.ok || q.shares == null || q.shares <= 0) return { ok: false, error: q.error ?? "stake too small for this price" };

  const { data: acct, error: aErr } = await db
    .from("accounts")
    .select("cash")
    .eq("id", input.accountId)
    .single();
  if (aErr || !acct) return { ok: false, error: "account not found" };
  const cashBefore = Number(acct.cash);
  if (q.cost! > cashBefore + 0.0001) {
    return { ok: false, error: `insufficient buying power (need $${q.cost!.toFixed(2)}, have $${cashBefore.toFixed(2)})` };
  }
  const cashAfter = round2(cashBefore - q.cost!);

  const { data: pos } = await db
    .from("prediction_positions")
    .select("*")
    .eq("account_id", input.accountId)
    .eq("market_id", input.marketId)
    .eq("outcome", outcome)
    .maybeSingle();

  const heldShares = pos ? Number(pos.shares) : 0;
  const heldCost = pos ? Number(pos.avg_cost) : 0;
  const newShares = round2(heldShares + q.shares);
  const avgCost = round2((heldShares * heldCost + q.shares * price) / newShares);

  if (pos) {
    const { error } = await db
      .from("prediction_positions")
      .update({ shares: newShares, avg_cost: avgCost, updated_at: new Date().toISOString() })
      .eq("id", pos.id);
    if (error) return { ok: false, error: error.message ?? "position update failed" };
  } else {
    const { error } = await db
      .from("prediction_positions")
      .insert({
        account_id: input.accountId,
        market_id: input.marketId,
        outcome,
        shares: q.shares,
        avg_cost: price,
      });
    if (error) return { ok: false, error: error.message ?? "position insert failed" };
  }

  const { error: cErr } = await db
    .from("accounts")
    .update({ cash: cashAfter })
    .eq("id", input.accountId);
  if (cErr) return { ok: false, error: cErr.message ?? "cash update failed" };

  const { error: fErr } = await db.from("prediction_fills").insert({
    account_id: input.accountId,
    market_id: input.marketId,
    outcome,
    side: "buy",
    shares: q.shares,
    price,
    total: q.cost,
    cash_after: cashAfter,
    client_order_id: input.clientOrderId ?? null,
  });
  if (fErr) {
    // Roll back position AND cash so a failed/rejected fill stays consistent.
    const rollbackShares = round2(newShares - q.shares);
    await db
      .from("prediction_positions")
      .update({
        shares: rollbackShares,
        avg_cost: rollbackShares > 0 ? heldCost : 0,
        updated_at: new Date().toISOString(),
      })
      .eq("account_id", input.accountId)
      .eq("market_id", input.marketId)
      .eq("outcome", outcome);
    await db.from("accounts").update({ cash: cashBefore }).eq("id", input.accountId);
    return { ok: false, error: fErr.message ?? "fill insert failed" };
  }

  return { ok: true, result: { shares: q.shares, cost: q.cost!, price, cash_after: cashAfter, duplicate: false } };
}

export interface PredictionSellInput {
  accountId: string;
  marketId: string;
  outcome: string;
  shares?: number; // omitted when closeAll
  closeAll?: boolean;
  clientOrderId?: string;
}

export interface SellResult {
  shares: number;
  proceeds: number;
  realizedPnl: number;
  cash_after: number;
  closed: boolean;
  duplicate: boolean;
}

/**
 * Close-early sell at the live market price (Polymarket/Robinhood behavior):
 * any amount or all shares; proceeds credited to the shared paper cash.
 */
export async function sellPredictionShares(input: PredictionSellInput, deps: EngineDeps = {}): Promise<EngineResult<SellResult>> {
  const db = (deps.db ?? (mysqlAdmin() as unknown as PredictionEngineDb));
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!isOutcome(input.outcome)) return { ok: false, error: "outcome must be yes or no" };
  const outcome = input.outcome;

  if (input.clientOrderId) {
    const { data: existing } = await db
      .from("prediction_fills")
      .select("*")
      .eq("account_id", input.accountId)
      .eq("client_order_id", input.clientOrderId)
      .maybeSingle();
    if (existing) {
      return {
        ok: true,
        result: {
          shares: Number(existing.shares),
          proceeds: Number(existing.total),
          realizedPnl: 0,
          cash_after: Number(existing.cash_after),
          closed: false,
          duplicate: true,
        },
      };
    }
  }

  const { data: pos, error: pErr } = await db
    .from("prediction_positions")
    .select("*")
    .eq("account_id", input.accountId)
    .eq("market_id", input.marketId)
    .eq("outcome", outcome)
    .maybeSingle();
  if (pErr) return { ok: false, error: pErr.message ?? "position lookup failed" };
  if (!pos || Number(pos.shares) <= 0) return { ok: false, error: "no open position to sell" };

  const heldShares = Number(pos.shares);
  const avgCost = Number(pos.avg_cost);
  const shares = input.closeAll ? heldShares : Number(input.shares);

  const { data: market } = await db
    .from("prediction_markets")
    .select("*")
    .eq("id", input.marketId)
    .maybeSingle();
  if (!market) return { ok: false, error: "market not found" };
  if (market.status === "resolved") return { ok: false, error: "market already resolved; awaiting settlement" };

  const row = market as PredictionMarketRow;
  const upstream = await fetchUpstreamPredictionMarketState(row, fetchImpl);
  if (!upstream) return { ok: false, error: "market status could not be verified; try again shortly" };
  if (!upstream.tradable) {
    await db.from("prediction_markets").update({
      status: upstream.resolved ? "resolved" : "closed",
      resolved_outcome: upstream.resolvedOutcome,
      updated_at: new Date().toISOString(),
    }).eq("id", input.marketId);
    return { ok: false, error: upstream.resolved ? "market resolved; awaiting settlement" : "market closed; trading is unavailable" };
  }
  const tokenId = outcome === "yes" ? row.yes_token_id : row.no_token_id;
  const fallback = outcome === "yes" ? row.yes_price : row.no_price;
  const price = await liveMidpoint(tokenId, fetchImpl, fallback);
  if (price == null) return { ok: false, error: "no live price for this outcome" };

  const q = quoteSell(shares, avgCost, price, heldShares);
  if (!q.ok) return { ok: false, error: q.error ?? "sell rejected" };

  const { data: acct } = await db.from("accounts").select("cash").eq("id", input.accountId).single();
  if (!acct) return { ok: false, error: "account not found" };
  const cashAfter = round2(Number(acct.cash) + q.proceeds!);
  const remaining = round2(heldShares - shares);

  const { error: posErr } = await db
    .from("prediction_positions")
    .update({ shares: remaining, avg_cost: remaining > 0 ? avgCost : 0, updated_at: new Date().toISOString() })
    .eq("id", pos.id);
  if (posErr) return { ok: false, error: posErr.message ?? "position update failed" };

  const { error: cErr } = await db.from("accounts").update({ cash: cashAfter }).eq("id", input.accountId);
  if (cErr) return { ok: false, error: cErr.message ?? "cash update failed" };

  const { error: fErr } = await db.from("prediction_fills").insert({
    account_id: input.accountId,
    market_id: input.marketId,
    outcome,
    side: "sell",
    shares,
    price,
    total: q.proceeds,
    cash_after: cashAfter,
    client_order_id: input.clientOrderId ?? null,
  });
  if (fErr) {
    await db.from("accounts").update({ cash: Number(acct.cash) }).eq("id", input.accountId);
    return { ok: false, error: fErr.message ?? "fill insert failed" };
  }

  return {
    ok: true,
    result: { shares, proceeds: q.proceeds!, realizedPnl: q.realizedPnl!, cash_after: cashAfter, closed: remaining <= 0, duplicate: false },
  };
}
