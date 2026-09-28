# Continue the Vanta Hostinger migration

Use this prompt in the Codex/ChatGPT computer session that has access to the local project and Hostinger Connector:

> Continue the authorized migration of the exact Vanta site at `https://playvanta.vercel.app` and its Supabase data to Hostinger. Work in `C:\Users\raine_5tga1yf\vanta-release`. Read `HOSTINGER_DEPLOYMENT.md` and the Hostinger `hostinger` and `websites` skills, then use the Hostinger Connector for account and hosting operations. The owner will click **Allow** on a fresh Hostinger OAuth consent screen. Do not rely on the old consent URL; its tool call timed out. Check the hosting plan and websites first. If the Hostinger hosting tools are absent, all nine Hostinger MCP servers are already registered in `%USERPROFILE%\.codex\config.toml`; restart the desktop app to load them, then retry `hosting_listWebsitesV1`. Do not use direct API calls as a workaround. Use an existing suitable site or a free Hostinger subdomain if no custom domain is selected. Provision MySQL, configure the Node app, deploy the source, import a final fresh Supabase export, configure cron, and verify the live site and data. Do not buy a plan or domain without a separate explicit request. Keep the Vercel/Supabase site available until Hostinger is verified.

## Prepared state

- GitHub repository: `https://github.com/raine-yen/vanta`, branch `release/vanta-production`.
- Check `git status --short --branch` and verify that `HEAD` matches `origin/release/vanta-production` before deployment.
- Hostinger source archive: `private-migration/vanta-hostinger-source.zip`. SHA-256: `afb5d965f37413ddfa33dc0dbf9b0bc05b7bd66334c45f39049f360ee4056093`. The 131 source files in it matched the working tree. It has no `node_modules`, `.next`, `.env`, uploads, or private migration data.
- Private Supabase export: `private-migration/snapshot.json`. It passed `node scripts/import-supabase-json.mjs --check private-migration/snapshot.json`. All 16 source row counts still matched the export when checked on 2026-09-27; refresh all pages at cutover because rows can change.
- Local `npm ci`, typecheck, build, and tests passed during preparation. The local landing page matched the Vercel site at desktop and mobile widths.

## Deployment details

- Node.js 22, project root, build script `npm run build`, entry file `server.js` (Express API starts Next.js on private loopback). Use Hostinger's explicit build settings if automatic detection selects plain Next.js.
- MySQL is local to the deployed Node app at `127.0.0.1:3306`. Set `NODE_ENV=production`, `DB_HOST=127.0.0.1`, `DB_PORT=3306`, full prefixed `DB_NAME` and `DB_USER`, `DB_PASSWORD`, random `CRON_SECRET`, HTTPS `APP_URL`, and `NEXT_PORT=3001`. Never commit secrets. Hostinger supplies the public `PORT`.
- `server.js` runs `database/migrations/` before starting. The importer is `scripts/import-supabase-json.mjs`. For a local import, temporarily allow only this computer's public IP for Hostinger MySQL remote access, use the external database host, then remove the rule immediately after verification. Do not allow `%`.
- Configure daily UTC crons: `tick` at `0 13 * * *`, `snapshot` at `5 13 * * *`, `predictions` at `10 13 * * *`, and `predictions-settle` at `15 13 * * *`. See `HOSTINGER_DEPLOYMENT.md` for private cron environment and commands.
- Verify the real Vanta page, `/health`, authentication with migrated bcrypt passwords, account data, paper trading, prediction positions, cron authorization, and source/destination row counts. Only report completion after the public Hostinger site and data work.
