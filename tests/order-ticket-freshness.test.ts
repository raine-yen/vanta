import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("web market tickets refresh authoritative account and quote state before submitting", () => {
  const market = read("src/app/(app)/market/page.tsx");
  assert.match(market, /async function refreshOrderState\(\)/);
  assert.match(market, /await Promise\.all\(\[fetchAccount\(\), fetchQuotes\(\[symbol\], true\)\]\)/);
  assert.match(market, /onReview=\{refreshOrderState\}/);
  // One-tap flow: a single refresh-and-submit path (no separate review round).
  assert.equal(market.match(/const fresh = await onReview\(\);/g)?.length, 1);
  assert.doesNotMatch(market, /async function review\(\)/);
  assert.match(market, /async function submit\(\).*setSubmitting\(true\)/s);
  assert.match(market, /onClick=\{submit\}/);
  assert.match(market, /await onTraded\(\)/);
});

test("visible equities use authoritative polling with no interpolated presentation ticks", () => {
  const feed = read("src/lib/live-market.ts");
  assert.match(feed, /\/api\/live/);
  assert.match(feed, /OPEN_POLL_MS = 15_000/);
  assert.match(feed, /CLOSED_POLL_MS = 120_000/);
  assert.doesNotMatch(feed, /Math\.random|gaussian\(|source:\s*["']sim/);
});

test("charts preserve sharp linear geometry across web and Expo", () => {
  assert.match(read("src/app/(app)/market/page.tsx"), /<Area[^>]*type="linear"/);
  assert.match(read("mobile/src/screens.tsx"), /InteractiveLineChart/);
});

test("mobile refreshes account, position, and selected quote before review and before confirm", () => {
  const mobile = read("mobile/App.tsx");
  assert.match(mobile, /async function refreshOrderState\(\)/);
  assert.match(mobile, /Promise\.all\(\[/);
});

test("paper-account provisioning never rewrites an existing portfolio", () => {
  const provisioning = read("src/lib/ensure-paper-account.ts");
  const ensureBlock = provisioning.match(/export async function ensurePaperAccount[\s\S]*?\n}\n/)?.[0] ?? "";

  assert.match(ensureBlock, /\.upsert\([\s\S]*onConflict:\s*"user_id,competition_id"[\s\S]*ignoreDuplicates:\s*true/);
  assert.doesNotMatch(ensureBlock, /\.update\(/);
  assert.doesNotMatch(provisioning, /status: "active"/);
});

test("new paper accounts always receive the canonical $10,000 allocation", () => {
  const provisioning = read("src/lib/ensure-paper-account.ts");

  assert.match(provisioning, /const CANONICAL_STARTING_CASH = 10_000/);
  assert.match(provisioning, /cash: CANONICAL_STARTING_CASH/);
  assert.match(provisioning, /starting_cash: CANONICAL_STARTING_CASH/);
  assert.match(provisioning, /equity: CANONICAL_STARTING_CASH/);
});

test("dashboard replaces failed account loading with a recoverable error state", () => {
  const dashboard = read("src/app/(app)/dashboard/page.tsx");

  assert.match(dashboard, /setLoadError/);
  assert.match(dashboard, /if \(!r\.ok\)[\s\S]*setLoadError/);
  assert.match(dashboard, /catch[\s\S]*setLoadError/);
  assert.match(dashboard, /Could not load your paper portfolio/);
  assert.match(dashboard, /Try again/);
});

test("sign in and sign up provision through the authenticated client", () => {
  const provisioning = read("src/lib/ensure-paper-account.ts");
  const login = read("src/app/api/auth/login/route.ts");
  const signup = read("src/app/api/auth/signup/route.ts");
  const me = read("src/app/api/me/route.ts");
  const sessionUser = read("src/lib/session-user.ts");

  assert.match(provisioning, /ensurePaperAccount\(user: PaperUser, db: MySqlClient\)/);
  assert.match(login, /await ensurePaperAccount\(data\.user, sb\)/);
  assert.match(signup, /if \(data\.session\)[\s\S]*await ensurePaperAccount\(data\.user, sb\)/);
  assert.doesNotMatch(signup, /mysqlAdmin/);
  assert.doesNotMatch(signup, /from\("accounts"\)\.insert/);
  assert.match(me, /const db = await mysqlForRequest\(req\)/);
  assert.match(me, /await ensurePaperAccount\(user, db\)/);
  assert.match(sessionUser, /const sb = await mysqlForRequest\(req\)/);
  assert.doesNotMatch(sessionUser, /mysqlAdmin/);
});
