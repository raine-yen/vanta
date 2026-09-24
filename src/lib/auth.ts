import { NextRequest, NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { mysqlAdmin } from "@/lib/mysql/admin";
import { verifySecret } from "@/lib/api-keys";
import type { Account, ApiKey } from "@/lib/types";

export interface ApiAuth {
  account: Account;
  apiKey: ApiKey;
}

/** Reads either Alpaca's standard headers or its legacy HTTP Basic form. */
export function alpacaCredentials(req: Pick<NextRequest, "headers">): { keyId: string; secret: string } | null {
  const keyId = req.headers.get("apca-api-key-id");
  const secret = req.headers.get("apca-api-secret-key");
  if (keyId && secret) return { keyId, secret };

  const basic = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!basic) return null;
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0 || separator === decoded.length - 1) return null;
  return { keyId: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

// Validate Alpaca-style headers: APCA-API-KEY-ID + APCA-API-SECRET-KEY.
export async function authenticateApiKey(req: NextRequest): Promise<
  { ok: true; auth: ApiAuth } | { ok: false; response: NextResponse }
> {
  const credentials = alpacaCredentials(req);

  if (!credentials) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: 40110000, message: "missing API credentials" },
        { status: 401 }
      ),
    };
  }
  const { keyId, secret } = credentials;

  const db = mysqlAdmin();

  const { data: apiKey, error: keyErr } = await db
    .from("api_keys")
    .select("*")
    .eq("key_id", keyId)
    .is("revoked_at", null)
    .maybeSingle();

  if (keyErr || !apiKey) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: 40110000, message: "invalid API credentials" },
        { status: 401 }
      ),
    };
  }

  if (!verifySecret(secret, (apiKey as ApiKey).secret_hash)) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: 40110000, message: "invalid API credentials" },
        { status: 401 }
      ),
    };
  }

  const { data: account, error: acctErr } = await db
    .from("accounts")
    .select("*")
    .eq("id", (apiKey as ApiKey).account_id)
    .maybeSingle();

  if (acctErr || !account) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: 40110001, message: "account not found" },
        { status: 401 }
      ),
    };
  }

  // Fire-and-forget last_used_at update
  void db
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", (apiKey as ApiKey).id);

  return { ok: true, auth: { account: account as Account, apiKey: apiKey as ApiKey } };
}
