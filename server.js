// Hostinger entry file. Build remains `next build`; this starts Express and
// its `next start` child after applying pending MySQL migrations.
const { spawn } = require("node:child_process");

async function main() {
  await import("./scripts/migrate.mjs");
  const child = spawn(process.execPath, [require.resolve("tsx/cli"), "src/server.ts"], {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

main().catch((error) => {
  console.error("Vanta startup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
