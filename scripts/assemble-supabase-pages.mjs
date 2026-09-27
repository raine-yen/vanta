// Combine the private, paginated Supabase connector export into one import file.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { importOrder, transformSnapshot } from "./import-supabase-json.mjs";

const directory = resolve(process.argv[2] || "private-migration");
const pageSize = 100;
const names = ["auth_users", ...importOrder];
const files = await readdir(directory);
const snapshot = { auth_users: [], tables: {} };
const counts = {};

for (const name of names) {
  const pages = files.filter((file) => new RegExp(`^${name}\\.\\d{3}\\.json$`).test(file)).sort();
  if (!pages.length) throw new Error(`Missing ${name} pages`);
  const rows = [];
  let lastPageLength = 0;
  for (let index = 0; index < pages.length; index++) {
    if (pages[index] !== `${name}.${String(index).padStart(3, "0")}.json`) {
      throw new Error(`${name} has a missing page`);
    }
    const page = JSON.parse(await readFile(join(directory, pages[index]), "utf8"));
    if (!Array.isArray(page) || page.length > pageSize) throw new Error(`Invalid ${name} page`);
    if (index < pages.length - 1 && page.length !== pageSize) throw new Error(`Short nonfinal ${name} page`);
    lastPageLength = page.length;
    rows.push(...page);
  }
  if (lastPageLength === pageSize) throw new Error(`${name} export may be missing its final empty page`);
  const key = name === "prices" ? "symbol" : "id";
  if (new Set(rows.map((row) => row[key])).size !== rows.length) throw new Error(`${name} has duplicate ${key} values`);
  if (name === "auth_users") snapshot.auth_users = rows;
  else snapshot.tables[name] = rows;
  counts[name] = rows.length;
}

transformSnapshot(snapshot);
const output = join(directory, "snapshot.json");
await writeFile(output, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ output, counts }, null, 2));
