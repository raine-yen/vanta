// Hostinger monitors the entry process for listen(). Serve a startup response
// immediately, then route traffic to Vanta once migrations and Next are ready.
const express = require("express");
const { spawn } = require("node:child_process");
const { chmod, writeFile } = require("node:fs/promises");
const http = require("node:http");
const { homedir } = require("node:os");
const { join } = require("node:path");

const publicPort = Number(process.env.PORT || 3000);
const apiPort = Number(process.env.API_PORT || 3002);
let ready = false;
let child;

const app = express();
app.disable("x-powered-by");
app.use((req, res) => {
  if (!ready) return res.status(503).send("Vanta is starting");
  const proxy = http.request({
    hostname: "127.0.0.1",
    port: apiPort,
    path: req.originalUrl,
    method: req.method,
    headers: req.headers,
  }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on("error", (error) => {
    console.error("Vanta proxy failed:", error.message);
    if (!res.headersSent) res.status(502).send("Vanta is restarting");
  });
  req.pipe(proxy);
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
  child = spawn(process.execPath, [require.resolve("tsx/cli"), "src/server.ts"], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(apiPort) },
    windowsHide: true,
  });
  child.on("exit", (code) => {
    ready = false;
    console.error(`Vanta server exited (${code})`);
    process.exit(code || 1);
  });
  ready = true;
  console.log("Vanta gateway routing to the API");
}

main().catch((error) => {
  console.error("Vanta startup failed:", error instanceof Error ? error.message : error);
  listener.close(() => process.exit(1));
});
process.on("SIGTERM", () => {
  ready = false;
  child?.kill("SIGTERM");
  listener.close();
});
