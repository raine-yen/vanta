import { NextRequest, NextResponse } from "next/server";
import { takeSnapshots } from "@/lib/engine";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const n = await takeSnapshots();
    return NextResponse.json({ ok: true, snapshots: n });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;
