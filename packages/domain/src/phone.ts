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
