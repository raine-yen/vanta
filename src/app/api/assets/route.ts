import { NextRequest, NextResponse } from "next/server";
import { fetchYahooPrices } from "@/lib/prices";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { mysqlServer } from "@/lib/mysql/server";

const PEEK_FEE = 10000;

export async function POST(req: NextRequest) {
  const sb = await mysqlServer();
  const { data: ud } = await sb.auth.getUser();
  if (!ud.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const targetAccountId = body?.account_id;
  if (!targetAccountId || typeof targetAccountId !== "string") {
    return NextResponse.json({ error: "account_id required" }, { status: 400 });
  }

  const db = mysqlAdmin();
  const { data: viewer } = await db
    .from("accounts")
    .select("*")
    .eq("user_id", ud.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!viewer) return NextResponse.json({ error: "no account" }, { status: 400 });
  if (viewer.id === targetAccountId) {
    return NextResponse.json({ error: "you already own those assets" }, { status: 400 });
  }
  if (Number(viewer.cash) < PEEK_FEE) {
    return NextResponse.json({ error: "not enough cash to spend $10,000" }, { status: 422 });
  }

  const { data: target } = await db
    .from("accounts")
    .select("id, display_name")
    .eq("id", targetAccountId)
    .eq("status", "active")
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "target account not found" }, { status: 404 });

  await db.from("accounts").update({ cash: Number(viewer.cash) - PEEK_FEE }).eq("id", viewer.id);

  const { data: positions } = await db
    .from("positions")
    .select("symbol, qty, avg_entry_price")
    .eq("account_id", targetAccountId)
    .order("symbol", { ascending: true });

  const rows = (positions ?? []) as Array<{ symbol: string; qty: number; avg_entry_price: number }>;
  const prices = rows.length ? await fetchYahooPrices(rows.map((p) => p.symbol)) : new Map<string, { price: number }>();
  const assets = rows.map((p) => {
    const currentPrice = prices.get(p.symbol)?.price ?? Number(p.avg_entry_price);
    return {
      symbol: p.symbol,
      qty: Number(p.qty),
      avg_entry_price: Number(p.avg_entry_price),
      current_price: currentPrice,
      market_value: Number(p.qty) * currentPrice,
    };
  });

  return NextResponse.json({
    fee: PEEK_FEE,
    remaining_cash: Number(viewer.cash) - PEEK_FEE,
    account: target,
    assets,
  });
}

export const dynamic = "force-dynamic";
