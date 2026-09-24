import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensurePaperAccount } from "@/lib/ensure-paper-account";
import { mysqlServer } from "@/lib/mysql/server";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  const sb = await mysqlServer();
  const { data, error } = await sb.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.session) {
    return NextResponse.json({ error: error?.message ?? "login failed" }, { status: 401 });
  }

  try {
    await ensurePaperAccount(data.user, sb);
  } catch (provisionError) {
    return NextResponse.json(
      { error: provisionError instanceof Error ? provisionError.message : "Could not activate your paper account." },
      { status: 500 }
    );
  }

  // Persist the MySQL-backed session so the app layout can detect the user.
  const sbForCookies = await mysqlServer();
  await sbForCookies.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });

  return NextResponse.json({
    ok: true,
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
}
