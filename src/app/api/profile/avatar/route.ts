import { NextRequest, NextResponse } from "next/server";
import { getCurrentAccount, isMissingTableError } from "@/lib/app-data";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(req: NextRequest) {
  const ctx = await getCurrentAccount(req);
  if ("response" in ctx) return ctx.response;

  const form = await req.formData().catch(() => null);
  const file = form?.get("avatar");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "avatar file required" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "avatar must be jpeg, png, or webp" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "avatar must be under 4MB" }, { status: 400 });
  }

  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const filename = `${Date.now()}.${ext}`;
  const path = `${ctx.account.id}/${filename}`;
  const bytes = await file.arrayBuffer();
  const directory = join(process.cwd(), "uploads", "avatars", ctx.account.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), Buffer.from(bytes));
  const avatar_url = `/uploads/avatars/${path}`;

  const { data, error } = await ctx.db
    .from("trader_profiles")
    .upsert({
      account_id: ctx.account.id,
      avatar_url,
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id" })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: isMissingTableError(error) ? 501 : 500 });
  }

  return NextResponse.json({ profile: data, avatar_url });
}

export const dynamic = "force-dynamic";
