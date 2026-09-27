# M3 Build Report — Field Capture

Date: 2026-09-27 · Milestone acceptance: `docs/MILESTONES.md` (M3) · Prior context: `docs/REPAIR_REPORT.md`

**Status:** The completion gate passes. `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and
`pnpm test` all succeed (645 tests passing, 7 skipped). The M3 automated acceptance suite
(`pnpm --filter @backoffice/workflows exec vitest run test/acceptance-m3`) asserts every bullet in
the MILESTONES.md acceptance list against the exact input text and was accepted by the referee
after also running against a local Supabase stack (`workflow/blueprint.json`, M3-T18,
`accepted_at: 2026-09-27T20:07:38.764Z`). This machine had no Supabase CLI installed, so the 7
skipped tests are `packages/core/test/live-stack.test.ts`, which only runs against a real Supabase
instance — the same caveat M1 and M2 recorded.

---

## 1. What was implemented

### Schema (`supabase/migrations/0006`–`0011`, `0016`)

| Migration | Contents |
|---|---|
| `0006_equipment.sql` | `equipment` registry: name, type, `aliases text[]`, internal/billable rates, active flag. RLS + tenant isolation tests. |
| `0007_time_entries.sql` | `time_entries`: employee, job, work date, start/end, hours, `status` (draft/approved/rejected), `source_communication_id`, `confidence`/`evidence` jsonb. |
| `0008_equipment_material_usage.sql` | `equipment_usages` and `material_usages`, same draft/source/confidence shape. |
| `0009_job_notes_billable_opportunities.sql` | `job_notes` and `billable_opportunities` (`status` open/approved/dismissed), with evidence. |
| `0010_draft_record_idempotency.sql` | Unique `(source_communication_id, fact_key)` per draft table — the replay guard for M3-T14. |
| `0011_draft_decision_authority.sql` | **Foundation-repair finding 7.** 0007–0009 let clients set `status` directly via PostgREST, so a JWT holder could self-approve billed hours with no policy check, event or audit. Adds decision columns, revokes client write access to them, and a trigger makes decided rows immutable; decisions now only happen through `draft-decisions.ts`. |
| `0016_billable_opportunity_idempotency.sql` | Closes a replay-duplication gap for billable opportunities that the other draft tables didn't have. |

### Domain (`packages/domain/src`)

- `extraction.ts`: `StructuredExtractor<T>` contract, `fieldCaptureExtractionSchema` (zod
  discriminated union over the five fact types), per-field `confidence`, quoted `evidence` spans,
  and `unresolvedQuestions` for gaps the extractor can't tie to one fact.
- `fact-validation.ts`: pure helpers — `meetsConfidenceThreshold` (0.65 default), `parseClockTime`
  / `computeShiftHours` (crew shorthand like "7-5:30" → 10.5h, handling the implicit PM rollover),
  `isPlausibleHours` (16h/day ceiling), `isDuplicateFact` (field-value signature, not factKey).

### Core services (`packages/core/src/services`)

- `job-matching.ts` / `equipment-matching.ts`: case-insensitive substring match (either direction)
  against job/customer name or equipment name/aliases. Zero matches or more than one both open a
  clarification ops case (never guess which job/equipment a draft belongs to); ambiguous cases list
  every candidate as evidence.
- `fact-validator.ts`: runs after extraction, before any draft write — duplicate check, confidence
  threshold, employee/job/equipment resolution, plausible-hours check — and returns `valid`,
  `needs_clarification` (with a typed reason and an already-created ops case), or `duplicate`.
- `field-capture-drafts.ts`: turns one `valid` fact into its draft row (time entry, equipment
  usage, material usage, job note, or — for a detected scope change — an open billable
  opportunity), resolving the work date from the communication's timestamp in the org's timezone
  when unstated. A resolved fact with no job still can't become a draft row (`job_id` is
  `NOT NULL`), so it clarifies instead of guessing the job.
- `field-capture.ts`: `runFieldCaptureWorkflow` — the orchestrator. Idempotent per communication:
  the whole run is gated on one `recordEvent` keyed on `field_capture.processed:<communicationId>`,
  so a replay finds the marker and returns `{ processed: false }` before extracting anything again.
- `draft-decisions.ts` (from the M2 repair, extended here): `decideDraftRecord` /
  `decideBillableOpportunity` apply the same approval-authority policy as M1's approvals, write the
  decision columns, an event and an audit record — the only path that can move a draft out of
  `draft`/`open`.

### AI extraction (`packages/integrations/src`)

- `fakes/fixture-structured-extractor.ts`: deterministic extractor keyed by exact source text — no
  network call, used by every test and by `runtime-config.ts` when no model key is configured.
  Registers `FIELD_CAPTURE_ACCEPTANCE_MESSAGE`, the exact MILESTONES.md input, with the extraction a
  real adapter should produce (one time entry, two equipment usages, one material usage, a job
  note, one billable opportunity).
- `adapters/anthropic-structured-extractor.ts`: the real adapter. Calls the Anthropic Messages API
  with a forced tool call so the model can only respond with a schema-shaped extraction; the system
  prompt tells the model to lower confidence rather than invent values and never approves, bills or
  pays anything — no authorization logic in the prompt (CLAUDE.md rule 4). A malformed or missing
  tool-use response throws rather than falling back to a guess. Tested against mocked HTTP.

### Workflow wiring (`packages/workflows/src/webhook-processor.ts`)

Inbound SMS from a phone number that resolves to exactly one known employee (M3-T00/T01) is routed
into `runFieldCaptureWorkflow` inline in the same webhook-processing transaction as M2's
communication recording; unknown numbers keep going through M2's lead-qualification/acknowledgement
path instead.

### Owner Inbox (`apps/web/src/app/(tenant)/inbox`)

Open clarification ops cases and open billable opportunities are listed alongside M1's approvals,
each with resolve/approve/dismiss actions that call `decideDraftRecord` / `decideBillableOpportunity`
server actions — never a direct status update from the client.

---

## 2. Architecture decisions

1. **Extraction is provider-independent and confidence-scored, not authoritative.** Nothing outside
   `packages/integrations` sees a vendor SDK type; the extractor only proposes candidate facts.
   Matching, thresholds and drafting all happen in `packages/core`, after extraction, so swapping
   the LLM adapter changes nothing else.
2. **Two independent idempotency layers.** The workflow-level event marker
   (`field_capture.processed:<id>`) stops a whole replay from re-running; the per-draft unique
   constraint (0010) stops a partial-crash retry from duplicating any one fact even if the marker
   and draft-writing steps ever became separable. The acceptance test exercises the workflow-level
   replay; the per-fact constraint is covered by the draft record service tests.
3. **Never guess — always a typed reason.** Every place a fact could go wrong (low confidence, no
   matching job/employee/equipment, more than one match, an implausible shift length, the extractor's
   own `unresolvedQuestions`) produces a `FactClarificationReason` and an ops case with the evidence
   that triggered it, not a best-effort draft. This is the mechanism behind the milestone's
   "low-confidence or ambiguous facts stay draft ... never a guess" bullet.
4. **Decision authority is enforced server-side, not by RLS alone (finding 7).** RLS still isolates
   tenants, but the *decision* — moving a draft to approved/dismissed — is column-privilege-blocked
   for clients and only reachable through a service that re-runs the same approval-authority policy
   M1 built for financial approvals. A decided row is trigger-immutable.
5. **Scope-change detection is confidence-scored extraction, not a separate NLP step.** The
   extractor is asked to emit a `billable_opportunity` fact type directly (M3-T15); there is no
   separate classifier. It is drafted `open`, never auto-approved, and shows up in the owner's inbox
   exactly like a clarification.

---

## 3. Test results

```text
pnpm format:check -> all files formatted
pnpm lint         -> exit 0 (7 packages)
pnpm typecheck    -> exit 0 (7 packages)
pnpm test         -> exit 0
  packages/domain       68/68
  packages/agents       11/11
  packages/integrations 73/73
  packages/core         382/389  (7 skipped: live-stack.test.ts, needs a running Supabase)
  packages/workflows    53/53
  apps/web              31/31
  workflow/scripts      27/27   (referee unit tests, unrelated to M3 behavior)
  TOTAL                 645 passing, 7 skipped
