import { mysqlAdmin } from "@/lib/mysql/admin";
import { randomUUID } from "node:crypto";
import { execute, query, transaction } from "@/lib/mysql";
import { fetchYahooPrices, getPrice } from "@/lib/prices";
import type { Order, Position, Account, OrderSide, OrderType } from "@/lib/types";

export interface PlaceOrderInput {
  account: Account;
  symbol: string;
  qty: number;
  side: OrderSide;
  type: OrderType;
  limit_price?: number;
  time_in_force?: "gtc" | "day" | "ioc";
  client_order_id?: string;
  scheduled_at?: string;
}

export interface PlaceOrderResult {
  ok: boolean;
  order?: Order;
  error?: string;
}

/**
 * Place an order. Market orders fill immediately; limit orders queue for the cron.
 * Cash & position checks happen up front (best-effort optimistic locking via DB checks).
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const db = mysqlAdmin();
  const symbol = input.symbol.toUpperCase();
  const qty = Number(input.qty);

  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: "qty must be > 0" };
  }
  if (input.type === "limit" && (!Number.isFinite(input.limit_price!) || input.limit_price! <= 0)) {
    return { ok: false, error: "limit_price required for limit orders" };
  }
  const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    return { ok: false, error: "scheduled_at must be a valid date" };
  }
  if (scheduledAt && input.type !== "limit") {
    return { ok: false, error: "scheduled orders must include a target limit price" };
  }
  const isFutureScheduled = scheduledAt ? scheduledAt.getTime() > Date.now() : false;

  const price = await getPrice(symbol, { forceLive: true });
  if (price == null) {
    return { ok: false, error: `unknown or untradable symbol: ${symbol}` };
  }

  // Pre-flight validation
  if (input.side === "buy") {
    const refPrice = input.type === "limit" ? Math.min(input.limit_price!, price) : price;
    const cost = qty * refPrice;
    if (cost > Number(input.account.cash) + 0.0001) {
      return { ok: false, error: `insufficient buying power (need $${cost.toFixed(2)}, have $${Number(input.account.cash).toFixed(2)})` };
    }
  } else {
    const { data: pos } = await db
      .from("positions")
      .select("qty")
      .eq("account_id", input.account.id)
      .eq("symbol", symbol)
      .maybeSingle();
    const heldQty = pos ? Number(pos.qty) : 0;
    if (heldQty < qty - 0.0001) {
      return { ok: false, error: `insufficient position (have ${heldQty}, want to sell ${qty})` };
    }
  }

  const baseOrderInsert = {
    account_id: input.account.id,
    symbol,
    qty,
    side: input.side,
    type: input.type,
    limit_price: input.type === "limit" ? input.limit_price : null,
    time_in_force: input.time_in_force ?? "gtc",
    status: "new",
    client_order_id: input.client_order_id ?? null,
  };

  let { data: orderRow, error: orderErr } = await db
    .from("orders")
    .insert({
      ...baseOrderInsert,
      scheduled_at: scheduledAt ? scheduledAt.toISOString() : null,
    })
    .select("*")
    .single();

  if (orderErr && isMissingScheduledAtError(orderErr.message)) {
    if (scheduledAt) {
      return { ok: false, error: "scheduled orders are unavailable until the database migration finishes" };
    }
    const retry = await db
      .from("orders")
      .insert(baseOrderInsert)
      .select("*")
      .single();
    orderRow = retry.data;
    orderErr = retry.error;
  }

  if (orderErr || !orderRow) {
    if ((orderErr?.code === "ER_DUP_ENTRY" || orderErr?.code === "23505") && input.client_order_id) {
      const { data: existing } = await db
        .from("orders")
        .select("*")
        .eq("account_id", input.account.id)
        .eq("client_order_id", input.client_order_id)
        .maybeSingle();
      if (existing) return { ok: true, order: existing as Order };
    }
    return { ok: false, error: orderErr?.message ?? "failed to create order" };
  }

  let final: Order = orderRow as Order;

  // Market orders fill immediately
  if (isFutureScheduled) {
    return { ok: true, order: final };
  }

  if (input.type === "market") {
    const filled = await fillOrder(final, price);
    if (!filled) {
      return { ok: false, error: "The market order could not be filled. Your account was not updated." };
    }
    final = filled;
  } else {
    // Limit orders that are immediately satisfiable should also fill now
    const fillable =
      (input.side === "buy" && price <= input.limit_price!) ||
      (input.side === "sell" && price >= input.limit_price!);
    if (fillable) {
      const filled = await fillOrder(final, price);
      if (!filled) {
        return { ok: false, error: "The limit order could not be filled. Your account was not updated." };
      }
      final = filled;
    }
  }

  return { ok: true, order: final };
}

/**
 * Execute a fill against an open order at the given price.
 * Atomically updates cash, position, fills, and the order row.
 */
