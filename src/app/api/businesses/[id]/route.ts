import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session-user";
import { execute, query } from "@/lib/mysql";

type Context = { params: Promise<{ id: string }> };
const updateBusiness = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  website_url: z.string().url().max(2000).nullable().optional(),
  status: z.enum(["draft", "active", "closed"]).optional(),
});

export async function GET(req: NextRequest, { params }: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const rows = await query<{ id: string; owner_user_id: string; status: string }>("SELECT * FROM businesses WHERE id = ? LIMIT 1", [id]);
  const row = rows[0];
  if (!row || (row.status !== "active" && row.owner_user_id !== user.id && user.role === "member")) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ business: row });
}

export async function PATCH(req: NextRequest, { params }: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = updateBusiness.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !Object.keys(parsed.data).length) return NextResponse.json({ error: "invalid update" }, { status: 400 });
  const owner = (await query<{ owner_user_id: string }>("SELECT owner_user_id FROM businesses WHERE id = ? LIMIT 1", [id]))[0];
  if (!owner) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (owner.owner_user_id !== user.id && user.role !== "owner" && user.role !== "manager") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const entries = Object.entries(parsed.data);
  await execute(`UPDATE businesses SET ${entries.map(([column]) => `\`${column}\` = ?`).join(", ")} WHERE id = ?`, [...entries.map(([, value]) => value), id]);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const owner = (await query<{ owner_user_id: string }>("SELECT owner_user_id FROM businesses WHERE id = ? LIMIT 1", [id]))[0];
  if (!owner) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (owner.owner_user_id !== user.id && user.role !== "owner" && user.role !== "manager") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await execute("UPDATE businesses SET status = 'closed' WHERE id = ?", [id]);
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
