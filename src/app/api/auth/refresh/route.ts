import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mysqlServer } from "@/lib/mysql/server";

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = refreshSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const sb = await mysqlServer();
  const { data, error } = await sb.auth.refreshSession({
    refresh_token: parsed.data.refresh_token,
  });

  if (error || !data.session) {
    return NextResponse.json({ error: error?.message ?? "refresh failed" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
}
