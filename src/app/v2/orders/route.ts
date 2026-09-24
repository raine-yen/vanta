import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { placeOrder } from "@/lib/engine";
import { toAlpacaOrder } from "@/lib/alpaca-format";
import type { Order } from "@/lib/types";

const orderSchema = z.object({
  symbol: z.string().min(1),
  qty: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]).default("market"),
  time_in_force: z.enum(["gtc", "day", "ioc"]).optional(),
  limit_price: z.union([z.number(), z.string()]).optional().transform((v) => (v == null ? undefined : Number(v))),
  client_order_id: z.string().optional(),
  scheduled_at: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result.response;
  const { account } = result.auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 40010000, message: "invalid JSON body" },
      { status: 400 }
    );
  }

  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { code: 42210000, message: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 422 }
    );
  }

  const order = await placeOrder({
    account,
    symbol: parsed.data.symbol,
    qty: parsed.data.qty,
    side: parsed.data.side,
    type: parsed.data.type,
    limit_price: parsed.data.limit_price,
    time_in_force: parsed.data.time_in_force,
    client_order_id: parsed.data.client_order_id,
    scheduled_at: parsed.data.scheduled_at,
  });

  if (!order.ok) {
    return NextResponse.json({ code: 42210000, message: order.error }, { status: 422 });
  }
  return NextResponse.json(toAlpacaOrder(order.order!));
}

export async function GET(req: NextRequest) {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result.response;
  const { account } = result.auth;

  const url = new URL(req.url);
  const status = url.searchParams.get("status"); // open | closed | all
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);

  const db = mysqlAdmin();
  let q = db
    .from("orders")
    .select("*")
    .eq("account_id", account.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status === "open") q = q.in("status", ["new", "partially_filled"]);
  else if (status === "closed") q = q.in("status", ["filled", "canceled", "rejected", "expired"]);

  const { data } = await q;
  const orders = ((data as Order[] | null) ?? []).map(toAlpacaOrder);
  return NextResponse.json(orders);
}

export const dynamic = "force-dynamic";
