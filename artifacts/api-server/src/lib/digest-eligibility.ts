import { evaluateCrawlerEligibility } from "./crawler-eligibility.js";

type DigestTender = {
  opportunityId: number | null;
  title: string;
  description: string;
  recommendation: string | null;
  deadline: Date | string | null;
};

/**
 * The digest is an actionable opportunity feed, not a raw discovery feed.
 * Keep a second deterministic eligibility check here so records promoted by
 * older code or manual routes cannot reintroduce individual hires.
 */
export function isActionableDigestTender(tender: DigestTender): boolean {
  if (
    tender.opportunityId === null ||
    (tender.recommendation !== "PURSUE" && tender.recommendation !== "CONSIDER")
  ) {
    return false;
  }

  return evaluateCrawlerEligibility({
    title: tender.title,
    description: tender.description,
    recommendation: tender.recommendation,
    deadline: tender.deadline,
  }).eligible;
}

export function filterActionableDigestTenders<T extends DigestTender>(tenders: T[]): T[] {
  return tenders.filter(isActionableDigestTender);
}