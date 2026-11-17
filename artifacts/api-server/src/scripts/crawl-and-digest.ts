/**
 * One-shot production crawler worker.
 *
 * This process is intentionally separate from the HTTP server. Schedule it
 * with a Replit Scheduled Deployment; it performs one DB-locked crawl, sends
 * the digest, and exits so a failed run is visible to the scheduler.
 */
import { runScheduledCrawl, sendDigestEmail } from "../crawlers/scheduler.js";

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

async function main(): Promise<void> {
  log("crawler_worker_started");
  const result = await runScheduledCrawl();
  log("crawler_completed", { ...result });
  if (result.successfulSources.length === 0) {
    throw new Error(`No crawler source succeeded; failed=${result.failedSources.join(",") || "unknown"}`);
  }
  const digest = await sendDigestEmail(result.newItems);
  log("crawler_digest_finished", digest);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log("crawler_worker_failed", { error: message });
    process.exitCode = 1;
  })
  .finally(() => {
    // Scripts should terminate even when a driver leaves a keep-alive handle.
    setTimeout(() => process.exit(process.exitCode ?? 0), 0);
  });