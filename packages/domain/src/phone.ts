// Phone normalization for caller matching (M2-T08). Comparing bare digits means formatting
// differences between what a provider sends and what staff typed into a contact record don't
// cause false negatives or false positives.

/**
 * Normalize a phone number to bare digits, dropping a leading US/Canada country code so
 * "+1 (555) 010-0100" and "555-010-0100" compare equal. Returns null for empty/unparseable input.
 */
export function normalizePhoneNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** A US/Canada (NANP) phone number normalized to E.164, with any dialing extension split out. */
export interface E164PhoneNumber {
  /** "+1XXXXXXXXXX" */
  e164: string;
  /** Digits only, or null if none was present. */
  extension: string | null;
}

const EXTENSION_PATTERN = /(?:ext\.?|extension|x)\s*(\d{1,6})\s*$/i;

/**
 * Normalize a US/Canada phone number to E.164 ("+1XXXXXXXXXX"), splitting off a trailing
 * extension ("x123", "ext. 123", "extension 123") if present. Returns null for input that
 * isn't a plausible 10-digit NANP number: too few/many digits, or an area code/exchange code
 * starting with 0 or 1 (reserved in the NANP and never a real subscriber number).
 */
export function normalizeToE164(raw: string | null | undefined): E164PhoneNumber | null {
  if (!raw) return null;

  const extMatch = raw.match(EXTENSION_PATTERN);
  const extension = extMatch ? (extMatch[1] ?? null) : null;
  const withoutExtension = extMatch ? raw.slice(0, extMatch.index) : raw;

  const digits = withoutExtension.replace(/\D/g, "");
  let national: string;
  if (digits.length === 11 && digits.startsWith("1")) {
    national = digits.slice(1);
  } else if (digits.length === 10) {
    national = digits;
  } else {
    return null;
  }

  if (/^[01]/.test(national) || /^[01]/.test(national.slice(3, 6))) return null;

  return { e164: `+1${national}`, extension };
}
