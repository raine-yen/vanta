// Settlement pass: when a tracked prediction market resolves on Polymarket
// (Gamma: closed=true, umaResolutionStatus="resolved", outcomePrices winner="1"),
// pay holders $1 per winning share / $0 for losers into the shared paper cash,
// zero the positions, and write 'settle' fills.
import { mysqlAdmin } from "@/lib/mysql/admin";
import { settlePayout } from "@/lib/prediction-math";
import type { FetchLike } from "@/lib/prediction-sync";

export interface SettleDb {
  from(table: string): any;
}

export interface SettleResult {
  marketsChecked: number;
  marketsResolved: number;
  payouts: number; // total cash credited to winners
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Winner ("yes"|"no") for a resolved Gamma market row, or null if not resolved. */
export function gammaWinner(row: { closed?: boolean; umaResolutionStatus?: string; outcomePrices?: string }): "yes" | "no" | null {
  if (!row.closed || row.umaResolutionStatus !== "resolved") return null;
  try {
    const prices = JSON.parse(row.outcomePrices ?? "[]") as string[];
    if (Number(prices[0]) === 1) return "yes";
    if (Number(prices[1]) === 1) return "no";
  } catch {
    /* fall through */
  }
  return null;
}

export async function settlePredictionMarkets(
  deps: { db?: SettleDb; fetchImpl?: FetchLike; accountId?: string } = {},
): Promise<SettleResult> {
  const db = deps.db ?? (mysqlAdmin() as unknown as SettleDb);
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Only markets someone actually holds can need settlement.
  let positionsQuery = db
    .from("prediction_positions")
    .select("*")
    .gt("shares", 0);
  if (deps.accountId) positionsQuery = positionsQuery.eq("account_id", deps.accountId);
  const { data: openPositions, error: posErr } = await positionsQuery;
  if (posErr) throw new Error(`positions lookup failed: ${posErr.message ?? "unknown"}`);

  const marketIds: string[] = [...new Set(((openPositions ?? []) as Array<{ market_id: string }>).map((p) => p.market_id))];
  const result: SettleResult = { marketsChecked: marketIds.length, marketsResolved: 0, payouts: 0 };
  if (marketIds.length === 0) return result;

  const { data: marketRows, error: marketError } = await db
    .from("prediction_markets")
    .select("id, condition_id")
    .in("id", marketIds);
  if (marketError) throw new Error(`markets lookup failed: ${marketError.message ?? "unknown"}`);
  const marketIdByCondition = new Map<string, string>();
  for (const market of marketRows ?? []) marketIdByCondition.set(market.condition_id ?? market.id, market.id);

  // Ask Gamma about these specific markets. Chunk to keep URLs sane.
  const resolved = new Map<string, "yes" | "no">();
  const conditionIds = Array.from(marketIdByCondition.keys());
  for (let i = 0; i < conditionIds.length; i += 20) {
    const chunk = conditionIds.slice(i, i + 20);
    const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=${chunk.length}&${chunk.map((id) => `condition_ids=${encodeURIComponent(id)}`).join("&")}`;
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" } });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<{ conditionId?: string } & Parameters<typeof gammaWinner>[0]>;
      for (const row of rows) {
        const winner = gammaWinner(row);
        if (row.conditionId && winner) {
          const internalId = marketIdByCondition.get(row.conditionId);
          if (internalId) resolved.set(internalId, winner);
        }
      }
    } catch {
      /* network blip — next pass retries */
    }
  }

  for (const [marketId, winner] of resolved) {
    const holders = (openPositions ?? []).filter(
      (p: { market_id: string; shares: number | string }) => p.market_id === marketId && Number(p.shares) > 0,
    );

    for (const pos of holders) {
      const shares = Number(pos.shares);
      const payout = settlePayout(shares, pos.outcome === winner);
      const { data: acct, error: aErr } = await db.from("accounts").select("*").eq("id", pos.account_id).maybeSingle();
      if (aErr || !acct) continue;
      const cashAfter = round2(Number(acct.cash) + payout);
      const { error: updErr } = await db.from("accounts").update({ cash: cashAfter }).eq("id", pos.account_id);
      if (updErr) continue;
      await db.from("prediction_positions").update({ shares: 0, updated_at: new Date().toISOString() }).eq("id", pos.id);
      await db.from("prediction_fills").insert({
        account_id: pos.account_id,
        market_id: marketId,
        outcome: pos.outcome,
        side: "settle",
        shares,
        price: pos.outcome === winner ? 1 : 0,
        total: payout,
        cash_after: cashAfter,
        client_order_id: `settle:${marketId}:${pos.account_id}:${pos.outcome}`,
      });
      result.payouts = round2(result.payouts + payout);
    }

    await db
      .from("prediction_markets")
      .update({ status: "resolved", resolved_outcome: winner, settled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", marketId);
    result.marketsResolved += 1;
  }

  return result;
}
