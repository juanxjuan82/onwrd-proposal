/** One-shot hourly cleanup for intake drafts abandoned for more than 24 hours. */
import { abandonExpiredDrafts } from "../crawlers/scheduler.js";

abandonExpiredDrafts()
  .then((count) => {
    console.log(JSON.stringify({ event: "abandoned_drafts_cleaned", count }));
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "abandoned_drafts_cleanup_failed", error: message }));
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 0);
  });