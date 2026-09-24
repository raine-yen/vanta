import express, { type Request, type Response } from "express";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { NextRequest } from "next/server";
import { requestContext } from "@/lib/request-context";
import { query } from "@/lib/mysql";

type ApiRoute = { pattern: RegExp; params: string[]; file: string };

function findRoutes(root: string, prefix: string): ApiRoute[] {
  const routes: ApiRoute[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === "route.ts") {
        const parts = relative(root, directory).split(/[\\/]/).filter(Boolean);
        const params: string[] = [];
        const routePath = `${prefix}/${parts.map((part) => {
          const param = part.match(/^\[(.+)\]$/)?.[1];
          if (param) { params.push(param); return "([^/]+)"; }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("/")}`.replace(/\/$/, "");
        routes.push({ pattern: new RegExp(`^${routePath}/?$`), params, file });
      }
    }
  }
  walk(root);
  return routes;
}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use("/uploads", express.static(resolve("uploads"), { fallthrough: false }));
const routes = [
  ...findRoutes(resolve("src/app/api"), "/api"),
  ...findRoutes(resolve("src/app/v2"), "/v2"),
];
const modules = new Map<string, Promise<Record<string, unknown>>>();

app.get("/health", async (_req, res) => {
  try { await query("SELECT 1 AS ok"); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use(async (req: Request, res: Response, next) => {
  if (!req.path.startsWith("/api/") && !req.path.startsWith("/v2/")) return next();
  if (req.path.startsWith("/v2/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, APCA-API-KEY-ID, APCA-API-SECRET-KEY, Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  const found = routes.map((route) => ({ route, match: req.path.match(route.pattern) })).find((entry) => entry.match);
  if (!found?.match) return res.status(404).json({ error: "not found" });
  const params = Object.fromEntries(found.route.params.map((name, index) => [name, decodeURIComponent(found.match![index + 1])]));
  const modulePromise = modules.get(found.route.file) ?? import(pathToFileURL(found.route.file).href);
  modules.set(found.route.file, modulePromise);
  try {
    const handler = (await modulePromise)[req.method] as ((request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<globalThis.Response>) | undefined;
    if (!handler) return res.status(405).json({ error: "method not allowed" });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const protocol = req.protocol === "https" ? "https" : "http";
    const host = req.headers.host ?? "localhost";
    const url = `${protocol}://${host}${req.originalUrl}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const nextReq = new NextRequest(url, { method: req.method, headers, body: body.length ? body : undefined, duplex: "half" } as any);
    await requestContext.run({
      cookieHeader: req.headers.cookie ?? "",
      authorization: req.headers.authorization ?? null,
      setCookie: (value) => res.append("Set-Cookie", value),
    }, async () => {
      const output = await handler(nextReq, { params: Promise.resolve(params) });
      res.status(output.status);
      output.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie" && res.hasHeader("Set-Cookie")) return;
        res.setHeader(name, value);
      });
      res.end(Buffer.from(await output.arrayBuffer()));
    });
  } catch (error) {
    console.error("API request failed", req.method, req.path, error);
    if (!res.headersSent) res.status(500).json({ error: "internal server error" });
  }
});

const nextPort = Number(process.env.NEXT_PORT || 3001);
app.use((req, res) => {
  const proxy = httpRequest({ hostname: "127.0.0.1", port: nextPort, path: req.originalUrl, method: req.method, headers: req.headers }, (upstream) => {
    res.status(upstream.statusCode ?? 502);
    for (const [name, value] of Object.entries(upstream.headers)) if (value !== undefined) res.setHeader(name, value);
    upstream.pipe(res);
  });
  proxy.on("error", () => { if (!res.headersSent) res.status(502).send("Frontend is starting"); });
  req.pipe(proxy);
});

const nextBinary = resolve("node_modules/next/dist/bin/next");
const next = spawn(process.execPath, [nextBinary, "start", "-p", String(nextPort), "-H", "127.0.0.1"], { stdio: "inherit", env: process.env, windowsHide: true });
next.on("exit", (code) => { console.error(`next start exited (${code})`); process.exit(code ?? 1); });
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`Vanta Express API listening on ${port}; Next frontend on ${nextPort}`));
process.on("SIGTERM", () => next.kill("SIGTERM"));
