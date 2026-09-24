import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session-user";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { getSelectedCompetitionAccount, isMissingTableError } from "@/lib/app-data";

const selectSchema = z.object({ competition_id: z.string().uuid() });

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = mysqlAdmin();
  const [competitionsResult, accountsResult] = await Promise.all([
    db.from("competitions").select("id, name, description, starting_cash, start_date, end_date, status, scoring_method, max_entrants, allow_crypto, prize_description, rules, published_at, locked_at, settled_at, created_at").order("start_date", { ascending: true }),
    db.from("accounts").select("id, competition_id").eq("user_id", user.id),
  ]);
  if (competitionsResult.error) {
    const error = isMissingTableError(competitionsResult.error)
      ? "Competition management needs its database migration."
      : competitionsResult.error.message;
    return NextResponse.json({ error }, { status: 503 });
  }
  if (accountsResult.error) return NextResponse.json({ error: accountsResult.error.message }, { status: 500 });

  const countsResult = await db.from("accounts").select("competition_id");
  const counts = new Map<string, number>();
  for (const row of countsResult.data ?? []) counts.set(String(row.competition_id), (counts.get(String(row.competition_id)) ?? 0) + 1);
  const selected = await getSelectedCompetitionAccount(db, user.id, req.cookies.get("vanta_competition")?.value);
  const membership = new Map((accountsResult.data ?? []).map((row: { id: string; competition_id: string }) => [row.competition_id, row.id]));
  return NextResponse.json({
    active_competition_id: selected.data?.competition_id ?? null,
    items: (competitionsResult.data ?? []).map((competition: Record<string, any>) => ({
      ...competition,
      entrants: counts.get(competition.id) ?? 0,
      joined: membership.has(competition.id),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = selectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "valid competition_id required" }, { status: 400 });
  const db = mysqlAdmin();
  const { data: competition, error } = await db
    .from("competitions")
    .select("id, status, starting_cash, max_entrants")
    .eq("id", parsed.data.competition_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: isMissingTableError(error) ? "Competition management needs its database migration." : error.message }, { status: 503 });
  if (!competition) return NextResponse.json({ error: "competition not found" }, { status: 404 });
  if (competition.status !== "open" && competition.status !== "active") return NextResponse.json({ error: "enrollment is closed for this competition" }, { status: 409 });
  const { count } = await db.from("accounts").select("id", { count: "exact", head: true }).eq("competition_id", competition.id);
  if (competition.max_entrants && (count ?? 0) >= Number(competition.max_entrants)) return NextResponse.json({ error: "this competition is full" }, { status: 409 });

  const { data: existing } = await db.from("accounts").select("id").eq("user_id", user.id).eq("competition_id", competition.id).maybeSingle();
  if (!existing) {
    const displayName = (typeof user.user_metadata?.display_name === "string" && user.user_metadata.display_name.trim()) || user.email?.split("@")[0] || "Trader";
    const startingCash = Number(competition.starting_cash);
    const { error: joinError } = await db.from("accounts").insert({
      user_id: user.id, competition_id: competition.id, display_name: displayName.slice(0, 40), cash: startingCash, starting_cash: startingCash, equity: startingCash,
    });
    if (joinError) return NextResponse.json({ error: joinError.message }, { status: 500 });
  }
  const response = NextResponse.json({ ok: true, competition_id: competition.id });
  response.cookies.set("vanta_competition", competition.id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 180 });
  return response;
}

export const dynamic = "force-dynamic";
