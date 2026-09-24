// Called by four hPanel cron jobs with: node src/cron-handler.js <job>
const jobs = new Set(["tick", "snapshot", "predictions", "predictions-settle"]);
const job = process.argv[2];
if (!jobs.has(job)) {
  console.error("Usage: node src/cron-handler.js <tick|snapshot|predictions|predictions-settle>");
  process.exit(2);
}
const appUrl = process.env.APP_URL;
const secret = process.env.CRON_SECRET;
if (!appUrl || !secret) {
  console.error("APP_URL and CRON_SECRET must be set in the cron environment.");
  process.exit(2);
}
async function main() {
  try {
    const url = new URL(`/api/cron/${job}`, appUrl);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(55_000) });
    const body = await response.text();
    if (!response.ok) throw new Error(`${job} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    console.log(`${job}: ${body.slice(0, 500)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
