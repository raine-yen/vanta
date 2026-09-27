import assert from "node:assert/strict";
import test from "node:test";
import { importOrder, transformSnapshot } from "../scripts/import-supabase-json.mjs";

const accountId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const marketKey = "0x" + "a".repeat(64);
const emptyTables = () => Object.fromEntries(importOrder.map((name) => [name, []]));

test("Supabase accounts and external prediction IDs map to MySQL without losing references", () => {
  const snapshot = {
    auth_users: [{ id: userId, email: "Tester@Example.com", encrypted_password: "$2a$10$" + "x".repeat(53), created_at: "2026-01-01T00:00:00Z" }],
    tables: { ...emptyTables(),
      competitions: [{ id: "33333333-3333-4333-8333-333333333333", name: "Club" }],
      accounts: [{ id: accountId, user_id: userId, display_name: "Test Trader" }],
      prediction_markets: [{ id: marketKey, question: "A question" }],
      prediction_positions: [{ id: "44444444-4444-4444-8444-444444444444", account_id: accountId, market_id: marketKey }],
      prediction_fills: [{ id: "55555555-5555-4555-8555-555555555555", account_id: accountId, market_id: marketKey }],
    },
  };
  const { users, tables } = transformSnapshot(snapshot);
  assert.equal(users[0].email, "tester@example.com");
  assert.equal(users[0].display_name, "Test Trader");
  assert.equal(users[0].password_hash, snapshot.auth_users[0].encrypted_password);
  assert.equal(tables.prediction_markets[0].condition_id, marketKey);
  assert.match(tables.prediction_markets[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(tables.prediction_positions[0].market_id, tables.prediction_markets[0].id);
  assert.equal(tables.prediction_fills[0].market_id, tables.prediction_markets[0].id);
});

test("import stops when a prediction position references a missing market", () => {
  assert.throws(() => transformSnapshot({
    auth_users: [{ id: userId, email: "x@example.com", encrypted_password: "$2a$10$" + "x".repeat(53) }],
    tables: { ...emptyTables(), competitions: [{ id: userId }], prediction_positions: [{ market_id: marketKey }] },
  }), /missing market/);
});

test("the legacy admin account retains owner access", () => {
  const { users } = transformSnapshot({
    auth_users: [{ id: userId, email: "raine_yen@outlook.com", encrypted_password: "$2a$10$" + "x".repeat(53) }],
    tables: { ...emptyTables(), competitions: [{ id: userId }] },
  });
  assert.equal(users[0].role, "owner");
});

test("import rejects a partial snapshot before changing the database", () => {
  assert.throws(() => transformSnapshot({ auth_users: [], tables: { competitions: [] } }), /missing accounts/);
});
