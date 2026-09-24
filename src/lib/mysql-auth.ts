import { createHash, randomBytes, randomUUID, scrypt as callbackScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { execute, query } from "@/lib/mysql";
import { readCookie } from "@/lib/request-context";

const scrypt = promisify(callbackScrypt);
const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = "vanta_session";

export type AuthContext = {
  token?: string | null;
  cookieHeader?: string;
  setCookie?: (cookie: string) => void;
};

type UserRow = { id: string; email: string; display_name: string; role: "member" | "manager" | "owner" };

function digest(token: string) { return createHash("sha256").update(token).digest("hex"); }
function randomToken() { return randomBytes(32).toString("base64url"); }
function date(value: Date) { return value.toISOString().slice(0, 23).replace("T", " "); }
function userShape(row: UserRow) { return { id: row.id, email: row.email, role: row.role, user_metadata: { display_name: row.display_name } }; }
function cookie(value: string, maxAge: number) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${process.env.NODE_ENV === "production" ? " Secure;" : ""}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const result = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${result.toString("hex")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, hex] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function createSession(userId: string) {
  const access = randomToken();
  const refresh = randomToken();
  const expires = new Date(Date.now() + ACCESS_TTL_MS);
  const refreshExpires = new Date(Date.now() + REFRESH_TTL_MS);
  await execute(
    "INSERT INTO sessions (id, user_id, token_hash, refresh_hash, expires_at, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [randomUUID(), userId, digest(access), digest(refresh), date(expires), date(refreshExpires)],
  );
  return { access_token: access, refresh_token: refresh, expires_at: Math.floor(expires.getTime() / 1000) };
}

export function authForContext(context: AuthContext) {
  const token = () => context.token ?? readCookie(context.cookieHeader ?? "", COOKIE);
  return {
    async getUser(explicitToken?: string) {
      const current = explicitToken ?? token();
      if (!current) return { data: { user: null }, error: null };
      const rows = await query<UserRow>(
        "SELECT u.id, u.email, u.display_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1",
        [digest(current)],
      );
      return { data: { user: rows[0] ? userShape(rows[0]) : null }, error: null };
    },
    async signInWithPassword(input: { email: string; password: string }) {
      const rows = await query<UserRow & { password_hash: string }>("SELECT id, email, display_name, role, password_hash FROM users WHERE email = ? LIMIT 1", [input.email.trim().toLowerCase()]);
      const row = rows[0];
      if (!row || !(await verifyPassword(input.password, row.password_hash))) return { data: { user: null, session: null }, error: { message: "Invalid email or password" } };
      const session = await createSession(row.id);
      context.setCookie?.(cookie(session.access_token, ACCESS_TTL_MS / 1000));
      return { data: { user: userShape(row), session }, error: null };
    },
    async signUp(input: { email: string; password: string; options?: { data?: { display_name?: string } } }) {
      const id = randomUUID();
      const email = input.email.trim().toLowerCase();
      const displayName = input.options?.data?.display_name?.trim() || email.split("@")[0];
      try {
        await execute("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)", [id, email, await hashPassword(input.password), displayName.slice(0, 80)]);
        return { data: { user: { id, email, user_metadata: { display_name: displayName } }, session: null }, error: null };
      } catch (error) {
        return { data: { user: null, session: null }, error: { message: (error as { code?: string }).code === "ER_DUP_ENTRY" ? "Email already registered" : "Could not create account" } };
      }
    },
    async setSession(input: { access_token: string; refresh_token: string }) {
      const current = await this.getUser(input.access_token);
      if (!current.data.user) return { data: { session: null }, error: { message: "Invalid session" } };
      context.setCookie?.(cookie(input.access_token, ACCESS_TTL_MS / 1000));
      return { data: { session: input }, error: null };
    },
    async refreshSession(input: { refresh_token: string }) {
      const rows = await query<{ id: string; user_id: string }>("SELECT id, user_id FROM sessions WHERE refresh_hash = ? AND revoked_at IS NULL AND refresh_expires_at > UTC_TIMESTAMP(3) LIMIT 1", [digest(input.refresh_token)]);
      if (!rows[0]) return { data: { session: null }, error: { message: "Invalid refresh token" } };
      await execute("UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?", [rows[0].id]);
      const session = await createSession(rows[0].user_id);
      context.setCookie?.(cookie(session.access_token, ACCESS_TTL_MS / 1000));
      return { data: { session }, error: null };
    },
    async signOut() {
      const current = token();
      if (current) await execute("UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ?", [digest(current)]);
      context.setCookie?.(cookie("", 0));
      return { error: null };
    },
    admin: {
      async listUsers(input?: { page?: number; perPage?: number }) {
        const page = Math.max(1, input?.page ?? 1);
        const perPage = Math.min(1000, Math.max(1, input?.perPage ?? 50));
        const rows = await query<UserRow>(`SELECT id, email, display_name, role FROM users ORDER BY created_at LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`);
        return { data: { users: rows.map(userShape) }, error: null };
      },
      async deleteUser(id: string) {
        try { await execute("DELETE FROM users WHERE id = ?", [id]); return { data: null, error: null }; }
        catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }; }
      },
    },
  };
}
