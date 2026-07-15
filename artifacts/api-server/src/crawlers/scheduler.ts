import cron from "node-cron";
import { runCrawler, seedDefaultSources, seedDefaultSearchProfiles } from "./index.js";
import { Resend } from "resend";
import { db } from "@workspace/db";
import { discoveredTendersTable, tenderDigestSettingsTable } from "@workspace/db";
import { eq, gte, and } from "drizzle-orm";

async function getDigestRecipients(): Promise<{ emails: string[]; enabled: boolean }> {
  try {
    const [settings] = await db.select().from(tenderDigestSettingsTable).limit(1);
    if (settings) {
      return { emails: JSON.parse(settings.emails), enabled: settings.enabled };
    }
  } catch {
    // fallback to env var
  }
  const envEmail = process.env.DIGEST_EMAIL;
  return { emails: envEmail ? [envEmail] : [], enabled: true };
}

async function sendDigestEmail(newCount: number): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const { emails, enabled } = await getDigestRecipients();
  if (!enabled || emails.length === 0) return;

  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const newTenders = await db
      .select()
      .from(discoveredTendersTable)
      .where(
        and(
          gte(discoveredTendersTable.createdAt, yesterday),
          eq(discoveredTendersTable.status, "new")
        )
      );

    const pursue = newTenders.filter((t) => t.recommendation === "PURSUE");
    const consider = newTenders.filter((t) => t.recommendation === "CONSIDER");

    if (newTenders.length === 0) return;

    const appBase = process.env.APP_URL
      ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}/proposal-generator` : "");
    const inboxUrl = `${appBase}/inbox`;

    const rows = (list: typeof newTenders) =>
      list
        .map(
          (t) => `<tr>
              <td style="padding:8px;border-bottom:1px solid #222">
                ${t.sourceUrl
                  ? `<a href="${t.sourceUrl}" style="color:#fff;text-decoration:none"><strong>${t.title}</strong> <span style="color:#555;font-size:11px">↗</span></a>`
                  : `<strong>${t.title}</strong>`}
              </td>
              <td style="padding:8px;border-bottom:1px solid #222">${t.organization}</td>
              <td style="padding:8px;border-bottom:1px solid #222">${t.fitScore ?? "–"}</td>
              <td style="padding:8px;border-bottom:1px solid #222">${t.deadline ? new Date(t.deadline).toLocaleDateString() : "–"}</td>
            </tr>`
        )
        .join("");

    const html = `
<div style="font-family:sans-serif;max-width:700px;margin:0 auto;color:#fff;background:#0a0a0a;padding:32px">
  <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:40px;margin-bottom:24px" alt="ONWRD"/>
  <h2 style="color:#fff;margin-bottom:4px">Tender Intelligence Digest</h2>
  <p style="color:#888;margin-top:0">${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
  <p><strong>${newCount}</strong> new opportunities discovered today. <strong>${pursue.length}</strong> recommended to pursue.</p>

  ${pursue.length > 0 ? `
  <h3 style="color:#4ade80;margin-top:24px">🔥 Pursue (${pursue.length})</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="color:#888">
      <th style="text-align:left;padding:8px">Title</th>
      <th style="text-align:left;padding:8px">Organisation</th>
      <th style="text-align:left;padding:8px">Score</th>
      <th style="text-align:left;padding:8px">Deadline</th>
    </tr></thead>
    <tbody>${rows(pursue)}</tbody>
  </table>` : ""}

  ${consider.length > 0 ? `
  <h3 style="color:#facc15;margin-top:24px">⚡ Consider (${consider.length})</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="color:#888">
      <th style="text-align:left;padding:8px">Title</th>
      <th style="text-align:left;padding:8px">Organisation</th>
      <th style="text-align:left;padding:8px">Score</th>
      <th style="text-align:left;padding:8px">Deadline</th>
    </tr></thead>
    <tbody>${rows(consider)}</tbody>
  </table>` : ""}

  ${appBase ? `
  <div style="margin-top:32px;text-align:center">
    <a href="${inboxUrl}" style="display:inline-block;background:#fff;color:#000;font-weight:600;font-size:14px;padding:12px 28px;border-radius:6px;text-decoration:none">Open Tender Inbox →</a>
  </div>` : ""}

  <div style="margin-top:16px;padding:20px;background:#111;border-radius:8px;border:1px solid #222">
    <p style="color:#888;font-size:13px;margin:0 0 12px">Share with a prospective client</p>
    <a href="https://proposals.onwrdadvisors.com/intake" style="display:inline-block;background:#0000FF;color:#fff;font-weight:600;font-size:14px;padding:12px 28px;border-radius:6px;text-decoration:none">Start a Client Proposal →</a>
    <p style="color:#555;font-size:11px;margin:10px 0 0">proposals.onwrdadvisors.com/intake</p>
  </div>

  <p style="margin-top:32px;color:#555;font-size:12px">ONWRD Proposal Desk — automated tender intelligence</p>
</div>`;

    const fromAddress = process.env.RESEND_FROM ?? "ONWRD Tender Desk <onboarding@resend.dev>";
    const resend = new Resend(apiKey);

    const { error } = await resend.emails.send({
      from: fromAddress,
      to: emails,
      subject: `[ONWRD] ${pursue.length} new opportunities to pursue — ${new Date().toLocaleDateString()}`,
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

  cron.schedule("0 6 * * *", async () => {
    console.log("[tender-cron] Starting daily crawl…");
    try {
      const { newItems } = await runCrawler();
      console.log(`[tender-cron] Done. ${newItems} new opportunities.`);
      await sendDigestEmail(newItems);
    } catch (err) {
      console.error("[tender-cron] Crawl failed:", err);
    }
  });

  console.log("[tender-cron] Scheduler started. Daily crawl at 06:00.");
}
