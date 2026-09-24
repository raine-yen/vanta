import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { fetchYahooPrices } from "@/lib/prices";
import { toAlpacaPosition } from "@/lib/alpaca-format";
import type { Position } from "@/lib/types";

export async function GET(req: NextRequest) {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result.response;
  const { account } = result.auth;

  const db = mysqlAdmin();
  const { data } = await db
    .from("positions")
    .select("*")
    .eq("account_id", account.id);
  const positions = (data as Position[] | null) ?? [];

  if (positions.length === 0) return NextResponse.json([]);

  const symbols = positions.map((p) => p.symbol);
  const priceMap = await fetchYahooPrices(symbols);

  const out = positions.map((p) => {
    const cp = priceMap.get(p.symbol)?.price ?? Number(p.avg_entry_price);
    return toAlpacaPosition(p, cp);
  });
  return NextResponse.json(out);
}

export const dynamic = "force-dynamic";
