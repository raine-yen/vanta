import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";

const required = ["DB_HOST", "DB_USER", "DB_NAME", "DB_PASSWORD"];
for (const key of required) if (process.env[key] === undefined || process.env[key] === "") throw new Error(`Missing ${key}`);

const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  timezone: "Z",
});

function statements(contents) {
  const withoutComments = contents.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("--")).join("\n");
  return withoutComments.split(";").map((sql) => sql.trim()).filter(Boolean);
}

try {
  const [[lock]] = await connection.query("SELECT GET_LOCK('vanta_schema_migrations', 30) AS acquired");
  if (lock.acquired !== 1) throw new Error("Could not acquire migration lock");
  await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const directory = resolve("database/migrations");
  for (const filename of (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    const contents = await readFile(resolve(directory, filename), "utf8");
    const checksum = createHash("sha256").update(contents).digest("hex");
    const [existing] = await connection.query("SELECT checksum FROM schema_migrations WHERE filename = ?", [filename]);
    if (existing.length) {
      if (existing[0].checksum !== checksum) throw new Error(`Applied migration changed: ${filename}`);
      continue;
    }
    for (const sql of statements(contents)) await connection.query(sql);
    await connection.query("INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)", [filename, checksum]);
    process.stdout.write(`Applied ${filename}\n`);
  }
} finally {
  await connection.query("SELECT RELEASE_LOCK('vanta_schema_migrations')").catch(() => {});
  await connection.end();
}
