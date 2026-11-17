import {
  TenderSourceAdapter, TenderOpportunity, fetchListingHtml, stripHtml, parseLooseDate,
} from "./base-adapter.js";

// NOTE: despite the historical "ungm" adapter type, this reads the UNDP
// Procurement Notices site (server-rendered, one row per notice with country,
// process type and deadline). The runner then opens each new notice's own page
// to get the real scope text.

const LISTING_URL = "https://procurement-notices.undp.org/";

// Caribbean offices/countries as they appear in the "UNDP Office/Country" column.
const CARIBBEAN_RX =
  /bahamas|jamaica|barbados|trinidad|guyana|belize|suriname|haiti|dominican republic|saint lucia|st\.? lucia|grenada|antigua|dominica\b|saint vincent|st\.? vincent|saint kitts|st\.? kitts|cuba|caribbean|turks|cayman|bermuda|aruba|cura[cç]ao|sint maarten|montserrat|anguilla|virgin islands/i;

// Titles that suggest communications / marketing / creative work anywhere in the world.
const COMMS_RX =
  /communicat|marketing|media\b|campaign|brand|awareness|outreach|visibility|public relations|advocacy|video|film|documentar|photograph|graphic|design of|content|storytelling|social media|website|web design|publication|editorial|sensiti[sz]ation|multimedia|audio.?visual|creative|advertis|event management|public information/i;

const MAX_ITEMS = 80;

function cell(block: string, label: string): string {
  const rx = new RegExp(
    `vacanciesTable__cell__label">\\s*${label}\\s*</div>\\s*<span>([\\s\\S]*?)</span>`, "i",
  );
  const m = block.match(rx);
  return m ? stripHtml(m[1], 300) : "";
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, "and");
}

export class UNGMAdapter implements TenderSourceAdapter {
  adapterType = "ungm";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const html = await fetchListingHtml(LISTING_URL);

    const rowPattern =
      /<a\s+href="(view_n[a-z]+\.cfm\?(?:notice|nego)_id=(\d+))"[^>]*class="vacanciesTableLink[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    const caribbean: TenderOpportunity[] = [];
    const comms: TenderOpportunity[] = [];
    const seen = new Set<string>();
    let rowCount = 0;
    let match: RegExpExecArray | null;

    while ((match = rowPattern.exec(html)) !== null) {
      rowCount++;
      const [, path, noticeId, block] = match;
      if (seen.has(noticeId)) continue;
      seen.add(noticeId);

      const title = cell(block, "Title");
      if (title.length < 8) continue;

      const refNo = cell(block, "Ref No");
      const office = cell(block, "UNDP Office/Country");
      const process = cell(block, "Process");
      const deadline = parseLooseDate(cell(block, "Deadline"));

      // "UNDP-JAM/BAHAMAS" → "Bahamas"
      const countryRaw = office.includes("/") ? office.split("/").pop()!.trim() : office;
      const isCaribbean = CARIBBEAN_RX.test(office) || CARIBBEAN_RX.test(title);
      const isComms = COMMS_RX.test(title);
      if (!isCaribbean && !isComms) continue;

      const opp: TenderOpportunity = {
        externalId: `undp-${noticeId}`,
        title,
        organization: "UNDP",
        url: `https://procurement-notices.undp.org/${path}`,
        deadline,
        // Headline-only for now; replaced with the real notice text by the runner.
        description: `UNDP procurement notice: ${title}`,
        country: countryRaw ? titleCase(countryRaw) : "International",
        sector: process || "United Nations",
        rawData: { refNo, office, process },
      };
      (isCaribbean ? caribbean : comms).push(opp);
    }

    if (rowCount === 0) {
      throw new Error("UNDP listing loaded but no notice rows were recognised — page layout may have changed");
    }

    // Caribbean notices first, then comms-flavoured notices from elsewhere.
    return [...caribbean, ...comms].slice(0, MAX_ITEMS);
  }
}
