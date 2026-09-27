# Vanta on Hostinger

Vanta runs one public Express process for `/api/*` and `/v2/*`; it starts the existing Next.js frontend with `next start` on a private loopback port. `npm run build` remains `next build`. The API uses MySQL; market quotes and charts continue to use `yahoo-finance2`. Internal database IDs are `CHAR(36)`; Polymarket condition IDs are stored separately as external keys.

## 1. Prepare the repository and hosting plan

The release source is on the GitHub branch `release/vanta-production`, and a source-only upload is staged at `private-migration/vanta-hostinger-source.zip`. Check the signed-in Hostinger account for an active plan that supports Node.js web apps, then select an existing site or create one on the plan. Use a free Hostinger subdomain if no domain has been chosen. Deploy the source archive with the Hostinger Connector, choose Node.js **22**, and configure `server.js` as the entry file. The archive contains no build output or private data. Hostinger's [Node.js deployment guide](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/) also describes connecting GitHub later for deployment on push; an archive deployment alone does not enable that link.

In build settings, use the project root, `npm run build`, and **`server.js` as the entry file** (or `npm start` if the panel asks for a start command). If automatic Node.js detection selects the Next.js entry point, override the build settings before starting the build. Keep the Next build output `.next` available to the app; do not use a static export. Check the first build log to confirm the `next build` and `Vanta Express API listening` messages.

## 2. Create MySQL

Create a MySQL database and user assigned to the site. Record the **full prefixed** database and user names and password. Hostinger's [MySQL setup guide](https://www.hostinger.com/support/1583542-how-to-create-a-new-mysql-database-in-hostinger/) notes that names are prefixed by the hosting account. The Node.js app connects to `127.0.0.1:3306` on the hosting server. The hostname returned by the account database listing is for external connections only. MySQL 8 is required by the JSON columns and schema syntax.

## 3. Set application environment variables

In the web app's **Environment variables** section, set:

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DB_HOST` | `127.0.0.1` for the Node.js app on Hostinger |
| `DB_PORT` | `3306`, unless hPanel shows a different port |
| `DB_NAME` | Full prefixed database name |
| `DB_USER` | Full prefixed database user |
| `DB_PASSWORD` | Database password |
| `CRON_SECRET` | A newly generated long random secret, kept only in hPanel/private cron configuration |
| `APP_URL` | The site's public HTTPS origin, such as `https://your-domain.example` |
| `NEXT_PORT` | `3001` unless that private loopback port is already occupied |

