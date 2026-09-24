import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensurePaperAccount } from "@/lib/ensure-paper-account";
import { mysqlServer } from "@/lib/mysql/server";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  display_name: z.string().min(2).max(40),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  const sb = await mysqlServer();
  const { data, error } = await sb.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { display_name: parsed.data.display_name },
    },
  });

  if (error || !data.user) {
    return NextResponse.json({ error: error?.message ?? "signup failed" }, { status: 400 });
  }

  // If email confirmation is disabled, provision immediately through the new
  // authenticated session. Otherwise the first successful login provisions it.
  if (data.session) {
    try {
      await ensurePaperAccount(data.user, sb);
    } catch (provisionError) {
      return NextResponse.json(
        { error: provisionError instanceof Error ? provisionError.message : "Could not activate your paper account." },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ok: true, user_id: data.user.id });
}
