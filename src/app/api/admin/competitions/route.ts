import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session-user";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { isMissingTableError } from "@/lib/app-data";

const createSchema = z.object({
  name: z.string().trim().min(3).max(80), description: z.string().trim().max(500).optional(), starting_cash: z.number().finite().min(100).max(1_000_000),
  start_date: z.string().datetime(), end_date: z.string().datetime().optional(), scoring_method: z.enum(["return_pct", "net_profit"]), max_entrants: z.number().int().min(2).max(10000).nullable().optional(),
  allow_crypto: z.boolean(), prize_description: z.string().trim().max(300).optional(), rules: z.string().trim().max(2000).optional(), status: z.enum(["draft", "open", "active"]),
}).refine((data) => !data.end_date || Date.parse(data.end_date) > Date.parse(data.start_date), { message: "end date must be after start date", path: ["end_date"] });
const lifecycleSchema = z.object({ action: z.literal("set_status"), competition_id: z.string().uuid(), status: z.enum(["draft", "open", "active", "locked", "settled", "ended"]) });

async function admin(req: NextRequest) {
  const user = await getSessionUser(req);
  return user && (user.role === "owner" || user.role === "manager") ? user : null;
}
function migrationError(error: unknown) { return isMissingTableError(error) ? "Competition management needs its database migration." : error instanceof Error ? error.message : "Competition request failed."; }

export async function GET(req: NextRequest) {
  if (!await admin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { data, error } = await mysqlAdmin().from("competitions").select("id, name, description, starting_cash, start_date, end_date, status, scoring_method, max_entrants, allow_crypto, prize_description, rules, published_at, locked_at, settled_at, created_at").order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: migrationError(error) }, { status: 503 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await admin(req);
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const lifecycle = lifecycleSchema.safeParse(body);
  const db = mysqlAdmin();
  if (lifecycle.success) {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { status: lifecycle.data.status };
    if (lifecycle.data.status === "open") updates.published_at = now;
    if (lifecycle.data.status === "locked") updates.locked_at = now;
    if (lifecycle.data.status === "settled") updates.settled_at = now;
    const { error } = await db.from("competitions").update(updates).eq("id", lifecycle.data.competition_id);
    if (error) return NextResponse.json({ error: migrationError(error) }, { status: 503 });
    return NextResponse.json({ ok: true, message: `Competition is now ${lifecycle.data.status}.` });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid competition" }, { status: 400 });
  const values = parsed.data;
  const { error } = await db.from("competitions").insert({ ...values, description: values.description || null, end_date: values.end_date ?? null, max_entrants: values.max_entrants ?? null, prize_description: values.prize_description || null, rules: values.rules || null, created_by: user.id, published_at: values.status === "open" ? new Date().toISOString() : null });
  if (error) return NextResponse.json({ error: migrationError(error) }, { status: 503 });
  return NextResponse.json({ ok: true, message: "Competition created." });
}

export const dynamic = "force-dynamic";
