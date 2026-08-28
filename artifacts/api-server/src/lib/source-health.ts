export type SourceHealthState = "healthy" | "inactive" | "failing" | "never_run";

export interface SourceHealthRun {
  id: number;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}

export function deriveSourceHealth(
  source: { active: boolean; lastSuccessAt: Date | null },
  runs: SourceHealthRun[],
): {
  healthState: SourceHealthState;
  lastError: string | null;
  recentFailures: Array<{ id: number; at: Date; message: string | null }>;
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

  return {
    healthState,
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