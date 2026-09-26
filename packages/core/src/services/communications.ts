// M2-T09 (step 1/2): persist calls with participants and provider identifiers. Idempotent per
// (organization_id, provider, provider_conversation_id) so a later lifecycle event for the same
// call (e.g. call.ended after call.started) updates the existing row instead of duplicating it.
// Duplicate delivery of the *same* provider event is already blocked upstream by webhook_receipts
// (M2-T06); this only folds distinct lifecycle events for one call into a single record.
// Message support (SMS/email) lands in a follow-up step — see workflow/state.json handoff.

import {
  EVENT_TYPES,
  parseInput,
  recordCallInput,
  type Call,
  type Communication,
  type CommunicationParticipant,
  type RecordCallInput,
  type UUID,
} from "@backoffice/domain";
import { toCall, toCommunication, toCommunicationParticipant, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

interface Envelope {
  direction: "inbound" | "outbound";
  provider: string;
  providerConversationId: string;
  status: "in_progress" | "completed" | "failed" | "abandoned";
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  transcript?: string;
  participants: readonly {
    role: string;
    customerId?: UUID;
    employeeId?: UUID;
    vendorId?: UUID;
    phone?: string;
    email?: string;
    displayName?: string;
  }[];
}

/** Find-or-create the shared communications envelope for one conversation. */
async function upsertEnvelope(
  ctx: ServiceContext,
  channel: "voice" | "sms" | "email",
  d: Envelope,
): Promise<{ communication: Communication; created: boolean }> {
  const { rows: existingRows } = await ctx.tx.asService<Row>(
    `select * from public.communications
      where organization_id = $1 and provider = $2 and provider_conversation_id = $3`,
    [ctx.organizationId, d.provider, d.providerConversationId],
  );
  const existing = existingRows[0];
  const { rows } = existing
    ? await ctx.tx.asService<Row>(
        `update public.communications
            set status = $3, ended_at = coalesce($4, ended_at), summary = coalesce($5, summary),
                transcript = coalesce($6, transcript)
          where id = $1 and organization_id = $2 returning *`,
        [existing.id, ctx.organizationId, d.status, d.endedAt ?? null, d.summary ?? null, d.transcript ?? null],
      )
    : await ctx.tx.asService<Row>(
        `insert into public.communications
           (organization_id, channel, direction, status, provider, provider_conversation_id,
            started_at, ended_at, summary, transcript)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, now()), $8, $9, $10) returning *`,
        [
          ctx.organizationId, channel, d.direction, d.status, d.provider, d.providerConversationId,
          d.startedAt ?? null, d.endedAt ?? null, d.summary ?? null, d.transcript ?? null,
        ],
      );
  const row = rows[0];
  if (!row) throw new Error("communication upsert returned no row");
  return { communication: toCommunication(row), created: !existing };
}

/** Replace the participant list; a same-org check guards each customer/employee/vendor reference. */
async function setParticipants(
  ctx: ServiceContext,
  communicationId: UUID,
  participants: Envelope["participants"],
): Promise<CommunicationParticipant[]> {
  if (participants.length === 0) {
    const { rows } = await ctx.tx.asService<Row>(
      `select * from public.communication_participants where communication_id = $1 order by created_at`,
      [communicationId],
    );
    return rows.map(toCommunicationParticipant);
  }
  for (const p of participants) {
    if (p.customerId) await assertEntityInOrg(ctx, "customer", p.customerId);
    if (p.employeeId) await assertEntityInOrg(ctx, "employee", p.employeeId);
    if (p.vendorId) await assertEntityInOrg(ctx, "vendor", p.vendorId);
  }
  await ctx.tx.asService(`delete from public.communication_participants where communication_id = $1`, [
    communicationId,
  ]);
  const inserted: CommunicationParticipant[] = [];
  for (const p of participants) {
    const { rows } = await ctx.tx.asService<Row>(
      `insert into public.communication_participants
         (organization_id, communication_id, role, customer_id, employee_id, vendor_id, phone, email, display_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        ctx.organizationId, communicationId, p.role, p.customerId ?? null, p.employeeId ?? null,
        p.vendorId ?? null, p.phone ?? null, p.email ?? null, p.displayName ?? null,
      ],
    );
    inserted.push(toCommunicationParticipant(rows[0] as Row));
  }
  return inserted;
}

async function finish(ctx: ServiceContext, communication: Communication, created: boolean): Promise<void> {
  const { event } = await recordEvent(ctx, {
    type: created ? EVENT_TYPES.communicationRecorded : EVENT_TYPES.communicationUpdated,
    entityType: "communication",
    entityId: communication.id,
    payload: { channel: communication.channel, direction: communication.direction, provider: communication.provider },
  });
  await writeAudit(ctx, {
    action: created ? "communication.recorded" : "communication.updated",
    entityType: "communication",
    entityId: communication.id,
    sourceEventId: event.id,
    details: {
      channel: communication.channel,
      provider: communication.provider,
      provider_conversation_id: communication.providerConversationId,
    },
  });
}

export interface RecordedCall {
  communication: Communication;
  call: Call;
  participants: CommunicationParticipant[];
  created: boolean;
}

/** Persist a call and its envelope, keyed on (provider, provider_conversation_id). */
export async function recordCall(ctx: ServiceContext, input: RecordCallInput): Promise<RecordedCall> {
  await ctx.authorize("communication.write");
  const data = parseInput(recordCallInput, input);
  const { communication, created } = await upsertEnvelope(ctx, "voice", data);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.calls
       (organization_id, communication_id, provider_call_id, from_number, to_number,
        duration_seconds, recording_url, disposition, voicemail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (communication_id) do update set
       provider_call_id = coalesce(excluded.provider_call_id, public.calls.provider_call_id),
       duration_seconds = coalesce(excluded.duration_seconds, public.calls.duration_seconds),
       recording_url = coalesce(excluded.recording_url, public.calls.recording_url),
       disposition = coalesce(excluded.disposition, public.calls.disposition),
       voicemail = excluded.voicemail or public.calls.voicemail
     returning *`,
    [
      ctx.organizationId, communication.id, data.providerCallId ?? null, data.fromNumber ?? null,
      data.toNumber ?? null, data.durationSeconds ?? null, data.recordingUrl ?? null,
      data.disposition ?? null, data.voicemail,
    ],
  );
  const call = toCall(rows[0] as Row);
  const participants = await setParticipants(ctx, communication.id, data.participants);
  await finish(ctx, communication, created);
  return { communication, call, participants, created };
}

export async function getCommunication(ctx: ServiceContext, id: UUID): Promise<Communication | null> {
  await ctx.authorize("communication.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.communications where id = $1 and organization_id = $2`,
    [id, ctx.organizationId],
  );
  return rows[0] ? toCommunication(rows[0]) : null;
}
