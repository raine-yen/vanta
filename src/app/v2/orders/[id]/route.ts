import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { cancelOrder } from "@/lib/engine";
import { toAlpacaOrder } from "@/lib/alpaca-format";
import type { Order } from "@/lib/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result.response;
  const { account } = result.auth;
  const { id } = await params;

  const db = mysqlAdmin();
  const { data } = await db
    .from("orders")
    .select("*")
    .eq("id", id)
    .eq("account_id", account.id)
    .maybeSingle();

  if (!data) {
    return NextResponse.json(
      { code: 40410000, message: "order not found" },
      { status: 404 }
    );
  }
  return NextResponse.json(toAlpacaOrder(data as Order));
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result.response;
  const { account } = result.auth;
  const { id } = await params;

  const ok = await cancelOrder(id, account.id);
  if (!ok) {
    return NextResponse.json(
      { code: 42210000, message: "order cannot be canceled" },
      { status: 422 }
    );
  }
  return new NextResponse(null, { status: 204 });
}

export const dynamic = "force-dynamic";
