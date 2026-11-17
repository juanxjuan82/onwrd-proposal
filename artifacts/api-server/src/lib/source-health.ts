export type SourceHealthState = "healthy" | "inactive" | "failing" | "never_run";

export interface SourceHealthRun {
  id: number;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  itemsFound?: number | null;
}

export function deriveSourceHealth(
  source: { active: boolean; lastSuccessAt: Date | null },
  runs: SourceHealthRun[],
): {
  healthState: SourceHealthState;
  lastError: string | null;
  recentFailures: Array<{ id: number; at: Date; message: string | null }>;
  /** Consecutive most-recent successful runs in which the source listed nothing. */
  emptyRunStreak: number;
  /** Plain-language caution for a source that works but is finding nothing. */
  healthWarning: string | null;
} {
  const completedRuns = runs.filter((run) => run.status === "success" || run.status === "failed");
  const latestRun = completedRuns[0];
  const healthState: SourceHealthState = !source.active
    ? "inactive"
    : completedRuns.length === 0 && !source.lastSuccessAt
      ? "never_run"
      : latestRun?.status === "failed"
        ? "failing"
        : latestRun?.status === "success" || source.lastSuccessAt
          ? "healthy"
          : "never_run";

  // A run can succeed (the site answered) and still list nothing. One such run
  // may be genuine; several in a row usually mean the listing moved or changed.
  let emptyRunStreak = 0;
  for (const run of completedRuns) {
    if (run.status !== "success" || run.itemsFound == null || run.itemsFound > 0) break;
    emptyRunStreak++;
  }
  const healthWarning = healthState !== "healthy" || emptyRunStreak === 0
    ? null
    : emptyRunStreak >= 3
      ? `No tenders listed in the last ${emptyRunStreak} crawls — the listing page has probably moved or changed.`
      : "The last crawl reached the source but it listed no tenders.";

  return {
    healthState,
    emptyRunStreak,
    healthWarning,
    lastError: latestRun?.status === "failed" ? latestRun.errorMessage : null,
    recentFailures: completedRuns
      .filter((run) => run.status === "failed")
      .slice(0, 3)
      .map((run) => ({
        id: run.id,
        at: run.completedAt ?? run.startedAt,
        message: run.errorMessage,
      })),
  };
}