Do not set old `NEXT_PUBLIC_SUPABASE_*` or `SUPABASE_SERVICE_ROLE_KEY` values. Database credentials and the cron secret must never be committed. Hostinger documents [environment variables](https://www.hostinger.com/support/how-to-add-environment-variables-during-node-js-application-deployment/) and [MySQL connection settings](https://www.hostinger.com/support/connecting-a-hostinger-mysql-database-to-a-node-js-application/).

## 4. Run and verify migrations

`server.js` runs `scripts/migrate.mjs` before starting the API. It applies numbered files in `database/migrations/` once, records SHA-256 checksums in `schema_migrations`, and refuses to continue if an already applied migration was edited. The first deployment must show `Applied 001_initial_schema.sql` and `Applied 002_community_businesses.sql` in the application log. A later restart should show no new `Applied` lines.

If the Node app cannot create tables, check that the MySQL user is assigned to this database with DDL rights. If Hostinger's managed app environment does not retain the project root as its working directory, set the app root to the repository root; the migration runner resolves `database/migrations/` from there. The SQL files are MySQL only. `supabase/migrations/` is a historical reference and must not be imported into MySQL.

If starting with an empty installation, promote the intended first owner **once** in phpMyAdmin:

```sql
UPDATE users SET role = 'owner' WHERE email = 'OWNER_EMAIL_HERE';
```

Use the real account email only in phpMyAdmin; do not put it in a committed file. Other staff can be assigned `manager`. API admin routes check these database roles.

## 5. Create the four hPanel cron jobs

In **Websites → Dashboard → Cron Jobs**, select **Custom** for each job. Hostinger [schedules cron in UTC](https://www.hostinger.com/support/1583465-how-to-set-up-a-cron-job-at-hostinger/). These schedules preserve the former Vercel cron times:

| Job argument | UTC schedule | Endpoint |
| --- | --- | --- |
| `tick` | `0 13 * * *` | `/api/cron/tick` |
| `snapshot` | `5 13 * * *` | `/api/cron/snapshot` |
| `predictions` | `10 13 * * *` | `/api/cron/predictions` |
| `predictions-settle` | `15 13 * * *` | `/api/cron/predictions-settle` |

Each cron command calls `node src/cron-handler.js JOB` from the deployed project directory. That script sends `Authorization: Bearer <CRON_SECRET>` to `APP_URL` and exits nonzero on failure. Cron jobs may not inherit the web app's environment. Put `APP_URL` and `CRON_SECRET` assignments in a private `/home/USERNAME/vanta-cron.env` file outside the repository and web root, and set its permissions to `600`. Use the hPanel Custom command below for each job, replacing `USERNAME`, `DOMAIN`, and `tick` with the actual hosting values and job argument:

```sh
bash -lc 'set -a; . /home/USERNAME/vanta-cron.env; set +a; cd /home/USERNAME/domains/DOMAIN/nodejs && node src/cron-handler.js tick'
```

Do not paste the secret into GitHub or into this document. Check the Cron Jobs output after the first run. If the managed cron environment cannot run Node from the deployed app directory, use a custom `curl` command with the same Bearer header and private environment file. Hostinger documents the [managed Node app directory](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/) and [Custom cron jobs](https://www.hostinger.com/support/1583465-how-to-set-up-a-cron-job-at-hostinger/).

The cron endpoints reject requests when `CRON_SECRET` is absent or the Bearer token is wrong. Set the same secret for the app and cron jobs.

## 6. Check the deployment

1. Open `https://YOUR_DOMAIN/` and confirm the Vanta page renders.
2. Open `https://YOUR_DOMAIN/health` and confirm `{ "ok": true }` (MySQL connectivity).
3. Confirm `GET /api/cron/tick` without authorization returns 401.
4. Sign up, sign in, and load `/api/me`, `/api/competitions`, `/api/leaderboard`, `/api/chart?symbol=AAPL&range=1mo`, and a prediction market page.
5. Place a small **paper** order, verify the order and fill rows in MySQL, and check the same portfolio in the Next frontend.
6. Confirm all four cron jobs show successful output.

The app uses `PORT` supplied by Hostinger for the public Express listener. It uses `NEXT_PORT` only on `127.0.0.1`; do not expose that port. The app stores uploaded avatars under `uploads/`. Configure persistent storage or a backup for that directory if the Hostinger deployment replaces app files on each push.

## Data migration and rollback

The schema migration creates a fresh MySQL database. Before directing users to Hostinger, export the live Supabase project into a private JSON file with `auth_users` and `tables` keys. `auth_users` must contain `id`, `email`, `encrypted_password`, `raw_user_meta_data`, `raw_app_meta_data`, and `created_at` from `auth.users`. `tables` must contain complete row arrays for every table named in `scripts/import-supabase-json.mjs` under `importOrder`. Export all pages of the larger tables, including prediction markets and equity snapshots. The Supabase connector export uses 100 rows per page, names each file `TABLE.000.json`, `TABLE.001.json`, and so on, and writes a final short or empty page. `node scripts/assemble-supabase-pages.mjs private-migration` validates those pages and writes `private-migration/snapshot.json`. Save these files only under ignored `private-migration/` or another private location, and keep them out of Git and the deployment archive.

Run `node scripts/import-supabase-json.mjs --check private-migration/snapshot.json` to validate completeness and foreign-key references without a database connection. After the MySQL migrations have run, import into a fresh database with `node scripts/import-supabase-json.mjs PRIVATE_SNAPSHOT.json` from an environment containing `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. To run the importer locally, allow only this machine's current public IP as a temporary Hostinger database remote connection and use the external hostname from the database listing. Remove that remote connection immediately after import and count verification; never allow `%` or all internet hosts. The importer copies the Supabase Auth bcrypt hashes, preserves user and account UUIDs, maps external prediction IDs to internal MySQL UUIDs, checks foreign keys through MySQL, and verifies row counts before committing. Users keep their passwords but must sign in again because sessions are not migrated. The former Supabase admin emails are mapped to `owner`; verify the owner role after import.

Take a final fresh export immediately before cutover so late orders and messages are included. Compare source and destination counts for users, accounts, orders, fills, positions, prediction markets, prediction fills, snapshots, and messages. Keep the Vercel/Supabase site available until sign-in, portfolio, paper trading, prediction positions, and cron jobs work on Hostinger. A code rollback through Hostinger GitHub deployment does not reverse database migrations; restore the MySQL backup if a database rollback is needed.
