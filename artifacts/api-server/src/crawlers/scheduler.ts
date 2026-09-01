import cron from "node-cron";
import { runCrawler, seedDefaultSources, seedDefaultSearchProfiles } from "./index.js";
import { Resend } from "resend";
import { db } from "@workspace/db";
import { discoveredTendersTable, tenderDigestSettingsTable, intakeDraftsTable } from "@workspace/db";
import { eq, and, inArray, isNotNull, lt, desc } from "drizzle-orm";
import {
  DEFAULT_DIGEST_RECIPIENTS,
  parseDigestRecipients,
  shouldUpgradeLegacyRecipients,
} from "../lib/digest-settings.js";
import { filterActionableDigestTenders } from "../lib/digest-eligibility.js";

async function getDigestRecipients(): Promise<{ emails: string[]; enabled: boolean }> {
  try {
    const [settings] = await db.select().from(tenderDigestSettingsTable).limit(1);
    if (settings) {
      const emails = parseDigestRecipients(settings.emails);
      if (shouldUpgradeLegacyRecipients(emails)) {
        await db
          .update(tenderDigestSettingsTable)
          .set({ emails: JSON.stringify(DEFAULT_DIGEST_RECIPIENTS), updatedAt: new Date() })
          .where(eq(tenderDigestSettingsTable.id, settings.id));
        return { emails: [...DEFAULT_DIGEST_RECIPIENTS], enabled: settings.enabled };
      }
      return { emails, enabled: settings.enabled };
    }
  } catch {
    // fallback to env var
  }
  const envEmail = process.env.DIGEST_EMAIL;
  return { emails: envEmail ? [envEmail] : [], enabled: true };
}

const flagFor = (country: string | null) => {
  const c = (country ?? "").toLowerCase();
  if (c.includes("bahamas")) return "🇧🇸 ";
  if (c.includes("barbados")) return "🇧🇧 ";
  if (c.includes("jamaica")) return "🇯🇲 ";
  if (c.includes("trinidad")) return "🇹🇹 ";
  if (c.includes("cayman")) return "🇰🇾 ";
  if (c.includes("antigua")) return "🇦🇬 ";
  if (c.includes("belize")) return "🇧🇿 ";
  if (c.includes("guyana")) return "🇬🇾 ";
  if (c.includes("haiti")) return "🇭🇹 ";
  if (c.includes("turks")) return "🇹🇨 ";
  return "🌍 ";
};

