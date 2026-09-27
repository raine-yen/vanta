import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword } from "../src/lib/mysql-auth.ts";

test("migrated Supabase bcrypt passwords still sign in", async () => {
  const password = "existing-account-password";
  const hash = await bcrypt.hash(password, 4);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("new MySQL scrypt passwords still sign in", async () => {
  const password = "new-account-password";
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});