```

### M3 acceptance suite (`packages/workflows/test/acceptance-m3.test.ts`)

Drives `FIELD_CAPTURE_ACCEPTANCE_MESSAGE` — the exact MILESTONES.md text — through the real
webhook-processor path with the fixture extractor, and asserts every acceptance bullet directly:

| Bullet | Assertion |
|---|---|
| Drafts every fact type | 1 time-entry outcome (`needs_clarification`, not a guess), 2 equipment usages, 1 material usage, 1 job note, 1 billable opportunity, all attached to the matched job |
| Low-confidence facts never guess | The one sub-threshold field (`jobRef` confidence 0.6 < 0.65) stops the time entry at validation; zero rows land in `time_entries`; exactly one `low_confidence` ops case opens |
| Owner sees only what's necessary | `listPendingApprovals` is empty (field capture never creates an approval); the owner's open ops-case list and open-billables list contain exactly the one clarification and the one billable opportunity |
| Replay creates nothing new | Re-running the identical message returns `{ processed: false, outcomes: [], unresolvedQuestionCaseIds: [] }` and every table's row count is unchanged |

### Deliberate-break spot checks

Confirmed each of the following turns the acceptance test (or a targeted unit test) red, then
restored: skipping the confidence threshold (billable/time drafts guessed instead of clarifying),
removing the per-draft unique constraint (replay duplicated equipment usage rows), and reverting
0011's column privileges (a plain client update could set `time_entries.status = 'approved'`
directly).

---

## 4. Known limitations

- **No live-phone or live-SMS run in this session.** The M3-T18 acceptance run against local
  Supabase was performed by the referee in an earlier run; this session's environment has Docker but
  no Supabase CLI, so `live-stack.test.ts` is skipped here (same caveat as M1 §4 and M2).
- **Job/equipment matching is substring-based**, not fuzzy or phonetic. A typo like "Willson" for
  "Wilson" falls through to the ambiguous/no-match clarification path rather than a wrong guess —
  the safe failure mode, but more clarifications than a fuzzy matcher would produce.
- **Work date inference** falls back to the communication's timestamp in the org's timezone;
  texting about *yesterday's* work with no explicit date logs against today instead.
- **Equipment/material rates** are stored but unused — no cost rollup exists until OPS.
- **One extractor call per inbound message**, no field-capture-specific retry/backoff; a transient
  LLM API failure surfaces as a webhook-processing error for the outer M2 pipeline to handle.
- **The Anthropic adapter is untested against the live API** in this session (mocked-HTTP only,
  per M3-T10's own scope) — no real cost/latency data yet.

## 5. Security notes

1. **Finding 7 (foundation repair) is the load-bearing fix for this whole milestone**: without
   0011, any client holding a tenant JWT could set `status = 'approved'` on `time_entries`,
   `equipment_usages`, `material_usages` or `billable_opportunities` directly through PostgREST,
   bypassing the owner/office_admin/manager approval policy entirely. Decision columns are now
   revoked from client privileges and the guard trigger makes a decided row immutable.
2. **The AI prompt (`anthropic-structured-extractor.ts`) makes no authorization decisions** — it
   only proposes facts with confidence scores, per CLAUDE.md rule 4. All matching, thresholds and
   drafting happen in reviewed, tested `packages/core` code, not in the model's output path.
3. **Ops cases carry the evidence quote and raw reference text** (e.g. the ambiguous name) so an
   owner/operator can resolve them without re-reading the original message — this duplicates that
   text into `ops_cases` rather than leaving it only in the already-audited `communications` table.
4. **`resolveWorkDate` / `assertCommunicationInOrg` re-check `ctx.organizationId`**, so a
   cross-tenant `sourceCommunicationId` cannot attribute a draft to another org's job.
5. **The Anthropic API key is read from `ANTHROPIC_API_KEY` only**; nothing accepts it as a request
   parameter or logs it.

---

## 6. Commands to run locally

```bash
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test

# Live-stack (needs Docker + the Supabase CLI):
supabase start
pnpm --filter @backoffice/workflows exec vitest run test/acceptance-m3
```
