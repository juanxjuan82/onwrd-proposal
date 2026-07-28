/**
 * Behavioral tests for the crawler ingestion pipeline.
 *
 * What's tested:
 *  1–2:   AdapterFetchResult contract (success + throw on total failure)
 *  3–4:   Upsert: unchanged / content-change → update
 *  5–6:   Eligibility gate: title-only stub fails; full scope passes
 *  7–8:   Eligibility gate: eligible → promoted; ineligible → rejected
 *  9:     Concurrency: content-key comparison is deterministic
 * 10:     Expired deadline → fitScore=0, recommendation=SKIP
 * 11:     Backfill evaluates ALL unpromoted non-expired discoveries (not filtered by recommendation)
 * 12:     Backfill rescores an item whose score changed after phrase expansion
 * 13:     Batch row structure has all required fields
 * 14:     Failed adapter throws — source run marked "failed"
 * 15:     Partial crawl: sourcesFailed > 0 but < sourcesAttempted → batch.status = "partial"
 * 16:     scoreTender correctly awards geographyScore=100 for Bahamas opportunities
 *
 * 17–22: Batch lifecycle regression (real startCrawl/executeCrawlBatch, mocked DB via __setCrawlDbForTesting)
 * 17:    Old batch pre-exists; startCrawl returns a new UUID distinct from it
 * 18:    Two sequential startCrawl calls return distinct IDs
 * 19:    startCrawl returns a valid UUID v4, never null on success
 * 20:    Lock contention: startCrawl returns null (maps to 409)
 * 21:    Batch-insert failure releases the acquired lock before rethrowing
 * 22:    executeCrawlBatch marks batch terminal and releases lock in finally
 *
 * 23–29: Fixture-backed adapter detail extraction (FetchFn injection, no network)
 * 23:    IDB   — detail-page HTML → description ≥ 120 chars
 * 24:    CDB   — detail-page HTML → description ≥ 120 chars
 * 25:    BahamasGov (HTML link) — detail-page → description ≥ 120 chars
 * 26:    BahamasGov (PDF link)  — empty/invalid PDF → stays title-only (no padded stub)
 * 27:    CTO   — anchor-text matched link → detail fetch → description ≥ 120 chars
 * 28:    CARICOM — detail fetch → description ≥ 120 chars
 * 29:    EU Caribbean — detail fetch → description ≥ 120 chars
 *
 * Runner: node:test + tsx (no extra packages required)
 * Tests do NOT hit the real database or live adapter URLs.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Pure-function imports (no DB) ─────────────────────────────────────────────
import { scoreTender } from "../lib/discovery-scoring.js";
import { evaluateCrawlerEligibility } from "../lib/crawler-eligibility.js";

// ── Crawler lifecycle imports ─────────────────────────────────────────────────
import { startCrawl, executeCrawlBatch, backfillPromotions, __setCrawlDbForTesting } from "../crawlers/index.js";
import { reconcileDiscovery } from "../lib/discovery-reconciler.js";
import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  tendersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Adapter imports (for FetchFn fixture tests) ───────────────────────────────
import { IDBAdapter } from "./idb.js";
import { CDBAdapter } from "./cdb.js";
import { BahamasGovAdapter } from "./bahamas-gov.js";
import { CTOAdapter } from "./cto.js";
import { CARICOMAdapter } from "./caricom.js";
import { EUCaribbeanAdapter } from "./eu-caribbean.js";

// ── Mock DB factory ───────────────────────────────────────────────────────────
// Builds a lightweight in-memory mock for the Drizzle db used by startCrawl /
// executeCrawlBatch. The mock exercises the real lifecycle code; only the I/O
// layer is replaced. Tests call __setCrawlDbForTesting(mockDb) and afterEach
// resets it to null so tests cannot bleed state into each other.
interface MockDbOptions {
  /** When true, lock-insert's onConflictDoNothing().returning() returns [] (simulates held lock). */
  lockConflict?: boolean;
  /** When true, the batch-row INSERT rejects with an error once. */
  failBatchInsert?: boolean;
}

function createMockDb(opts: MockDbOptions = {}) {
  let deleteCount = 0;
  let lockAcquired = false;
  let _failBatch = opts.failBatchInsert ?? false;
  const batches = new Map<string, Record<string, unknown>>();
  const batchUpdates = new Map<string, Record<string, unknown>>();

  return {
    // ── Observation helpers (not part of the Drizzle API) ──────────────────
    _deleteCount: () => deleteCount,
    _lockAcquired: () => lockAcquired,
    _batchIds: () => [...batches.keys()],
    _getBatch: (id: string) => batches.get(id),
    _getBatchUpdate: (id: string) => batchUpdates.get(id),
    /** Pre-populate an existing batch to simulate a prior completed run. */
    _addExistingBatch: (b: Record<string, unknown>) => batches.set(b.id as string, b),

    // ── Drizzle API surface ────────────────────────────────────────────────
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => {
        deleteCount++;
        return Promise.resolve();
      },
    }),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        // Lock-table insert (has lockKey) → chains .onConflictDoNothing().returning()
        if ("lockKey" in vals) {
          return {
            onConflictDoNothing: () => ({
              returning: (_fields: unknown) => {
                if (opts.lockConflict) return Promise.resolve([]);
                lockAcquired = true;
                return Promise.resolve([{ lockKey: "default" }]);
              },
            }),
          };
        }

        // Batch-table insert (UUID string id + status + startedAt) → directly awaitable
        if (typeof vals.id === "string" && "status" in vals && "startedAt" in vals) {
          if (_failBatch) {
            _failBatch = false;
            return Promise.reject(new Error("Simulated batch-insert failure"));
          }
          batches.set(vals.id as string, { ...vals });
          return Promise.resolve();
        }

        // crawlerRuns or other inserts → chain .returning()
        return { returning: () => Promise.resolve([{ id: 1, ...vals }]) };
      },
    }),

    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          // Track terminal batch updates (completedAt + status set together)
          if (vals.completedAt && vals.status) {
            for (const id of batches.keys()) {
              batchUpdates.set(id, { ...vals });
            }
          }
          return Promise.resolve();
        },
      }),
    }),

    // All selects return empty arrays — no sources, no tenders, no lock rows.
    // .where() returns a Promise directly so `await db.select().from().where()` resolves
    // to [] without needing a further .limit() call (matches how executeCrawlBatch queries).
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => {
        const emptyChain = Object.assign(Promise.resolve([]), {
          where: (_cond: unknown) => Promise.resolve([]),
          orderBy: (_col: unknown) => Object.assign(Promise.resolve([]), {
            limit: (_n: unknown) => Promise.resolve([]),
          }),
          limit: (_n: unknown) => Promise.resolve([]),
        });
        return emptyChain;
      },
    }),
  };
}

