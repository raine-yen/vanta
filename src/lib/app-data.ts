import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session-user";
import { mysqlAdmin } from "@/lib/mysql/admin";
import type { MySqlClient } from "@/lib/mysql-client";

export type SessionAccount = {
  id: string;
  user_id: string;
  competition_id: string;
  display_name: string;
  cash: number;
  starting_cash: number;
  equity: number;
  status: "active" | "disabled";
  created_at: string;
};

export type CompetitionAccess = {
  status: "draft" | "open" | "active" | "locked" | "settled" | "ended";
  allow_crypto: boolean;
};

export function isMissingTableError(error: unknown) {
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message).toLowerCase()
      : "";
  return message.includes("schema cache") || message.includes("does not exist") || message.includes("relation") || message.includes("doesn't exist") || message.includes("er_no_such_table");
}

/** Resolve a member's selected competition without ever trusting the browser
 * cookie as authorization. The lookup always includes the signed-in user. */
export async function getSelectedCompetitionAccount(db: MySqlClient, userId: string, competitionId?: string | null) {
  if (competitionId) {
    const selected = await db.from("accounts").select("*").eq("user_id", userId).eq("competition_id", competitionId).maybeSingle();
    if (!selected.error && selected.data) return selected;
  }
  return db.from("accounts").select("*").eq("user_id", userId).order("created_at", { ascending: true }).limit(1).maybeSingle();
}

export async function getCurrentAccount(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

  const db = mysqlAdmin();
  const { data: account, error } = await getSelectedCompetitionAccount(db, user.id, req.cookies.get("vanta_competition")?.value);

  if (error) return { response: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!account) return { response: NextResponse.json({ error: "no paper account" }, { status: 403 }) };

  const suspendedUntil = typeof account.suspended_until === "string" ? Date.parse(account.suspended_until) : NaN;
  if (account.status === "disabled" && Number.isFinite(suspendedUntil) && suspendedUntil <= Date.now()) {
    const { data: restored, error: restoreError } = await db
      .from("accounts")
      .update({ status: "active", suspended_until: null })
      .eq("id", account.id)
      .select("*")
      .maybeSingle();
    if (restoreError) return { response: NextResponse.json({ error: restoreError.message }, { status: 500 }) };
    return { user, account: restored as SessionAccount, db };
  }
  if (account.status !== "active") {
    return { response: NextResponse.json({ error: "account disabled" }, { status: 403 }) };
  }

  const { data: competition, error: competitionError } = await db
    .from("competitions")
    .select("status, allow_crypto")
    .eq("id", account.competition_id)
    .maybeSingle();
  if (competitionError) return { response: NextResponse.json({ error: competitionError.message }, { status: 500 }) };

  return { user, account: account as SessionAccount, competition: competition as CompetitionAccess | null, db };
}

export function cleanSymbol(symbol: unknown) {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "")
    .slice(0, 12);
}