export async function fillOrder(order: Order, price: number): Promise<Order | null> {
  if (!Number.isFinite(price) || price <= 0) return null;
  try {
    return await transaction(async (connection) => {
      const lockedOrder = (await query<Order>("SELECT * FROM orders WHERE id = ? FOR UPDATE", [order.id], connection))[0];
      if (!lockedOrder || lockedOrder.status !== "new") return null;
      const qty = Number(lockedOrder.qty);
      const notional = qty * price;
      const acct = (await query<Account>("SELECT * FROM accounts WHERE id = ? FOR UPDATE", [lockedOrder.account_id], connection))[0];
      if (!acct || acct.status !== "active") return null;
      const pos = (await query<Position>("SELECT * FROM positions WHERE account_id = ? AND symbol = ? FOR UPDATE", [acct.id, lockedOrder.symbol], connection))[0];
      const now = new Date().toISOString().slice(0, 23).replace("T", " ");

      if (lockedOrder.side === "buy") {
        if (notional > Number(acct.cash) + 0.0001) {
          await execute("UPDATE orders SET status = 'rejected', reject_reason = 'insufficient cash at fill time' WHERE id = ?", [order.id], connection);
          return null;
        }
        const newQty = (pos ? Number(pos.qty) : 0) + qty;
        const avgPrice = pos ? (Number(pos.qty) * Number(pos.avg_entry_price) + notional) / newQty : price;
        await execute("UPDATE accounts SET cash = cash - ? WHERE id = ?", [notional, acct.id], connection);
        if (pos) await execute("UPDATE positions SET qty = ?, avg_entry_price = ?, updated_at = ? WHERE id = ?", [newQty, avgPrice, now, pos.id], connection);
        else await execute("INSERT INTO positions (id, account_id, symbol, qty, avg_entry_price) VALUES (?, ?, ?, ?, ?)", [randomUUID(), acct.id, lockedOrder.symbol, newQty, avgPrice], connection);
      } else {
        if (!pos || Number(pos.qty) < qty - 0.0001) {
          await execute("UPDATE orders SET status = 'rejected', reject_reason = 'insufficient position at fill time' WHERE id = ?", [order.id], connection);
          return null;
        }
        const newQty = Number(pos.qty) - qty;
        await execute("UPDATE accounts SET cash = cash + ? WHERE id = ?", [notional, acct.id], connection);
        if (newQty <= 0.0001) await execute("DELETE FROM positions WHERE id = ?", [pos.id], connection);
        else await execute("UPDATE positions SET qty = ?, updated_at = ? WHERE id = ?", [newQty, now, pos.id], connection);
      }
      await execute("INSERT INTO fills (id, order_id, account_id, symbol, qty, price, side) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), order.id, acct.id, lockedOrder.symbol, qty, price, lockedOrder.side], connection);
      await execute("UPDATE orders SET status = 'filled', filled_qty = ?, filled_avg_price = ?, filled_at = ? WHERE id = ?", [qty, price, now, order.id], connection);
      return (await query<Order>("SELECT * FROM orders WHERE id = ?", [order.id], connection))[0] ?? null;
    });
  } catch (error) {
    console.error("fillOrder transaction failed", error);
    return null;
  }
}

/**
 * Run by hPanel cron: evaluate open limit orders and update equity.
 */
export async function tick(): Promise<{ filled: number; symbolsRefreshed: number; accountsUpdated: number }> {
  const db = mysqlAdmin();

  let { data: openOrders, error: openOrdersError } = await db
    .from("orders")
    .select("*")
    .eq("status", "new")
    .eq("type", "limit")
    .or(`scheduled_at.is.null,scheduled_at.lte.${new Date().toISOString()}`);

  if (openOrdersError && isMissingScheduledAtError(openOrdersError.message)) {
    const retry = await db
      .from("orders")
      .select("*")
      .eq("status", "new")
      .eq("type", "limit");
    openOrders = retry.data;
    openOrdersError = retry.error;
  }

  if (openOrdersError) {
    return { filled: 0, symbolsRefreshed: 0, accountsUpdated: 0 };
  }

  const orders = (openOrders as Order[] | null) ?? [];

  const { data: positions } = await db.from("positions").select("symbol");
  const posSymbols = ((positions as { symbol: string }[] | null) ?? []).map((p) => p.symbol);

  const allSymbols = Array.from(
    new Set([...orders.map((o) => o.symbol), ...posSymbols])
  );

  let symbolsRefreshed = 0;
  let pricesMap = new Map<string, { price: number; prevClose: number | null }>();

  if (allSymbols.length > 0) {
    const quotes = await fetchYahooPrices(allSymbols);
    for (const [s, q] of quotes) {
      pricesMap.set(s, { price: q.price, prevClose: q.prevClose });
      await db
        .from("prices")
        .upsert({
          symbol: s,
          price: q.price,
          prev_close: q.prevClose,
          updated_at: new Date().toISOString(),
        });
      symbolsRefreshed++;
    }
  }

  let filled = 0;
  for (const o of orders) {
    const p = pricesMap.get(o.symbol);
    if (!p) continue;
    const fillable =
      (o.side === "buy" && Number(o.limit_price) >= p.price) ||
      (o.side === "sell" && Number(o.limit_price) <= p.price);
    if (fillable) {
      const result = await fillOrder(o, p.price);
      if (result?.status === "filled") filled++;
    }
  }

  // Recompute equity for all accounts that have positions
  const { data: allAccounts } = await db.from("accounts").select("*").eq("status", "active");
  const accounts = (allAccounts as Account[] | null) ?? [];
  let accountsUpdated = 0;
  for (const a of accounts) {
    const { data: ap } = await db
      .from("positions")
      .select("symbol, qty")
      .eq("account_id", a.id);
    let posValue = 0;
    for (const p of (ap as { symbol: string; qty: number }[] | null) ?? []) {
      const pr = pricesMap.get(p.symbol);
      if (pr) posValue += Number(p.qty) * pr.price;
      else {
        // fall back to price table
        const { data: cached } = await db
          .from("prices")
          .select("price")
          .eq("symbol", p.symbol)
          .maybeSingle();
        if (cached) posValue += Number(p.qty) * Number(cached.price);
      }
    }
    const equity = Number(a.cash) + posValue;
    if (Math.abs(equity - Number(a.equity)) > 0.005) {
      await db.from("accounts").update({ equity }).eq("id", a.id);
      accountsUpdated++;
    }
  }

  return { filled, symbolsRefreshed, accountsUpdated };
}

/**
 * Take periodic snapshots of every active account's equity for chart history.
 */
export async function takeSnapshots(): Promise<number> {
  const db = mysqlAdmin();
  const { data: accounts } = await db.from("accounts").select("*").eq("status", "active");
  let n = 0;
  for (const a of (accounts as Account[] | null) ?? []) {
    const { data: ap } = await db.from("positions").select("symbol, qty").eq("account_id", a.id);
    let posValue = 0;
    for (const p of (ap as { symbol: string; qty: number }[] | null) ?? []) {
      const { data: cached } = await db
        .from("prices")
        .select("price")
        .eq("symbol", p.symbol)
        .maybeSingle();
      if (cached) posValue += Number(p.qty) * Number(cached.price);
    }
    const equity = Number(a.cash) + posValue;
    await db.from("equity_snapshots").insert({
      account_id: a.id,
      equity,
      cash: Number(a.cash),
      positions_value: posValue,
    });
    n++;
  }
  return n;
}

export async function cancelOrder(orderId: string, accountId: string): Promise<boolean> {
  const db = mysqlAdmin();
  const { data: order } = await db
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!order || order.status !== "new") return false;
  const { error } = await db
    .from("orders")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("id", orderId);
  return !error;
}

function isMissingScheduledAtError(message?: string | null) {
  return Boolean(message?.toLowerCase().includes("scheduled_at"));
}
