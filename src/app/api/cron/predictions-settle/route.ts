import { NextRequest, NextResponse } from "next/server";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { settlePredictionMarkets } from "@/lib/prediction-settle";

// Pays out resolved prediction markets: $1/winning share to the shared paper
// cash, zeroes losing positions, marks the market resolved. Runs daily
// through hPanel cron; also callable on demand by an authorized member.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await settlePredictionMarkets({ db: mysqlAdmin() as any });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("prediction settlement failed", e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;