export function getDigestAppBase(): string {
  const configuredUrl = process.env.APP_URL?.trim().replace(/\/+$/, "");
  const isDevelopmentUrl = configuredUrl
    ? /(^|:\/\/)[^/]*\.replit\.dev(?:\/|$)/i.test(configuredUrl) ||
      /(^|:\/\/)localhost(?::\d+)?(?:\/|$)/i.test(configuredUrl)
    : false;
  if (configuredUrl && !isDevelopmentUrl) return configuredUrl;
  if (process.env.NODE_ENV === "production") return "";
  return process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/proposal-generator`
    : "";
}

export async function sendDigestEmail(_newCount: number): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const { emails, enabled } = await getDigestRecipients();
  if (!enabled || emails.length === 0) return;

  try {
    // All current actionable opportunities — not limited to last 24 h
    const allTenders = await db
      .select()
      .from(discoveredTendersTable)
      .where(and(
        eq(discoveredTendersTable.status, "new"),
        isNotNull(discoveredTendersTable.opportunityId),
        inArray(discoveredTendersTable.recommendation, ["PURSUE", "CONSIDER"]),
      ))
      .orderBy(desc(discoveredTendersTable.fitScore));
    const actionableTenders = filterActionableDigestTenders(allTenders);

    const pursue = actionableTenders.filter((t) => t.recommendation === "PURSUE");
    const consider = actionableTenders.filter((t) => t.recommendation === "CONSIDER");

    if (actionableTenders.length === 0) {
      console.log("[digest email] No opportunities to report — skipping send.");
      return;
    }

    const sortBahamasFirst = (list: typeof allTenders) =>
      [...list].sort((a, b) => {
        const aBs = (a.country ?? "").toLowerCase().includes("bahamas") ? 1 : 0;
        const bBs = (b.country ?? "").toLowerCase().includes("bahamas") ? 1 : 0;
        if (bBs !== aBs) return bBs - aBs;
        return (b.fitScore ?? 0) - (a.fitScore ?? 0);
      });

    const pursueSorted  = sortBahamasFirst(pursue);
    const considerSorted = sortBahamasFirst(consider);

    const isBahamasEntry = (t: (typeof allTenders)[number]) =>
      (t.country ?? "").toLowerCase().includes("bahamas");
    const bahamasCount   = [...pursue, ...consider].filter(isBahamasEntry).length;
     const bahamasTracked = actionableTenders.filter(isBahamasEntry).length;

    const appBase = getDigestAppBase();
    const inboxUrl = `${appBase}/inbox`;

    const rows = (list: typeof allTenders) =>
      list.map((t) => {
        const isBahamas    = (t.country ?? "").toLowerCase().includes("bahamas");
        const rowBg        = isBahamas ? "background:#0f1a10;" : "";
        const titleColor   = isBahamas ? "#4ade80" : "#ffffff";
        const deadlineStr  = t.deadline
          ? new Date(t.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "–";
        const daysLeft = t.deadline
          ? Math.ceil((new Date(t.deadline).getTime() - Date.now()) / 86400000)
          : null;
        const urgency = daysLeft !== null && daysLeft <= 14 && daysLeft >= 0
          ? `<span style="color:#f87171;font-size:11px"> ⚠ ${daysLeft}d left</span>`
          : "";
        return `<tr style="${rowBg}">
            <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f">
              ${flagFor(t.country)}<strong style="color:${titleColor}">${t.title}</strong>
              ${isBahamas ? '<span style="background:#14532d;color:#4ade80;font-size:10px;padding:1px 6px;border-radius:999px;margin-left:6px">Bahamas</span>' : ""}
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f;color:#aaa;font-size:13px">${t.organization ?? "–"}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f;text-align:center">
              <span style="background:#1e3a1e;color:#4ade80;padding:2px 8px;border-radius:999px;font-size:13px;font-weight:600">${t.fitScore ?? "–"}</span>
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f;color:#aaa;font-size:13px">${deadlineStr}${urgency}</td>
          </tr>`;
      }).join("");

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:700px;margin:0 auto;color:#fff;background:#0a0a0a;padding:0">
  <div style="background:#0d0d0d;border-bottom:1px solid #1f1f1f;padding:24px 32px">
    <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:36px" alt="ONWRD"/>
  </div>

  <div style="padding:32px">
    <h2 style="color:#fff;margin:0 0 4px">Tender Intelligence Digest</h2>
    <p style="color:#666;margin:0 0 24px;font-size:14px">${today}</p>

    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px">
      <div style="background:#1e3a1e;border:1px solid #166534;border-radius:10px;padding:12px 20px;min-width:110px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#4ade80">${pursue.length}</div>
        <div style="font-size:12px;color:#86efac;margin-top:2px">Pursue</div>
      </div>
      <div style="background:#1c1a0a;border:1px solid #713f12;border-radius:10px;padding:12px 20px;min-width:110px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#facc15">${consider.length}</div>
        <div style="font-size:12px;color:#fde047;margin-top:2px">Consider</div>
      </div>
      <div style="background:#0f1a10;border:1px solid #166534;border-radius:10px;padding:12px 20px;min-width:110px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#34d399">🇧🇸 ${bahamasCount}</div>
        <div style="font-size:12px;color:#6ee7b7;margin-top:2px">Bahamas to action</div>
        ${bahamasTracked > bahamasCount ? `<div style="font-size:11px;color:#4b7a5a;margin-top:2px">${bahamasTracked} tracked total</div>` : ""}
      </div>
    </div>

    ${pursueSorted.length > 0 ? `
    <h3 style="color:#4ade80;margin:0 0 12px;font-size:16px">🔥 Pursue (${pursueSorted.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:32px">
      <thead><tr style="color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.05em">
        <th style="text-align:left;padding:8px">Opportunity</th>
        <th style="text-align:left;padding:8px">Organisation</th>
        <th style="text-align:center;padding:8px">Score</th>
        <th style="text-align:left;padding:8px">Deadline</th>
      </tr></thead>
      <tbody>${rows(pursueSorted)}</tbody>
    </table>` : `<p style="color:#555;font-size:14px">No PURSUE opportunities currently — they'll appear here when crawlers surface marketing/comms RFPs.</p>`}

    ${considerSorted.length > 0 ? `
    <h3 style="color:#facc15;margin:0 0 12px;font-size:16px">⚡ Consider (${considerSorted.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:32px">
      <thead><tr style="color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.05em">
        <th style="text-align:left;padding:8px">Opportunity</th>
        <th style="text-align:left;padding:8px">Organisation</th>
        <th style="text-align:center;padding:8px">Score</th>
        <th style="text-align:left;padding:8px">Deadline</th>
      </tr></thead>
      <tbody>${rows(considerSorted)}</tbody>
    </table>` : ""}

    ${appBase ? `
    <div style="margin-top:8px;margin-bottom:32px;text-align:center">
      <a href="${inboxUrl}" style="display:inline-block;background:#fff;color:#000;font-weight:600;font-size:14px;padding:12px 28px;border-radius:6px;text-decoration:none">Open Tender Inbox →</a>
    </div>` : ""}

    <div style="background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px 20px;font-size:13px;color:#666">
      <strong style="color:#888">About this digest</strong><br/>
      Bahamas opportunities are highlighted and sorted to the top. The digest runs every weekday at 08:00 and scans sources including Bahamas Gov, World Bank, and Caribbean procurement portals. ${bahamasTracked} Bahamas tenders currently tracked — ${bahamasCount > 0 ? `${bahamasCount} actionable` : "none actionable yet"}.
    </div>
  </div>

  <div style="border-top:1px solid #1a1a1a;padding:20px 32px;font-size:11px;color:#444">
    ONWRD Proposal Desk — automated tender intelligence &nbsp;·&nbsp; Manage preferences at your Proposal Desk dashboard
  </div>
</div>`;

    const fromAddress = process.env.RESEND_FROM ?? "ONWRD Tender Desk <onboarding@resend.dev>";
    const resend = new Resend(apiKey);

    const { error } = await resend.emails.send({
      from: fromAddress,
      to: emails,
      subject: `[ONWRD] ${pursue.length} to pursue, ${consider.length} to consider — Tender Digest ${new Date().toLocaleDateString()}`,
      html,
    });

    if (error) {
      console.error("[digest email] Resend error:", error);
    } else {
      console.log(`[digest email] Sent to ${emails.length} recipient(s): ${emails.join(", ")}`);
    }
  } catch (err) {
    console.error("[digest email] failed:", err);
  }
}

export async function startScheduler(): Promise<void> {
  await seedDefaultSources();
  await seedDefaultSearchProfiles();

  cron.schedule("0 8 * * 1-5", async () => {
    console.log("[tender-cron] Starting daily crawl…");
    try {
      const result = await runCrawler();
      console.log(
        `[tender-cron] Done. ${result.newItems} new. ` +
        `AI calls: ${result.aiCallCount}, fallbacks: ${result.aiFallbackCount}` +
        `${result.quotaErrorHit ? " ⚠ quota error — circuit opened" : ""}`
      );
      await sendDigestEmail(result.newItems);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already in progress")) {
        console.warn("[tender-cron] Skipped — crawl already running.");
      } else {
        console.error("[tender-cron] Crawl failed:", err);
      }
    }
  });

  // Hourly: mark intake drafts as abandoned if not converted within 24 hours
  cron.schedule("0 * * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const abandoned = await db
        .update(intakeDraftsTable)
        .set({ status: "draft_abandoned", updatedAt: new Date() })
        .where(and(eq(intakeDraftsTable.status, "draft"), lt(intakeDraftsTable.updatedAt, cutoff)))
        .returning({ id: intakeDraftsTable.id });
      if (abandoned.length > 0) {
        console.log(`[intake-cron] Marked ${abandoned.length} draft(s) as abandoned.`);
      }
    } catch (err) {
      console.error("[intake-cron] Failed to mark abandoned drafts:", err);
    }
  });

  console.log("[tender-cron] Scheduler started. Daily crawl at 08:00 weekdays (Mon–Fri). Hourly abandoned-draft sweep active.");
}