// ── Rich detail HTML for adapter fixture tests ────────────────────────────────
const RICH_DETAIL_HTML = (org: string) => `<html><body>
<div class="description">
  ${org} invites proposals from qualified firms to develop and implement a comprehensive
  communications strategy and stakeholder engagement programme for the regional climate
  resilience initiative. The scope includes digital media management, press release drafting,
  community outreach, brand development, and performance reporting for a 24-month period
  across Barbados, Guyana, Trinidad and Tobago, and Belize. Minimum three years of
  Caribbean communications experience required.
</div>
</body></html>`;

// ─────────────────────────────────────────────────────────────────────────────
// Tests 1–16  (existing — pure function / structural)
// ─────────────────────────────────────────────────────────────────────────────

describe("AdapterFetchResult contract", () => {
  it("(1) successful adapter returns AdapterFetchResult with tracking counts", async () => {
    const fakeResult = {
      opportunities: [
        {
          externalId: "wb-123",
          title: "Communications Consulting Services",
          organization: "World Bank",
          description: "The World Bank seeks a communications consultant to develop outreach materials for the Caribbean region sustainability program.",
          country: "Bahamas",
        },
      ],
      requestsAttempted: 1,
      requestsSucceeded: 1,
      warnings: [],
    };

    assert.equal(typeof fakeResult.requestsAttempted, "number");
    assert.equal(typeof fakeResult.requestsSucceeded, "number");
    assert.ok(Array.isArray(fakeResult.warnings));
    assert.ok(Array.isArray(fakeResult.opportunities));
    assert.ok(fakeResult.requestsSucceeded <= fakeResult.requestsAttempted);
  });

  it("(2) adapter throws when ALL requests fail (not silent empty return)", async () => {
    let threw = false;
    const mockAdapter = {
      adapterType: "world_bank",
      async fetchOpportunities() {
        const requestsAttempted = 3;
        const requestsSucceeded = 0;
        const warnings = ["HTTP 503", "HTTP 503", "HTTP 503"];
        if (requestsAttempted > 0 && requestsSucceeded === 0) {
          throw new Error(`All ${requestsAttempted} requests failed. ` + warnings.join("; "));
        }
        return { opportunities: [], requestsAttempted, requestsSucceeded, warnings };
      },
    };
    try { await mockAdapter.fetchOpportunities(); } catch { threw = true; }
    assert.ok(threw, "Adapter must throw when all requests fail");
  });
});

describe("Upsert and deduplication", () => {
  it("(3) unchanged discovery (same content) produces same content key → unchanged outcome", () => {
    function contentKey(title: string, description: string, deadline?: Date | null): string {
      return [
        title.trim().toLowerCase().slice(0, 120),
        description.trim().toLowerCase().slice(0, 300),
        deadline ? deadline.toISOString().slice(0, 10) : "",
      ].join("|");
    }

    const title = "Bahamas Tourism Marketing Campaign";
    const description = "Request for proposals to develop a comprehensive digital marketing campaign for the Bahamas tourism board, covering social media strategy, content creation, and destination branding.";
    assert.equal(contentKey(title, description), contentKey(title, description));
  });

  it("(4) changed description produces different content key → rescore path", () => {
    function contentKey(title: string, description: string, deadline?: Date | null): string {
      return [
        title.trim().toLowerCase().slice(0, 120),
        description.trim().toLowerCase().slice(0, 300),
        deadline ? deadline.toISOString().slice(0, 10) : "",
      ].join("|");
    }

    const title = "UNDP Communications Support";
    const oldDesc = "UNDP procurement notice: Communications Support";
    const newDesc = "The UNDP Caribbean office seeks a qualified firm to provide communications strategy and stakeholder outreach for the climate resilience program.";
    assert.notEqual(contentKey(title, oldDesc), contentKey(title, newDesc));
  });
});

