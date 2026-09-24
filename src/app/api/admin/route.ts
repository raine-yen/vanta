import { NextRequest, NextResponse } from "next/server";
import { fetchYahooPrices } from "@/lib/prices";
import { getSessionUser } from "@/lib/session-user";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { isMissingTableError } from "@/lib/app-data";
import { calculateInvestedPerformance } from "@/lib/performance";
import { ensureAllPaperAccounts } from "@/lib/ensure-paper-account";

async function verifyAdmin(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user || (user.role !== "owner" && user.role !== "manager")) return null;
  return user;
}

type ManagedAccount = { id: string; user_id: string };

async function permanentlyDeleteUserAccount(db: ReturnType<typeof mysqlAdmin>, account: ManagedAccount) {
  const [{ error: positionError }, { error: predictionPositionError }, { error: predictionFillError }, { error: orderError }] = await Promise.all([
    db.from("positions").delete().eq("account_id", account.id),
    db.from("prediction_positions").delete().eq("account_id", account.id),
    db.from("prediction_fills").delete().eq("account_id", account.id),
    db.from("orders").delete().eq("account_id", account.id),
  ]);
  const cleanupError = positionError ?? predictionPositionError ?? predictionFillError ?? orderError;
  if (cleanupError) throw new Error(cleanupError.message);
  const { error: accountError } = await db.from("accounts").delete().eq("id", account.id);
  if (accountError) throw new Error(accountError.message);
  const { error: userError } = await db.auth.admin.deleteUser(account.user_id);
  if (userError) throw new Error(userError.message);
}

export async function GET(req: NextRequest) {
  const user = await verifyAdmin(req);
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const db = mysqlAdmin();
  try {
    await ensureAllPaperAccounts();
  } catch (provisionError) {
    return NextResponse.json(
      { error: provisionError instanceof Error ? provisionError.message : "Could not activate paper accounts." },
      { status: 500 }
    );
  }

  const [{ data: accounts }, { data: { users } }, reportsResult, blocksResult] = await Promise.all([
    db.from("accounts").select("*").order("equity", { ascending: false }),
    db.auth.admin.listUsers({ perPage: 1000 }),
    db.from("message_reports").select("*, direct_messages(*)").order("created_at", { ascending: false }).limit(50),
    db.from("blocked_users").select("*").order("created_at", { ascending: false }).limit(50),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u.email ?? "unknown"]));

  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id);

  const [{ data: allPositions }, { data: allOrders }] = await Promise.all([
    db.from("positions").select("account_id, symbol, qty, avg_entry_price").in("account_id", accountIds),
    db.from("orders").select("account_id, status").in("account_id", accountIds),
  ]);

  const posRows = (allPositions ?? []) as Array<{
    account_id: string;
    symbol: string;
    qty: number;
    avg_entry_price: number;
  }>;
  const symbols = Array.from(new Set(posRows.map((p) => p.symbol)));
  const priceMap = symbols.length > 0 ? await fetchYahooPrices(symbols) : new Map<string, { price: number }>();

  const missingSymbols = symbols.filter((s) => !priceMap.has(s));
  if (missingSymbols.length > 0) {
    const { data: cached } = await db.from("prices").select("symbol, price").in("symbol", missingSymbols);
    for (const row of (cached ?? []) as { symbol: string; price: number }[]) {
      priceMap.set(row.symbol, { price: Number(row.price) } as never);
    }
  }

  const posCountMap = new Map<string, number>();
  const posValueMap = new Map<string, number>();
  const positionsByAccount = new Map<string, Array<{
    symbol: string;
    qty: number;
    avg_entry_price: number;
    current_price: number;
    market_value: number;
  }>>();
  for (const p of posRows) {
    posCountMap.set(p.account_id, (posCountMap.get(p.account_id) ?? 0) + 1);
    const livePrice = (priceMap.get(p.symbol) as { price: number } | undefined)?.price ?? Number(p.avg_entry_price);
    const marketValue = Number(p.qty) * livePrice;
    posValueMap.set(p.account_id, (posValueMap.get(p.account_id) ?? 0) + marketValue);
    positionsByAccount.set(p.account_id, [
      ...(positionsByAccount.get(p.account_id) ?? []),
      {
        symbol: p.symbol,
        qty: Number(p.qty),
        avg_entry_price: Number(p.avg_entry_price),
        current_price: livePrice,
        market_value: marketValue,
      },
    ]);
  }

  const orderCountMap = new Map<string, number>();
  for (const o of allOrders ?? []) {
    orderCountMap.set(o.account_id, (orderCountMap.get(o.account_id) ?? 0) + 1);
  }

  type RawAccount = { id: string; user_id: string; cash: number; equity: number; starting_cash: number; [k: string]: unknown };

  const enriched = (accounts ?? []).map((a: RawAccount) => {
    const accountPositions = positionsByAccount.get(a.id) ?? [];
    const performance = calculateInvestedPerformance(accountPositions);
    const positionsValue = posValueMap.get(a.id) ?? 0;
    const liveEquity = Number(a.cash) + positionsValue;
    return {
      ...a,
      email: userMap.get(a.user_id) ?? "unknown",
      equity: liveEquity,
      positions_value: positionsValue,
      positions: accountPositions,
      position_count: posCountMap.get(a.id) ?? 0,
      order_count: orderCountMap.get(a.id) ?? 0,
      return_pct: performance.growth_pct,
    };
  });

  const totalEquity = enriched.reduce((s: number, a: { equity: number }) => s + Number(a.equity), 0);
  const avgReturn = enriched.length > 0 ? enriched.reduce((s: number, a: { return_pct: number }) => s + a.return_pct, 0) / enriched.length : 0;
  const totalOrders = allOrders?.length ?? 0;

  return NextResponse.json({
    admin_user_id: user.id,
    accounts: enriched,
    stats: {
      total_users: enriched.length,
      total_orders: totalOrders,
      total_equity: totalEquity,
      avg_return_pct: avgReturn,
      open_reports: reportsResult.error && isMissingTableError(reportsResult.error) ? 0 : (reportsResult.data ?? []).filter((r: { status: string }) => r.status === "open").length,
    },
    moderation: {
      reports: reportsResult.error && isMissingTableError(reportsResult.error) ? [] : reportsResult.data ?? [],
      blocks: blocksResult.error && isMissingTableError(blocksResult.error) ? [] : blocksResult.data ?? [],
    },
  });
}

