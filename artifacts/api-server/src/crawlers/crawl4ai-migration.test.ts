import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pool } from "@workspace/db";

describe("Crawl4AI schema migration", () => {
  it("upgrades the prior schema, opts in both pilots, and persists diagnostics", async () => {
    const sql = await readFile(
      new URL("../../../../scripts/migrations/20260827_crawl4ai_enrichment.sql", import.meta.url),
      "utf8",
    );
    const sourceVersionSql = await readFile(
      new URL("../../../../scripts/migrations/20260828_source_configuration_version.sql", import.meta.url),
      "utf8",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Temporary tables shadow public tables through PostgreSQL search_path,
      // giving this test the exact pre-change shape without touching app data.
      await client.query(`
        CREATE TEMP TABLE tender_sources (
          id serial PRIMARY KEY,
          adapter_type text NOT NULL,
          updated_at timestamp NOT NULL DEFAULT NOW()
        );
        CREATE TEMP TABLE crawler_runs (
          id serial PRIMARY KEY,
          source_id integer NOT NULL,
          status text NOT NULL DEFAULT 'running'
        );
        INSERT INTO tender_sources (adapter_type)
        VALUES ('bahamas_gov'), ('caricom'), ('world_bank');
      `);

      await client.query(sql);
      // Running the migration twice must remain safe.
      await client.query(sql);
      await client.query(sourceVersionSql);
      await client.query(sourceVersionSql);

      const sources = await client.query<{
        adapter_type: string;
        browser_enabled: boolean;
        approved_domains: string[];
      }>(`
        SELECT adapter_type, browser_enabled, approved_domains
        FROM tender_sources
        ORDER BY adapter_type
      `);
      assert.deepEqual(sources.rows, [
        { adapter_type: "bahamas_gov", browser_enabled: true, approved_domains: ["bahamas.gov.bs"] },
        { adapter_type: "caricom", browser_enabled: true, approved_domains: ["caricom.org"] },
        { adapter_type: "world_bank", browser_enabled: false, approved_domains: null },
      ]);

      const versions = await client.query<{
        source_version: number;
        run_version: number;
      }>(`
        SELECT
          (SELECT configuration_version FROM tender_sources LIMIT 1) AS source_version,
          (SELECT column_default::integer
             FROM information_schema.columns
            WHERE table_schema LIKE 'pg_temp_%'
              AND table_name = 'crawler_runs'
              AND column_name = 'source_configuration_version'
            LIMIT 1) AS run_version
      `);
      assert.equal(versions.rows[0].source_version, 1);
      assert.equal(versions.rows[0].run_version, 0);

      const diagnostic = [{
        code: "crawl4ai_timeout",
        method: "crawl4ai",
        url: "https://caricom.org/procurement",
        message: "timed out",
      }];
      const inserted = await client.query<{
        crawl_method: string;
        crawl4ai_attempts: number;
        crawl4ai_successes: number;
        crawl_diagnostics: typeof diagnostic;
      }>(
        `INSERT INTO crawler_runs (
          source_id, status, crawl_method, crawl4ai_attempts,
          crawl4ai_successes, crawl_diagnostics
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING crawl_method, crawl4ai_attempts, crawl4ai_successes, crawl_diagnostics`,
        [1, "failed", "failed", 1, 0, JSON.stringify(diagnostic)],
      );
      assert.equal(inserted.rows[0].crawl_method, "failed");
      assert.equal(inserted.rows[0].crawl4ai_attempts, 1);
      assert.equal(inserted.rows[0].crawl4ai_successes, 0);
      assert.deepEqual(inserted.rows[0].crawl_diagnostics, diagnostic);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});