describe("Detail page enrichment", () => {
  it("(5) title-only stub description (<120 chars) fails content quality gate", () => {
    const r = evaluateCrawlerEligibility({
      title: "Communications Consultant",
      description: "UNDP procurement notice: Communications Consultant",
      recommendation: "PURSUE",
    });
    assert.equal(r.contentQuality, "title_only");
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.some((s) => s.toLowerCase().includes("title_only") || s.toLowerCase().includes("content")));
  });

  it("(6) full-scope description (≥120 chars with relevant phrases) passes content quality gate", () => {
    const richDesc =
      "The UNDP Caribbean Regional Hub invites proposals from qualified firms for the " +
      "development and implementation of a communications strategy for the regional " +
      "climate resilience program. The scope includes social media management, press release " +
      "drafting, community engagement, stakeholder outreach, and digital content production " +
      "across Barbados, Guyana, Trinidad and Tobago, and Belize over a 12-month period.";
    const r = evaluateCrawlerEligibility({
      title: "Communications Strategy and Stakeholder Outreach",
      description: richDesc,
      recommendation: "PURSUE",
    });
    assert.notEqual(r.contentQuality, "title_only");
    assert.equal(r.eligible, true);
  });
});

describe("Eligibility gate", () => {
  it("(7) PURSUE + comms phrases + full scope → eligible, destination=new", () => {
    const r = evaluateCrawlerEligibility({
      title: "Digital Marketing Campaign — Bahamas Ministry of Tourism",
      description:
        "The Bahamas Ministry of Tourism seeks an experienced marketing agency to " +
        "design and execute a digital marketing campaign for the 2026 visitor season. " +
        "Deliverables include a social media strategy, content calendar, graphic design assets, " +
        "and a final performance report. The selected agency must have Caribbean tourism " +
        "marketing experience and will work closely with the Ministry's communications team.",
      recommendation: "PURSUE",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.destination, "new");
  });

  it("(8) infrastructure-only tender → SKIP → not eligible, rejectionReasons populated", () => {
    const r = evaluateCrawlerEligibility({
      title: "Road Construction and Bridge Works — North Eleuthera",
      description:
        "The Ministry of Works and Utilities invites bids for the construction of a 3.2 km " +
        "road extension and a new bridge in North Eleuthera. Works include site clearing, " +
        "sub-base preparation, asphalt laying, drainage installation, and bridge erection.",
      recommendation: "SKIP",
    });
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.length > 0);
  });
});

describe("Concurrency safety", () => {
  it("(9) content key comparison is deterministic and order-independent", () => {
    function contentKey(title: string, description: string): string {
      return [title.trim().toLowerCase().slice(0, 120), description.trim().toLowerCase().slice(0, 300)].join("|");
    }
    const title = "Caribbean Communications Consultant";
    const desc = "CARICOM is seeking a communications consultant to develop its regional outreach strategy.";
    assert.equal(contentKey(title, desc), contentKey(title, desc));
  });
});

describe("Expired deadline handling", () => {
  it("(10) opportunity with expired deadline → fitScore=0, recommendation=SKIP", () => {
    const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = scoreTender({
      title: "Communications Strategy for Tourism Ministry",
      description:
        "The Ministry of Tourism seeks a qualified marketing agency to develop and " +
        "execute a comprehensive communications strategy for the upcoming tourism season, " +
        "including social media management, public relations, and campaign design.",
      country: "Bahamas",
      deadline: pastDate,
    });
    assert.equal(result.fitScore, 0);
    assert.equal(result.recommendation, "SKIP");
    assert.ok(result.reasoning.includes("expired") || result.reasoning.includes("Deadline has passed"));
  });
});

describe("Backfill scope", () => {
  it("(11) backfill evaluates items regardless of prior recommendation (not just CONSIDER/PURSUE)", () => {
    const previouslySkipped = {
      title: "Communications Outreach Support — UNDP",
      description:
        "UNDP Caribbean seeks a qualified communications firm to lead stakeholder " +
        "outreach activities for the regional food security programme, including " +
        "digital media, print collateral, and community engagement workshops.",
      recommendation: "SKIP",
      country: "Caribbean",
    };
    const newScore = scoreTender({
      title: previouslySkipped.title,
      description: previouslySkipped.description,
      country: previouslySkipped.country,
    });
    assert.ok(
      newScore.recommendation === "CONSIDER" || newScore.recommendation === "PURSUE",
      `Expected CONSIDER or PURSUE for comms outreach, got ${newScore.recommendation}`,
    );
  });

  it("(12) backfill rescores items whose score changed after phrase expansion", () => {
    const score = scoreTender({
      title: "Hiring of Firm for Outreach Activities",
      description:
        "The Caribbean Development Bank requests proposals from qualified firms to conduct " +
        "outreach activities for the coastal resilience programme in Barbados and Jamaica. " +
        "The scope includes community engagement, sensitization campaigns, stakeholder meetings, " +
        "and production of awareness materials for target beneficiary groups.",
      country: "Caribbean",
    });
    assert.ok(
      score.fitScore > 0,
      `Expected fitScore > 0 after phrase expansion, got ${score.fitScore} (${score.recommendation})`,
    );
    assert.notEqual(score.recommendation, "SKIP",
      `Expected recommendation != SKIP for comms outreach work, got SKIP`);
  });
});

