import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { getPrice } from "@/lib/prices";
import { placeOrder } from "@/lib/engine";
import { toAlpacaPosition, toAlpacaOrder } from "@/lib/alpaca-format";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result.response;
  const { account } = result.auth;
  const { symbol } = await params;
  const upper = symbol.toUpperCase();

  const db = mysqlAdmin();
  const { data } = await db
    .from("positions")
    .select("*")
    .eq("account_id", account.id)
    .eq("symbol", upper)
    .maybeSingle();

  if (!data) {
    return NextResponse.json(
      { code: 40410000, message: "position does not exist" },
      { status: 404 }
    );
  }

  const price = (await getPrice(upper)) ?? Number(data.avg_entry_price);
  return NextResponse.json(toAlpacaPosition(data, price));
}

// DELETE = liquidate position with market sell
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result.response;
  const { account } = result.auth;
  const { symbol } = await params;
  const upper = symbol.toUpperCase();

  const db = mysqlAdmin();
  const { data: pos } = await db
    .from("positions")
    .select("*")
    .eq("account_id", account.id)
    .eq("symbol", upper)
    .maybeSingle();

  if (!pos) {
    return NextResponse.json(
      { code: 40410000, message: "position does not exist" },
      { status: 404 }
    );
  }

  const order = await placeOrder({
    account,
    symbol: upper,
    qty: Number(pos.qty),
    side: "sell",
    type: "market",
  });
  if (!order.ok) {
    return NextResponse.json({ code: 42210000, message: order.error }, { status: 422 });
  }
  return NextResponse.json(toAlpacaOrder(order.order!));
}

export const dynamic = "force-dynamic";
