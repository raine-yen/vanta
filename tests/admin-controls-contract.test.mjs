import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const source = (relative) => readFile(join(root, relative), "utf8");

test("admin controls require authenticated administrator and expose bounded timeout/delete paths", async () => {
  const route = await source("src/app/api/admin/route.ts");
  assert.match(route, /user\.role !== "owner" && user\.role !== "manager"/);
  assert.match(route, /action === "timeout"/);
  assert.match(route, /duration_minutes must be an integer from 1 to 43200/);
  assert.match(route, /suspended_until: suspendedUntil/);
  assert.match(route, /action === "delete_user"/);
  assert.match(route, /action === "delete_users"/);
  assert.match(route, /select at least one account/);
  assert.match(route, /slice\(0, 100\)/);
  assert.match(route, /action === "reset"/);
  assert.match(route, /from\("prediction_positions"\)\.delete\(\)/);
  assert.match(route, /from\("prediction_fills"\)\.delete\(\)/);
  assert.match(route, /cannot delete your own admin account/);
  assert.match(route, /auth\.admin\.deleteUser/);
});

test("admin page makes timeout and permanent deletion explicit confirmation actions", async () => {
  const page = await source("src/app/(app)/admin/page.tsx");
  assert.match(page, /Timeout account for 24 hours/);
  assert.match(page, /Permanently delete user/);
  assert.match(page, /Delete selected/);
  assert.match(page, /Select all removable users shown/);
  assert.match(page, /Permanently Delete \$\{pendingAction\.accountIds/);
  assert.match(page, /This permanently removes the auth user/);
});