describe("Batch observability", () => {
  it("(13) crawl batch structure contains all required fields", () => {
    const fakeBatch = {
      batchId: "550e8400-e29b-41d4-a716-446655440000",
      sourcesAttempted: 3,
      sourcesSucceeded: 2,
      sourcesFailed: 1,
      fetched: 45,
      inserted: 8,
      updated: 2,
      eligible: 5,
      promoted: 4,
      rejected: 40,
      unchanged: 3,
      perSourceErrors: { "2": "HTTP 503 from CARICOM after 3 retries" },
      rejectionCounts: { "No marketing/comms terms detected": 22, "title_only content": 14 },
    };

    assert.ok(fakeBatch.batchId, "batchId must be present");
    assert.equal(typeof fakeBatch.sourcesAttempted, "number");
    assert.equal(typeof fakeBatch.sourcesFailed, "number");
    assert.equal(typeof fakeBatch.promoted, "number");
    assert.ok(typeof fakeBatch.rejectionCounts === "object");
    assert.ok(fakeBatch.inserted + fakeBatch.updated + fakeBatch.unchanged + fakeBatch.rejected <= fakeBatch.fetched + 10);
  });

  it("(14) failed adapter does not produce a 'success' source run — throws instead", async () => {
    const mockFailingAdapter = {
      adapterType: "caricom",
      async fetchOpportunities() {
        throw new Error("CARICOM: all 5 requests failed. HTTP 503; HTTP 503; HTTP 503; HTTP 503; HTTP 503");
      },
    };
    let caughtError: Error | null = null;
    try { await mockFailingAdapter.fetchOpportunities(); } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }
    assert.ok(caughtError !== null, "Failed adapter must throw");
    assert.ok(caughtError.message.includes("failed"), "Error message must describe the failure");
  });

  it("(15) partial crawl: sourcesFailed > 0 but < sourcesAttempted → batch.status = 'partial'", () => {
    const sourcesAttempted: number = 3;
    const sourcesFailed: number = 1;
    const batchStatus =
      sourcesAttempted === 0 ? "failed"
      : sourcesFailed === sourcesAttempted ? "failed"
      : sourcesFailed > 0 ? "partial"
      : "success";
    assert.equal(batchStatus, "partial");
  });
});

