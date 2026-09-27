// One-time import of a Supabase snapshot into a freshly migrated Vanta MySQL DB.
// Input is private JSON: { auth_users: [...], tables: { accounts: [...], ... } }.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

export const importOrder = [
  "competitions", "accounts", "api_keys", "positions", "orders", "fills",
  "prices", "equity_snapshots", "prediction_markets", "prediction_positions",
  "prediction_fills", "blocked_users", "direct_messages", "message_reports",
  "quest_points",
];
// The Supabase site's admin gate used these addresses before MySQL roles existed.
const legacyOwnerEmails = new Set(["shawny3n@gmail.com", "raine_yen@outlook.com"]);

export function transformSnapshot(snapshot) {
  if (!Array.isArray(snapshot.auth_users) || !snapshot.tables || typeof snapshot.tables !== "object") {
    throw new Error("Expected auth_users array and tables object");
  }
  const tables = Object.fromEntries(importOrder.map((name) => {
    if (!Object.hasOwn(snapshot.tables, name)) throw new Error(`Snapshot is missing ${name}`);
    const rows = snapshot.tables[name];
    if (!Array.isArray(rows)) throw new Error(`${name} must be an array`);
    return [name, rows.map((row) => ({ ...row }))];
  }));
  const accountByUser = new Map(tables.accounts.map((row) => [row.user_id, row]));
  const users = snapshot.auth_users.map((source) => {
    if (!source.id || !source.email || !/^\$2[aby]\$\d{2}\$/.test(source.encrypted_password ?? "")) {
      throw new Error(`User ${source.id ?? "<missing id>"} has no importable bcrypt password`);
    }
    const account = accountByUser.get(source.id);
    const name = account?.display_name || source.raw_user_meta_data?.display_name || source.email.split("@")[0];
    const requestedRole = source.raw_app_meta_data?.role;
    return {
      id: source.id, email: source.email.toLowerCase(), password_hash: source.encrypted_password,
      display_name: String(name).slice(0, 80),
      role: ["member", "manager", "owner"].includes(requestedRole)
        ? requestedRole
        : legacyOwnerEmails.has(source.email.toLowerCase()) ? "owner" : "member",
      created_at: source.created_at,
    };
  });
  if (!users.length || !tables.competitions.length) throw new Error("Snapshot is missing users or competitions");
  const ids = (rows, table) => {
    const values = rows.map((row) => row.id);
    if (values.some((id) => !id) || new Set(values).size !== values.length) throw new Error(`${table} has missing or duplicate IDs`);
    return new Set(values);
  };
  const userIds = ids(users, "users");
  const competitionIds = ids(tables.competitions, "competitions");
  const accountIds = ids(tables.accounts, "accounts");
  const orderIds = ids(tables.orders, "orders");
  const messageIds = ids(tables.direct_messages, "direct_messages");
  const checkRefs = (table, column, target) => {
    for (const row of tables[table]) {
      if (row[column] != null && !target.has(row[column])) throw new Error(`${table} references missing ${column}: ${row[column]}`);
    }
  };
  checkRefs("competitions", "created_by", userIds);
  checkRefs("accounts", "user_id", userIds);
  checkRefs("accounts", "competition_id", competitionIds);
  checkRefs("api_keys", "user_id", userIds);
  checkRefs("api_keys", "account_id", accountIds);
  for (const name of ["positions", "orders", "fills", "equity_snapshots", "prediction_positions", "prediction_fills", "quest_points"]) {
    checkRefs(name, "account_id", accountIds);
  }
  checkRefs("fills", "order_id", orderIds);
  for (const column of ["blocker_account_id", "blocked_account_id"]) checkRefs("blocked_users", column, accountIds);
  for (const column of ["sender_account_id", "recipient_account_id"]) checkRefs("direct_messages", column, accountIds);
  checkRefs("message_reports", "message_id", messageIds);
  checkRefs("message_reports", "reporter_account_id", accountIds);
  const marketIds = new Map();
  tables.prediction_markets = tables.prediction_markets.map((market) => {
    if (!market.id || market.id.length > 255 || marketIds.has(market.id)) throw new Error("Duplicate, missing, or oversized prediction market id");
    const id = randomUUID();
    marketIds.set(market.id, id);
    return { ...market, id, condition_id: market.id };
  });
  for (const table of ["prediction_positions", "prediction_fills"]) {
    tables[table] = tables[table].map((row) => {
      const marketId = marketIds.get(row.market_id);
      if (!marketId) throw new Error(`${table} references missing market ${row.market_id}`);
      return { ...row, market_id: marketId };
    });
  }
  return { users, tables };
}

function sqlValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp: ${value}`);
    return parsed.toISOString().slice(0, 23).replace("T", " ");
  }
  return value;
}

async function insertRows(connection, table, rows) {
  if (!rows.length) return;
  const [columns] = await connection.query(`SHOW COLUMNS FROM \`${table}\``);
  const allowed = new Set(columns.map((column) => column.Field));
  const keys = Object.keys(rows[0]).filter((key) => allowed.has(key));
  if (!keys.length) throw new Error(`No matching columns for ${table}`);
  for (const row of rows) {
    if (keys.some((key) => !(key in row))) throw new Error(`Inconsistent ${table} row shape`);
  }
  const columnSql = keys.map((key) => `\`${key}\``).join(", ");
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100).map((row) => keys.map((key) => sqlValue(row[key])));
    await connection.query(`INSERT INTO \`${table}\` (${columnSql}) VALUES ?`, [batch]);
  }
}

export async function importSnapshot(connection, snapshot) {
  const { users, tables } = transformSnapshot(snapshot);
  await connection.beginTransaction();
  try {
    const [[{ users: existingUsers, accounts: existingAccounts }]] = await connection.query(
      "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM accounts) AS accounts",
    );
    if (existingUsers || existingAccounts) throw new Error("Destination has users or accounts; import requires a fresh MySQL database");
    const [competitions] = await connection.query("SELECT id, name, is_default FROM competitions");
    if (competitions.length === 1 && competitions[0].name === "Club Sandbox" && competitions[0].is_default) {
      await connection.query("DELETE FROM seasons WHERE competition_id = ?", [competitions[0].id]);
      await connection.query("DELETE FROM competitions WHERE id = ?", [competitions[0].id]);
    } else if (competitions.length) {
      throw new Error("Destination competitions differ from the migration seed");
    }
    await insertRows(connection, "users", users);
    for (const name of importOrder) await insertRows(connection, name, tables[name]);
    const counts = { users: users.length };
    for (const name of importOrder) counts[name] = tables[name].length;
    for (const [name, expected] of Object.entries(counts)) {
      const [[{ total }]] = await connection.query(`SELECT COUNT(*) AS total FROM \`${name}\``);
      if (total !== expected) throw new Error(`${name}: imported ${total}, expected ${expected}`);
    }
    await connection.commit();
    return counts;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checkOnly = process.argv[2] === "--check";
  const file = process.argv[checkOnly ? 3 : 2];
  if (!file) throw new Error("Usage: node scripts/import-supabase-json.mjs [--check] PRIVATE_SNAPSHOT.json");
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  if (checkOnly) {
    const { users, tables } = transformSnapshot(snapshot);
    console.log(JSON.stringify({ users: users.length, ...Object.fromEntries(importOrder.map((name) => [name, tables[name].length])) }, null, 2));
  } else {
    for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
      if (!process.env[key]) throw new Error(`Missing ${key}`);
    }
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
      timezone: "Z", charset: "utf8mb4", dateStrings: true,
    });
    try { console.log(JSON.stringify(await importSnapshot(connection, snapshot), null, 2)); }
    finally { await connection.end(); }
  }
}
