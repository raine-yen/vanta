import { NextResponse } from "next/server";
import { mysqlServer } from "@/lib/mysql/server";

export async function POST() {
  const sb = await mysqlServer();
  await sb.auth.signOut();
  return NextResponse.json({ ok: true });
}