export async function POST(req: NextRequest) {
  const user = await verifyAdmin(req);
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const db = mysqlAdmin();
  const body = await req.json();
  const { action, account_id } = body as { action: string; account_id: string; amount?: number };
  if (["delete_user", "delete_users", "reset", "adjust_cash"].includes(action) && user.role !== "owner") {
    return NextResponse.json({ error: "owner role required" }, { status: 403 });
  }

  if (action === "hide_message") {
    const { message_id } = body as { message_id?: string };
    if (!message_id) return NextResponse.json({ error: "message_id required" }, { status: 400 });
    const { error } = await db.from("direct_messages").update({ hidden_by_admin: true }).eq("id", message_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await db.from("message_reports").update({ status: "reviewed", reviewed_at: new Date().toISOString() }).eq("message_id", message_id);
    return NextResponse.json({ ok: true, message: "Message hidden" });
  }

  if (action === "dismiss_report") {
    const { report_id } = body as { report_id?: string };
    if (!report_id) return NextResponse.json({ error: "report_id required" }, { status: 400 });
    const { error } = await db.from("message_reports").update({ status: "dismissed", reviewed_at: new Date().toISOString() }).eq("id", report_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, message: "Report dismissed" });
  }

  if (action === "delete_users") {
    const rawAccountIds: unknown[] = Array.isArray(body.account_ids) ? body.account_ids : [];
    const accountIds = Array.from(new Set(rawAccountIds.filter((id): id is string => typeof id === "string"))).slice(0, 100);
    if (accountIds.length === 0) return NextResponse.json({ error: "select at least one account" }, { status: 400 });
    const { data: accounts } = await db.from("accounts").select("id, user_id").in("id", accountIds);
    if (!accounts || accounts.length !== accountIds.length) return NextResponse.json({ error: "one or more accounts were not found" }, { status: 404 });
    if (accounts.some((account: { user_id: string }) => account.user_id === user.id)) {
      return NextResponse.json({ error: "cannot delete your own admin account" }, { status: 400 });
    }

    let deleted = 0;
    for (const account of accounts as ManagedAccount[]) {
      try {
        await permanentlyDeleteUserAccount(db, account);
        deleted += 1;
      } catch (error) {
        return NextResponse.json({ error: `Deleted ${deleted} account(s) before the batch stopped: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 500 });
      }
    }
    return NextResponse.json({ ok: true, message: `${deleted} user${deleted === 1 ? "" : "s"} and their paper data permanently removed` });
  }

  if (!account_id) return NextResponse.json({ error: "account_id required" }, { status: 400 });

  const { data: account } = await db.from("accounts").select("*").eq("id", account_id).maybeSingle();
  if (!account) return NextResponse.json({ error: "account not found" }, { status: 404 });

  if (action === "reset") {
    const [{ error: stockPositionError }, { error: predictionPositionError }, { error: predictionFillError }, { error: orderError }] = await Promise.all([
      db.from("positions").delete().eq("account_id", account_id),
      db.from("prediction_positions").delete().eq("account_id", account_id),
      db.from("prediction_fills").delete().eq("account_id", account_id),
      db
        .from("orders")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("account_id", account_id)
        .eq("status", "new"),
    ]);
    const resetError = stockPositionError ?? predictionPositionError ?? predictionFillError ?? orderError;
    if (resetError) return NextResponse.json({ error: resetError.message }, { status: 500 });
    const { error: accountError } = await db
      .from("accounts")
      .update({ cash: account.starting_cash, equity: account.starting_cash })
      .eq("id", account_id);
    if (accountError) return NextResponse.json({ error: accountError.message }, { status: 500 });
    return NextResponse.json({ ok: true, message: "All stock and prediction assets reset to starting cash" });
  }

  if (action === "close_position") {
    const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9./-]{1,16}$/.test(symbol)) {
      return NextResponse.json({ error: "valid symbol required" }, { status: 400 });
    }
    const { data: position } = await db
      .from("positions")
      .select("symbol, qty, avg_entry_price")
      .eq("account_id", account_id)
      .eq("symbol", symbol)
      .maybeSingle();
    if (!position) return NextResponse.json({ error: "position not found" }, { status: 404 });

    const price = (await fetchYahooPrices([symbol])).get(symbol)?.price ?? Number(position.avg_entry_price);
    const proceeds = Number(position.qty) * Number(price);
    const nextCash = Number(account.cash) + proceeds;
    const { error: cashError } = await db.from("accounts").update({ cash: nextCash }).eq("id", account_id);
    if (cashError) return NextResponse.json({ error: cashError.message }, { status: 500 });
    const { error: positionError } = await db.from("positions").delete().eq("account_id", account_id).eq("symbol", symbol);
    if (positionError) {
      await db.from("accounts").update({ cash: Number(account.cash) }).eq("id", account_id);
      return NextResponse.json({ error: positionError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, message: `${symbol} closed and ${proceeds.toFixed(2)} credited to cash` });
  }

  if (action === "disable") {
    const { error } = await db.from("accounts").update({ status: "disabled", suspended_until: null }).eq("id", account_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, message: "Account disabled" });
  }

  if (action === "timeout") {
    const { duration_minutes } = body as { duration_minutes?: number };
    const durationMinutes = Number(duration_minutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 43200) {
      return NextResponse.json({ error: "duration_minutes must be an integer from 1 to 43200" }, { status: 400 });
    }
    const suspendedUntil = new Date(Date.now() + durationMinutes * 60_000).toISOString();
    const { error } = await db.from("accounts").update({ status: "disabled", suspended_until: suspendedUntil }).eq("id", account_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, message: "Account timed out", suspended_until: suspendedUntil });
  }

  if (action === "enable") {
    const { error } = await db.from("accounts").update({ status: "active", suspended_until: null }).eq("id", account_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, message: "Account enabled" });
  }

  if (action === "delete_user") {
    if (account.user_id === user.id) return NextResponse.json({ error: "cannot delete your own admin account" }, { status: 400 });
    try {
      await permanentlyDeleteUserAccount(db, account as ManagedAccount);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "delete failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, message: "User and paper account permanently removed" });
  }

  if (action === "adjust_cash") {
    const { amount } = body as { amount: number };
    if (typeof amount !== "number" || amount < 0) {
      return NextResponse.json({ error: "invalid amount" }, { status: 400 });
    }
    await db.from("accounts").update({ cash: amount }).eq("id", account_id);
    return NextResponse.json({ ok: true });
  }

  if (action === "update_display_name") {
    const { display_name } = body as { display_name?: string };
    const cleanName = display_name?.trim();
    if (!cleanName || cleanName.length < 2 || cleanName.length > 40) {
      return NextResponse.json({ error: "display name must be 2-40 characters" }, { status: 400 });
    }
    await db.from("accounts").update({ display_name: cleanName }).eq("id", account_id);
    return NextResponse.json({ ok: true, message: "Username updated" });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export const dynamic = "force-dynamic";
