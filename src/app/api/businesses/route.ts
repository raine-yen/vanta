import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getSessionUser } from "@/lib/session-user";
import { execute, query } from "@/lib/mysql";

const createBusiness = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(200),
  description: z.string().max(5000).optional(),
  website_url: z.string().url().max(2000).optional(),
});

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await query("SELECT id, name, slug, description, website_url, status, created_at FROM businesses WHERE status = 'active' OR owner_user_id = ? ORDER BY created_at DESC LIMIT 100", [user.id]);
  return NextResponse.json({ businesses: rows });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = createBusiness.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid business" }, { status: 400 });
  const id = randomUUID();
  try {
    await execute("INSERT INTO businesses (id, owner_user_id, name, slug, description, website_url) VALUES (?, ?, ?, ?, ?, ?)", [id, user.id, parsed.data.name, parsed.data.slug, parsed.data.description ?? null, parsed.data.website_url ?? null]);
    return NextResponse.json({ id, status: "draft" }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") return NextResponse.json({ error: "slug already in use" }, { status: 409 });
    throw error;
  }
}

export const dynamic = "force-dynamic";
