import cron from "node-cron";
import { runCrawler, seedDefaultSources, seedDefaultSearchProfiles } from "./index.js";
import nodemailer from "nodemailer";
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
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) return;

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

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: smtpUser, pass: smtpPass },
    });

    const rows = (list: typeof newTenders) =>
      list
        .map(
          (t) =>
            `<tr>
              <td style="padding:8px;border-bottom:1px solid #222"><strong>${t.title}</strong></td>
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
  <p style="color:#888;margin-top:0">${new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}</p>

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

  <p style="margin-top:32px;color:#555;font-size:12px">ONWRD Proposal Desk — automated tender intelligence</p>
</div>`;

    await transporter.sendMail({
      from: `"ONWRD Tender Desk" <${smtpUser}>`,
      to: emails.join(", "),
      subject: `[ONWRD] ${pursue.length} new opportunities to pursue — ${new Date().toLocaleDateString()}`,
      html,
    });

    console.log(`[digest email] Sent to ${emails.length} recipient(s): ${emails.join(", ")}`);
  } catch (err) {
    console.error("[digest email] failed:", err);
  }
}

export async function startScheduler(): Promise<void> {
  await seedDefaultSources();
  await seedDefaultSearchProfiles();

  // Daily at 6:00 AM
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
