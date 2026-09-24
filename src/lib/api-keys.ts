import { createHash, randomBytes, timingSafeEqual } from "crypto";

// Generate Alpaca-style key pair: "PK" + 20 char key id, 40 char secret.
export function generateKeyPair() {
  const keyId = "PK" + randomBytes(10).toString("hex").toUpperCase();
  const secret = randomBytes(20).toString("hex");
  return { keyId, secret };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifySecret(secret: string, hash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
