import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateKeyPair, hashSecret } from "@/lib/api-keys";
import { getSessionUser } from "@/lib/session-user";
import { getCurrentAccount } from "@/lib/app-data";
import { mysqlAdmin } from "@/lib/mysql/admin";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = mysqlAdmin();
  const { data } = await db
    .from("api_keys")
    .select("id, key_id, label, last_used_at, revoked_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return NextResponse.json({ keys: data ?? [] });
}

const createSchema = z.object({ label: z.string().max(80).optional() });

export async function POST(req: NextRequest) {
  const context = await getCurrentAccount(req);
  if ("response" in context) return context.response;

  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { keyId, secret } = generateKeyPair();
  const { error } = await context.db.from("api_keys").insert({
    user_id: context.user.id,
    account_id: context.account.id,
    key_id: keyId,
    secret_hash: hashSecret(secret),
    label: parsed.data.label ?? null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Return the secret ONCE — it cannot be recovered later
  return NextResponse.json({ key_id: keyId, secret });
}
