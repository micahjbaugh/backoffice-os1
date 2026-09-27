// M3-T13: provider-independent fact-validation helpers (ARCHITECTURE.md §4 step 5: known
// employee? known job? time format plausible? duplicate?). Pure functions only — no DB, no
// authorization — so packages/core can layer entity resolution (employee/job/equipment matching,
// M3-T11/T12/T13) on top without any of this logic depending on a database connection.

import type { FieldCaptureFact } from "./extraction";

/** A field-level confidence below this can't be trusted enough to draft without review
 *  (CLAUDE.md rule 14; MASTER_SPEC.md §15: low-confidence fields stay draft and raise clarification). */
export const FACT_CONFIDENCE_THRESHOLD = 0.65;

/** A single person can't plausibly work (or run one piece of equipment) longer than this in a day. */
export const MAX_PLAUSIBLE_SHIFT_HOURS = 16;

/** True only if every scored field meets the confidence threshold; a fact with no confidence
 *  entries at all has nothing to distrust, so it passes vacuously. */
export function meetsConfidenceThreshold(
  confidence: Readonly<Record<string, number>>,
  threshold: number = FACT_CONFIDENCE_THRESHOLD,
): boolean {
  return Object.values(confidence).every((score) => score >= threshold);
}

const CLOCK_TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

/** Parse a crew-shorthand clock time ("7", "7:00", "5:30pm") into hour-of-day (0-24.99). Returns
 *  null for anything that isn't a plausible clock time. */
export function parseClockTime(raw: string): number | null {
  const match = CLOCK_TIME_RE.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  const meridiem = match[3]?.toLowerCase();
  let h = hour;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  return h + minute / 60;
}

/**
 * Compute shift length from crew shorthand like "7-5:30" (startTime "7:00", endTime "5:30"): a
 * field crew reports a start and end clock time, never am/pm, and the end is always later in the
 * same workday even though its bare hour reads earlier than the start (5:30 < 7:00) — so an end
 * with no explicit meridiem that isn't already after the start is treated as PM. Returns null when
 * either side doesn't parse as a clock time, or the resulting shift isn't positive.
 */
export function computeShiftHours(startTime: string, endTime: string): number | null {
  const start = parseClockTime(startTime);
  const end = parseClockTime(endTime);
  if (start === null || end === null) return null;
  const hasMeridiem = /am|pm/i.test(endTime);
  const adjustedEnd = end <= start && !hasMeridiem ? end + 12 : end;
  const hours = adjustedEnd - start;
  return hours > 0 ? hours : null;
}

/** True for a positive duration a person or a piece of equipment could plausibly log in one day. */
export function isPlausibleHours(hours: number, max: number = MAX_PLAUSIBLE_SHIFT_HOURS): boolean {
  return hours > 0 && hours <= max;
}

function normalizeFieldValue(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

/** A signature of a fact's type and field values, ignoring factKey/confidence/evidence, so two
 *  facts the extractor emitted under different keys but describing the same thing compare equal.
 *  Field entries are sorted by key so two facts with identical fields in different insertion
 *  orders (JSON.stringify would otherwise preserve insertion order) produce the same signature. */
function factSignature(fact: FieldCaptureFact): string {
  const normalized = Object.entries(fact.fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, normalizeFieldValue(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([fact.type, normalized]);
}

/** True when some other fact in `others` (never `fact` itself, compared by factKey) describes the
 *  same type and field values — an extraction duplicate, not a second real-world occurrence. */
export function isDuplicateFact(
  fact: FieldCaptureFact,
  others: readonly FieldCaptureFact[],
): boolean {
  const signature = factSignature(fact);
  return others.some(
    (other) => other.factKey !== fact.factKey && factSignature(other) === signature,
  );
}
