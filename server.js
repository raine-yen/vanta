// Hostinger monitors the entry process for listen(). Open that listener before
// migrations and Next initialization, then serve Next in the same process.
const express = require("express");
const { chmod, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");
const mysql = require("mysql2/promise");

const publicPort = Number(process.env.PORT || 3000);
let nextHandler;
let nextApp;
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 2,
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use("/uploads", express.static(resolve(__dirname, "uploads"), { fallthrough: false }));
app.get("/health", async (_req, res) => {
  if (!nextHandler) return res.status(503).json({ ok: false });
  try {
    await pool.query("SELECT 1 AS ok");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.use((req, res) => {
  if (!nextHandler) return res.status(503).send("Vanta is starting");
  void Promise.resolve(nextHandler(req, res)).catch((error) => {
    console.error("Vanta request failed:", error);
    if (!res.headersSent) res.status(500).send("Vanta request failed");
  });
});

const listener = app.listen(publicPort, "0.0.0.0", () => {
  console.log(`Vanta gateway listening on ${publicPort}`);
});

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
async function writeCronEnvironment() {
  if (!process.env.APP_URL || !process.env.CRON_SECRET) {
    console.warn("Cron environment not written: APP_URL or CRON_SECRET is missing");
    return;
  }
  const accountHome = homedir().match(/^\/home\/[^/]+/)?.[0];
  if (!accountHome) throw new Error("Cannot locate a private Hostinger account directory for cron");
  const path = join(accountHome, "vanta-cron.env");
  await writeFile(path, `APP_URL=${shellQuote(process.env.APP_URL)}\nCRON_SECRET=${shellQuote(process.env.CRON_SECRET)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  console.log(`Private cron environment ready at ${path}`);
}

async function main() {
  await import("./scripts/migrate.mjs");
  await writeCronEnvironment();
  nextApp = require("next")({ dev: false, dir: __dirname, hostname: "127.0.0.1", port: publicPort });
  await nextApp.prepare();
  nextHandler = nextApp.getRequestHandler();
  console.log("Vanta ready on public gateway");
}

main().catch((error) => {
  console.error("Vanta startup failed:", error instanceof Error ? error.message : error);
  listener.close(() => process.exit(1));
});
process.on("SIGTERM", () => {
  nextHandler = null;
  void nextApp?.close();
  void pool.end();
  listener.close();
});
