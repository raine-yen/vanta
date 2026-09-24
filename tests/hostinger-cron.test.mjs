import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import test from "node:test";

test("hPanel cron handler calls the expected endpoint with Bearer auth", async () => {
  const secret = randomBytes(24).toString("hex");
  let received = null;
  const server = createServer((req, res) => {
    received = { path: req.url, auth: req.headers.authorization };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["src/cron-handler.js", "predictions-settle"], {
        env: { ...process.env, APP_URL: `http://127.0.0.1:${address.port}`, CRON_SECRET: secret },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(received, { path: "/api/cron/predictions-settle", auth: `Bearer ${secret}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
