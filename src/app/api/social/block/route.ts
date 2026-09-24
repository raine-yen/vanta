import { NextRequest, NextResponse } from "next/server";
import { getCurrentAccount, isMissingTableError } from "@/lib/app-data";

export async function GET(req: NextRequest) {
  const ctx = await getCurrentAccount(req);
  if ("response" in ctx) return ctx.response;

  const { data, error } = await ctx.db
    .from("blocked_users")
    .select("blocker_account_id, blocked_account_id")
    .or(`blocker_account_id.eq.${ctx.account.id},blocked_account_id.eq.${ctx.account.id}`);
  if (error) {
    if (isMissingTableError(error)) return NextResponse.json({ account_ids: [] });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const accountIds = (data ?? []).map((row: { blocker_account_id: string; blocked_account_id: string }) =>
    row.blocker_account_id === ctx.account.id ? row.blocked_account_id : row.blocker_account_id
  );
  return NextResponse.json({ account_ids: Array.from(new Set(accountIds)) });
}

export async function POST(req: NextRequest) {
  const ctx = await getCurrentAccount(req);
  if ("response" in ctx) return ctx.response;
  const body = await req.json().catch(() => ({}));
  const target = String(body.account_id ?? "");
  if (!target || target === ctx.account.id) return NextResponse.json({ error: "valid account_id required" }, { status: 400 });

  const { data: targetAccount, error: targetError } = await ctx.db
    .from("accounts")
    .select("id")
    .eq("id", target)
    .eq("competition_id", ctx.account.competition_id)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: targetError.message }, { status: 500 });
  if (!targetAccount) return NextResponse.json({ error: "account not found in this competition" }, { status: 404 });

  const { error } = await ctx.db
    .from("blocked_users")
    .upsert({ blocker_account_id: ctx.account.id, blocked_account_id: target }, { onConflict: "blocker_account_id,blocked_account_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: isMissingTableError(error) ? 501 : 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const ctx = await getCurrentAccount(req);
  if ("response" in ctx) return ctx.response;
  const target = new URL(req.url).searchParams.get("account_id");
  if (!target) return NextResponse.json({ error: "account_id required" }, { status: 400 });

  const { error } = await ctx.db
    .from("blocked_users")
    .delete()
    .eq("blocker_account_id", ctx.account.id)
    .eq("blocked_account_id", target);
  if (error) return NextResponse.json({ error: error.message }, { status: isMissingTableError(error) ? 501 : 500 });
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
