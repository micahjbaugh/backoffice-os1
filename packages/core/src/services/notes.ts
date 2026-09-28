import {
  actorUserId,
  addNoteInput,
  EVENT_TYPES,
  parseInput,
  type AddNoteInput,
  type Note,
  type UUID,
} from "@backoffice/domain";
import { MAX_UNPAGINATED_ROWS } from "../pagination";
import { toNote, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

export async function addNote(ctx: ServiceContext, input: AddNoteInput): Promise<Note> {
  const data = parseInput(addNoteInput, input);
  await ctx.authorize("note.add", { entityType: data.entityType, entityId: data.entityId });
  await assertEntityInOrg(ctx, data.entityType, data.entityId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.notes (organization_id, entity_type, entity_id, body, author_actor_type, author_user_id)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [
      ctx.organizationId,
      data.entityType,
      data.entityId,
      data.body,
      ctx.actor.type,
      actorUserId(ctx.actor),
    ],
  );
  const note = toNote(rows[0] as Row);
  const { event } = await recordEvent(ctx, {
    type: EVENT_TYPES.noteAdded,
    entityType: data.entityType,
    entityId: data.entityId,
    payload: { note_id: note.id },
  });
  await writeAudit(ctx, {
    action: "note.added",
    entityType: data.entityType,
    entityId: data.entityId,
    sourceEventId: event.id,
    ...(data.entityType === "approval" ? { approvalId: data.entityId } : {}),
    details: { note_id: note.id },
  });
  return note;
}

export async function listNotes(
  ctx: ServiceContext,
  entityType: string,
  entityIds: readonly UUID[],
): Promise<Note[]> {
  await ctx.authorize("note.read");
  if (entityIds.length === 0) return [];
  const { rows } = await ctx.scoped<Row>(
    `select * from public.notes
      where organization_id = $1 and entity_type = $2 and entity_id = any($3::uuid[])
      order by created_at
      limit $4`,
    [ctx.organizationId, entityType, entityIds, MAX_UNPAGINATED_ROWS],
  );
  return rows.map(toNote);
}
