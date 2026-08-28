export const DEFAULT_DIGEST_RECIPIENTS = [
  "r.dean@onwrdadvisors.com",
  "s.esmeralda@onwrdadvisors.com",
  "j.aymes@onwrdadvisors.com",
] as const;

const LEGACY_DEFAULT_DIGEST_RECIPIENTS = ["j.aymes@onwrdadvisors.com"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DigestRecipientValidation {
  emails: string[];
  invalid: string[];
}

export function validateDigestRecipients(value: unknown): DigestRecipientValidation {
  if (!Array.isArray(value)) {
    return { emails: [], invalid: ["Recipients must be an array"] };
  }

  const emails: string[] = [];
  const invalid: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      invalid.push(String(item));
      continue;
    }
    const email = item.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      invalid.push(item);
      continue;
    }
    if (!emails.includes(email)) emails.push(email);
  }
  return { emails, invalid };
}

export function parseDigestRecipients(serialized: string): string[] {
  try {
    return validateDigestRecipients(JSON.parse(serialized)).emails;
  } catch {
    return [];
  }
}

export function shouldUpgradeLegacyRecipients(emails: string[]): boolean {
  return (
    emails.length === LEGACY_DEFAULT_DIGEST_RECIPIENTS.length &&
    emails.every((email, index) => email === LEGACY_DEFAULT_DIGEST_RECIPIENTS[index])
  );
}