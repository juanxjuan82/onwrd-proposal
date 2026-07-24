import app, { dbReady } from "./app";
import { logger } from "./lib/logger";
import { startScheduler } from "./crawlers/scheduler.js";
import { recoverStaleAnalysisJobs } from "./lib/analysis-recovery.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Wait for session store DDL before accepting connections.
// If initialization fails the promise rejects — refuse to listen.
try {
  await dbReady;
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  logger.error({ reason }, "Session store initialization failed — server will not start");
  process.exit(1);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void recoverStaleAnalysisJobs();
  void startScheduler();
});