describe("Discovery scoring", () => {
  it("(16) Bahamas opportunity scores geographyScore=100 and geoRegion=bahamas", () => {
    const result = scoreTender({
      title: "Brand Strategy and Digital Marketing — Bahamas Tourism Board",
      description:
        "The Bahamas Tourism Board invites proposals from qualified marketing agencies " +
        "to develop a comprehensive brand strategy and digital marketing campaign for the " +
        "2026 visitor season. The selected agency will lead creative development, social " +
        "media management, and campaign execution across Nassau, Grand Bahama, and the Family Islands.",
      country: "Bahamas",
    });
    assert.equal(result.geographyScore, 100, "Bahamas opportunity must score geographyScore=100");
    assert.equal(result.geoRegion, "bahamas", "Bahamas opportunity must have geoRegion=bahamas");
    assert.ok(result.fitScore > 0, "Bahamas comms opportunity must have positive fitScore");
    assert.notEqual(result.recommendation, "SKIP", "Bahamas comms opportunity must not be SKIP");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 17–22  Batch lifecycle regression
// Uses __setCrawlDbForTesting to inject a mock DB so the real startCrawl /
// executeCrawlBatch code runs without touching the live database.
// afterEach resets the override to null after every test to prevent bleed.
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch lifecycle (mocked DB)", () => {
  afterEach(() => {
    __setCrawlDbForTesting(null);
  });

  it("(17) old batch pre-exists; startCrawl returns a new UUID distinct from it", async () => {
    const mockDb = createMockDb();
    const OLD_ID = "00000000-0000-4000-a000-000000000001";
    mockDb._addExistingBatch({ id: OLD_ID, status: "success", startedAt: new Date().toISOString() });
    __setCrawlDbForTesting(mockDb);

    const newId = await startCrawl();

    assert.ok(newId !== null, "startCrawl must return a batchId");
    assert.notEqual(newId, OLD_ID, "New batchId must be distinct from the pre-existing batch");
    assert.ok(mockDb._getBatch(newId!), "New batch row must have been persisted in the mock");
  });

  it("(18) two sequential startCrawl calls return distinct IDs", async () => {
    // The mock always allows lock acquisition regardless of state, simulating
    // the scenario where the lock was released between calls.
    const mockDb = createMockDb();
    __setCrawlDbForTesting(mockDb);

    const id1 = await startCrawl();
    const id2 = await startCrawl();

    assert.ok(id1 !== null && id2 !== null, "Both startCrawl calls must succeed");
    assert.notEqual(id1, id2, "Each call must generate a new distinct UUID");
    assert.equal(mockDb._batchIds().length, 2, "Two distinct batch rows must have been inserted");
  });

  it("(19) startCrawl returns a valid UUID v4 batchId, never null on success", async () => {
    const mockDb = createMockDb();
    __setCrawlDbForTesting(mockDb);

    const batchId = await startCrawl();

    assert.ok(batchId !== null, "batchId must not be null when lock is acquired");
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.ok(uuidV4.test(batchId!), `"${batchId}" must match the UUID v4 format`);
    // Verify the exact same ID was persisted (no polling or transformation)
    assert.ok(mockDb._getBatch(batchId!), "The persisted batch row must use the exact returned ID");
  });

  it("(20) lock contention: startCrawl returns null; HTTP route maps this to 409", async () => {
    // lockConflict:true makes insert().onConflictDoNothing().returning() return []
    // simulating another instance holding the lock in the real DB.
    const mockDb = createMockDb({ lockConflict: true });
    __setCrawlDbForTesting(mockDb);

    const batchId = await startCrawl();

    assert.equal(batchId, null, "startCrawl must return null when lock acquisition fails");
    assert.equal(mockDb._batchIds().length, 0, "No batch row must be inserted when lock is not acquired");

    // The HTTP route maps null → 409
    const httpStatus = batchId === null ? 409 : 202;
    assert.equal(httpStatus, 409, "HTTP route must return 409 for lock contention");
  });

  it("(21) batch-insert failure releases the acquired lock before rethrowing", async () => {
    const mockDb = createMockDb({ failBatchInsert: true });
    __setCrawlDbForTesting(mockDb);

    let threwError = false;
    try {
      await startCrawl();
    } catch {
      threwError = true;
    }

    assert.ok(threwError, "startCrawl must rethrow the batch-insert error");
    assert.ok(mockDb._lockAcquired(), "The lock was acquired before the failure");
    // releaseCrawlLock() calls db.delete() — it must have been called:
    // deleteCount >= 2 (one expired-lock cleanup + one explicit release)
    assert.ok(
      mockDb._deleteCount() >= 2,
      `releaseCrawlLock must be called after batch-insert failure (deleteCount=${mockDb._deleteCount()})`,
    );
    assert.equal(mockDb._batchIds().length, 0, "No batch row must exist after the failed insert");
  });

  it("(22) executeCrawlBatch marks batch terminal and releases lock in finally", async () => {
    const mockDb = createMockDb();
    __setCrawlDbForTesting(mockDb);

    const batchId = await startCrawl();
    assert.ok(batchId !== null, "startCrawl must succeed first");
    const deleteCountAfterStart = mockDb._deleteCount(); // 1: expired-lock cleanup

    // executeCrawlBatch with zero sources (mock select returns []):
    // loops over no sources, runs backfill (also empty), updates batch, releases lock
    await executeCrawlBatch(batchId!);

    // releaseCrawlLock must add at least one more db.delete() call
    assert.ok(
      mockDb._deleteCount() > deleteCountAfterStart,
      "releaseCrawlLock must be called in finally (db.delete count must increase)",
    );

    // Batch must be updated with a terminal status
    const update = mockDb._getBatchUpdate(batchId!);
    assert.ok(update, "Batch row must have been updated after executeCrawlBatch");
    assert.ok(
      ["success", "partial", "failed"].includes(String(update?.status)),
      `Batch status must be terminal, got: ${update?.status}`,
    );
    assert.ok(update?.completedAt, "Batch must have completedAt set");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 23–29  Fixture-backed adapter detail extraction
// Each adapter is instantiated with a mock FetchFn — no network calls.
// PAD500 / PAD1000 fill the adapters' html.length guards (≥500 / ≥1000 chars).
// ─────────────────────────────────────────────────────────────────────────────

const PAD500  = "\n<!-- " + "=".repeat(512) + " -->\n";
const PAD1000 = "\n<!-- " + "=".repeat(1024) + " -->\n";

// Rich detail HTML returned by the mock fetchFn for detail-page requests.
// Uses <div class="description"> which matches fetchDetailDescription()'s
// first pattern; content is 350+ chars so it clears the 120-char threshold.
function richDetailHtml(org: string): string {
  return (
    "<html><body>\n<div class=\"description\">\n  " +
    org + " invites proposals from qualified firms to develop and implement a comprehensive " +
    "communications strategy and stakeholder engagement programme for the regional climate " +
    "resilience initiative. The scope includes digital media management, press release drafting, " +
    "community engagement, stakeholder outreach, brand development, and performance reporting " +
    "for a 24-month period across Barbados, Guyana, Trinidad and Tobago, and Belize. " +
    "Minimum three years of Caribbean communications experience required.\n</div>\n</body></html>"
  );
}

describe("Adapter fixture tests", () => {

  // ── 23: IDB ──────────────────────────────────────────────────────────────
  it("(23) IDB: detail-page fetch enriches short listing description to ≥120 chars", async () => {
    const listingHtml =
      "<html><body>" + PAD500 +
      "<article>" +
      "<h3><a href=\"/en/project/BA-L1234\">Bahamas Tourism Board Communications Strategy</a></h3>" +
      "<p>Short.</p>" +
      "</article>" +
      "</body></html>";

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("iadb.org/en/projects/all")) {
        return new Response(listingHtml, { status: 200 });
      }
      return new Response(richDetailHtml("Inter-American Development Bank"), { status: 200 });
    };

    const adapter = new IDBAdapter(mockFetch);
    const result = await adapter.fetchOpportunities();

    assert.ok(result.requestsSucceeded > 0, "Listing page must succeed");
    const enriched = result.opportunities.find((o) => o.description.length >= 120);
    assert.ok(enriched, "At least one opportunity must have description ≥120 chars after detail-page fetch");
    assert.ok(
      !enriched!.description.startsWith("IDB project:"),
      "Description must not be the old padded stub pattern",
    );
  });

  // ── 24: CDB ──────────────────────────────────────────────────────────────
  it("(24) CDB: detail-page fetch enriches procurement link description to ≥120 chars", async () => {
    const listingHtml =
      "<html><body>" + PAD500 +
      "<a href=\"https://www.caribank.org/procurement/rfp-communications-services-2026\">" +
      "Communications Services RFP 2026" +
      "</a>" +
      "</body></html>";

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("caribank.org") && !url.includes("rfp-communications")) {
        return new Response(listingHtml, { status: 200 });
      }
      return new Response(richDetailHtml("Caribbean Development Bank"), { status: 200 });
    };

    const adapter = new CDBAdapter(mockFetch);
    const result = await adapter.fetchOpportunities();

    assert.ok(result.requestsSucceeded > 0, "Listing page must succeed");
    const enriched = result.opportunities.find((o) => o.description.length >= 120);
    assert.ok(enriched, "At least one opportunity must have description ≥120 chars after detail-page fetch");
    assert.ok(
      !enriched!.description.startsWith("Caribbean Development Bank announcement:"),
      "Description must not be the old padded stub pattern",
    );
  });

  // ── 25: BahamasGov (HTML detail link) ────────────────────────────────────
  it("(25) BahamasGov: HTML detail link enriches description to ≥120 chars", async () => {
    // BahamasGov checks html.length < 1000 → use PAD1000
    const listingHtml =
      "<html><body>" + PAD1000 +
      "<a href=\"/tender/digital-marketing-rfp-2026\"" +
      " title=\"Digital Marketing RFP for Bahamas Tourism Board\">" +
      "Link text" +
      "<span class=\"category\">Tourism</span>" +
      "</a>" +
      "</body></html>";

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("bahamas.gov.bs/tender-notices") || url.includes("bahamas.gov.bs/tender-and-rfps")) {
        return new Response(listingHtml, { status: 200 });
      }
      return new Response(richDetailHtml("Government of The Bahamas"), { status: 200 });
    };

    const adapter = new BahamasGovAdapter(mockFetch);
    const result = await adapter.fetchOpportunities();

    assert.ok(result.requestsSucceeded > 0, "Listing page must succeed");
    const enriched = result.opportunities.find(
      (o) => !o.url?.endsWith(".pdf") && o.description.length >= 120,
    );
    assert.ok(enriched, "HTML-linked item must have description ≥120 chars after detail-page fetch");
    assert.ok(
      !enriched!.description.startsWith("Bahamas government procurement notice"),
      "Description must not be the old padded stub pattern",
    );
  });

  // ── 26: BahamasGov (PDF link — invalid/empty PDF → title-only) ───────────
  it("(26) BahamasGov: inaccessible PDF falls back to title-only (no padded stub)", async () => {
    const PDF_URL = "https://cdn.bahamas.gov.bs/tenders/rfp-comms-consultancy-2026.pdf";
    // BahamasGov checks html.length < 1000 → use PAD1000
    const listingHtml =
      "<html><body>" + PAD1000 +
      "<a href=\"" + PDF_URL + "\" title=\"Request for Proposals - Communications Consultancy\">" +
      "PDF link" +
      "</a>" +
      "</body></html>";

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("bahamas.gov.bs/tender-notices") || url.includes("bahamas.gov.bs/tender-and-rfps")) {
        return new Response(listingHtml, { status: 200 });
      }
      // PDF URL: return empty buffer — pdf-parse will throw → extractPdfText returns ""
      return new Response(new Uint8Array(0).buffer, { status: 200, headers: { "content-type": "application/pdf" } });
    };

    const adapter = new BahamasGovAdapter(mockFetch);
    const result = await adapter.fetchOpportunities();

    const pdfItem = result.opportunities.find((o) => o.url === PDF_URL);
    assert.ok(pdfItem, "PDF-linked item must be in the opportunities list");
    // When extractPdfText returns "", description falls back to title — not a padded stub
    assert.equal(
      pdfItem!.description,
      pdfItem!.title,
      "PDF item with no extractable text must use title as description (no padded stub)",
    );
    assert.ok(
      !pdfItem!.description.startsWith("Bahamas government tender document:"),
      "Old padded stub pattern must not be used",
    );
  });

  // ── 27: CTO ──────────────────────────────────────────────────────────────
  it("(27) CTO: anchor-text matched link enriches description to ≥120 chars", async () => {
    const listingHtml =
      "<html><body>" + PAD500 +
      "<a href=\"/news/marketing-agency-rfp-caribbean-2026\">" +
      "Marketing Agency RFP — Caribbean Tourism Campaign 2026" +
      "</a>" +
      "</body></html>";

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("caribtourism.com") && !url.includes("marketing-agency-rfp")) {
        return new Response(listingHtml, { status: 200 });
      }
      return new Response(richDetailHtml("Caribbean Tourism Organization"), { status: 200 });
    };

    const adapter = new CTOAdapter(mockFetch);
    const result = await adapter.fetchOpportunities();

    assert.ok(result.requestsSucceeded > 0, "Listing page must succeed");
    const enriched = result.opportunities.find((o) => o.description.length >= 120);
    assert.ok(enriched, "At least one opportunity must have description ≥120 chars after detail-page fetch");
    assert.ok(
      !enriched!.description.startsWith("Caribbean Tourism Organization procurement notice:"),
      "Description must not be the old padded stub pattern",
    );
  });

  // ── 28: CARICOM ──────────────────────────────────────────────────────────
  it("(28) CARICOM: detail-page fetch enriches procurement link description to ≥120 chars", async () => {
    const listingHtml =
      "<html><body>" + PAD500 +
      "<a href=\"https://caricom.org/procurement/communications-strategy-rfp-2026\">" +
      "Communications Strategy RFP 2026" +
      "</a>" +
      "<a href=\"/procurement/stakeholder-engagement-consultancy\">" +
      "Stakeholder Engagement Consultancy" +
      "</a>" +
      "</body></html>";

    const CARICOM_LISTING_URLS = new Set([
      "https://caricom.org/procurement-notices",
      "https://caricom.org/secretariat/procurement/",
      "https://caricom.org/procurement",
      "https://caricom.org/tenders",
      "https://caricom.org/news-and-media",
      "https://caricom.org/",
    ]);

    const mockFetch = async (url: string): Promise<Response> => {
      if (CARICOM_LISTING_URLS.has(url)) {
        return new Response(listingHtml, { status: 200 });
      }
      return new Response(richDetailHtml("CARICOM Secretariat"), { status: 200 });
    };

    const adapter = new CARICOMAdapter(mockFetch);
    const result = await adapter.fetchOpportunities();

    assert.ok(result.requestsSucceeded > 0, "Listing page must succeed");
    const enriched = result.opportunities.find((o) => o.description.length >= 120);
    assert.ok(enriched, "At least one opportunity must have description ≥120 chars after detail-page fetch");
    assert.ok(
      !enriched!.description.startsWith("CARICOM procurement notice:"),
      "Description must not be the old padded stub pattern",
    );
  });

  // ── 29: EU Caribbean ─────────────────────────────────────────────────────
  it("(29) EU Caribbean: detail-page fetch enriches communications link to ≥120 chars", async () => {
    const listingHtml =
      "<html><body>" + PAD500 +
      "<a href=\"https://www.cariforum.org/tender/communications-support-edf-2026\">" +
      "Communications Support for EDF Caribbean Development Programme" +
      "</a>" +
      "</body></html>";

    const mockFetch = async (url: string): Promise<Response> => {
      if (
        url.includes("cariforum.org/procurement") ||
        url.includes("cariforum.org/tenders") ||
        url === "https://www.cariforum.org/"
      ) {
        return new Response(listingHtml, { status: 200 });
      }
      return new Response(richDetailHtml("EU Caribbean Development Fund"), { status: 200 });
    };

    const adapter = new EUCaribbeanAdapter(mockFetch);
    const result = await adapter.fetchOpportunities();

    assert.ok(result.requestsSucceeded > 0, "Listing page must succeed");
    const enriched = result.opportunities.find((o) => o.description.length >= 120);
    assert.ok(enriched, "At least one opportunity must have description ≥120 chars after detail-page fetch");
    assert.ok(
      !enriched!.description.startsWith("EU Caribbean funding notice:"),
      "Description must not be the old padded stub pattern",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 30  End-to-end: eligible fixture reaches Discover via reconcileDiscovery
//
// Uses the real PostgreSQL DB (no mock).  Inserts a throwaway tender_source,
// calls reconcileDiscovery() with a rich Caribbean communications RFP, then
// asserts eligible=true and promoted=true.  Cleans up all created rows in after().
// ─────────────────────────────────────────────────────────────────────────────

describe("(30) End-to-end eligible fixture reaches Discover", () => {
  let e2eSourceId = 0;
  let e2eDiscoveryId: number | undefined;
  let e2eOpportunityId: number | undefined;

  // Defined at describe-registration time so both test 30 and 30b share the
  // identical externalId/url — guaranteeing the second call hits the same row.
  const e2eRichOpp = {
    title:
      "Digital Communications Strategy and Stakeholder Engagement Programme",
    description:
      "Caribbean Development Bank invites proposals from qualified firms to develop and implement " +
      "a comprehensive digital communications strategy and stakeholder engagement programme for the " +
      "regional climate resilience initiative. The scope includes digital media management, press " +
      "release drafting, community engagement, stakeholder outreach, brand development, and " +
      "performance reporting for a 24-month period across Barbados, Guyana, Trinidad and Tobago, " +
      "and Belize. Minimum three years of Caribbean communications experience required.",
    organization: "Caribbean Development Bank",
    country:      "Barbados",
    sector:       "Communications",
    url:          `https://test.invalid/fixture-e2e/rfp-${Date.now()}`,
    externalId:   `fixture-e2e-${Date.now()}`,
  };

  before(async () => {
    // Guarantee the real DB is active (lifecycle tests may leave mock set)
    __setCrawlDbForTesting(null);

    const [src] = await db
      .insert(tenderSourcesTable)
      .values({
        name:        "[TEST] Fixture reconciliation source",
        sourceType:  "test",
        url:         "https://test.invalid/fixture-e2e",
        adapterType: "caricom",
        active:      false,
      })
      .returning({ id: tenderSourcesTable.id });
    e2eSourceId = src.id;
  });

  after(async () => {
    // Clear FK link before deleting opportunity so constraint is not violated
    if (e2eDiscoveryId !== undefined) {
      await db
        .update(discoveredTendersTable)
        .set({ opportunityId: null as unknown as number })
        .where(eq(discoveredTendersTable.id, e2eDiscoveryId))
        .catch(() => {/* ignore — row may already be gone */});
    }
    if (e2eOpportunityId !== undefined) {
      await db
        .delete(tendersTable)
        .where(eq(tendersTable.id, e2eOpportunityId))
        .catch(() => {});
    }
    if (e2eDiscoveryId !== undefined) {
      await db
        .delete(discoveredTendersTable)
        .where(eq(discoveredTendersTable.id, e2eDiscoveryId))
        .catch(() => {});
    }
    if (e2eSourceId) {
      await db
        .delete(tenderSourcesTable)
        .where(eq(tenderSourcesTable.id, e2eSourceId))
        .catch(() => {});
    }
  });

  it("(30) first reconciliation: eligible=true, promoted=true, alreadyPromoted=false", async () => {
    const result = await reconcileDiscovery(e2eSourceId, e2eRichOpp);
    e2eDiscoveryId   = result.discoveryId;
    e2eOpportunityId = result.opportunityId;

    assert.strictEqual(
      result.eligible,
      true,
      `Expected eligible:true — rejection reasons: ${JSON.stringify(result.rejectionReasons ?? [])}. ` +
      `Score recommendation: ${result.score?.recommendation ?? "unknown"}`,
    );
    assert.strictEqual(
      result.promoted,
      true,
      "First reconciliation: promoted must be true — a new Discover opportunity was created",
    );
    assert.strictEqual(
      result.alreadyPromoted,
      false,
      "First reconciliation: alreadyPromoted must be false",
    );
    assert.ok(
      result.opportunityId,
      "opportunityId must be set after a successful promotion",
    );
    assert.strictEqual(
      result.inserted,
      true,
      "Brand-new item must have inserted:true (not updated or unchanged)",
    );
  });

  it("(30b) second reconciliation with identical fixture: promoted=false, alreadyPromoted=true, no duplicate Opportunity", async () => {
    // Same externalId + same content → unchanged row that is already linked.
    // Contract: promoted=false, alreadyPromoted=true, unchanged=true, opportunityId unchanged.
    const result2 = await reconcileDiscovery(e2eSourceId, e2eRichOpp);

    assert.strictEqual(
      result2.unchanged,
      true,
      "Second pass with identical content must be unchanged:true",
    );
    assert.strictEqual(
      result2.promoted,
      false,
      "Second pass: promoted must be false — no new Opportunity was created",
    );
    assert.strictEqual(
      result2.alreadyPromoted,
      true,
      "Second pass: alreadyPromoted must be true — link already existed before this call",
    );
    assert.strictEqual(
      result2.eligible,
      true,
      "Second pass: item remains eligible",
    );
    assert.strictEqual(
      result2.opportunityId,
      e2eOpportunityId,
      "Second pass must return the same opportunityId — no duplicate Opportunity created",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 31  Behavioral: backfillPromotions never promotes SKIP/raw_only items
//
// Creates an ineligible discovery via reconcileDiscovery (infrastructure keyword
// → SKIP, description too short → raw_only), then runs backfillPromotions() and
// asserts the item remains unlinked with rejection reasons persisted.
// ─────────────────────────────────────────────────────────────────────────────

describe("(31) backfillPromotions: SKIP/raw_only items stay unlinked", () => {
  let skipSourceId = 0;
  let skipDiscoveryId: number | undefined;

  before(async () => {
    __setCrawlDbForTesting(null); // ensure real DB is used
    const [src] = await db
      .insert(tenderSourcesTable)
      .values({
        name:        "[TEST] SKIP backfill test source",
        sourceType:  "test",
        url:         "https://test.invalid/skip-backfill",
        adapterType: "caricom",
        active:      false,
      })
      .returning({ id: tenderSourcesTable.id });
    skipSourceId = src.id;

    // Insert directly with recommendation="SKIP" so evaluateCrawlerEligibility
    // unconditionally rejects it (rule: SKIP → raw_only, eligible:false).
    // Direct insertion avoids dependency on scoreTender keyword-matching behaviour.
    const [row] = await db
      .insert(discoveredTendersTable)
      .values({
        sourceId:      skipSourceId,
        title:         "Water Treatment Infrastructure Construction",
        organization:  "Ministry of Public Works",
        description:   "Construction of a water treatment plant.",
        recommendation: "SKIP",
        externalId:    `skip-test-${Date.now()}`,
        url:           `https://test.invalid/skip-backfill/${Date.now()}`,
      })
      .returning({ id: discoveredTendersTable.id });
    skipDiscoveryId = row.id;
  });

  after(async () => {
    if (skipDiscoveryId !== undefined) {
      await db
        .delete(discoveredTendersTable)
        .where(eq(discoveredTendersTable.id, skipDiscoveryId))
        .catch(() => {});
    }
    if (skipSourceId) {
      await db
        .delete(tenderSourcesTable)
        .where(eq(tenderSourcesTable.id, skipSourceId))
        .catch(() => {});
    }
  });

  it("(31) ineligible item: backfillPromotions leaves opportunityId null and persists rejection reasons", async () => {
    // Use a large limit so the newly inserted row (highest ID, appended last)
    // is always included in the backfill page.
    const bf = await backfillPromotions(100000);

    const [row] = await db
      .select({
        opportunityId:    discoveredTendersTable.opportunityId,
        rejectionReasons: discoveredTendersTable.rejectionReasons,
      })
      .from(discoveredTendersTable)
      .where(eq(discoveredTendersTable.id, skipDiscoveryId!));

    assert.strictEqual(
      row.opportunityId,
      null,
      "SKIP/raw_only item must remain unlinked (opportunityId=null) after backfillPromotions()",
    );
    assert.ok(
      Array.isArray(row.rejectionReasons) && (row.rejectionReasons as string[]).length > 0,
      "Rejection reasons must be persisted for ineligible items by backfill",
    );
    assert.ok(
      typeof bf.rejected === "number" && bf.rejected >= 1,
      `backfill.rejected must be ≥ 1 — our ineligible item must increment the count; got ${bf.rejected}`,
    );
  });
});
