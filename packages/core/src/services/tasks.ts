import {
  createCallbackTaskInput,
  createTaskInput,
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  updateTaskStatusInput,
  type CreateCallbackTaskInput,
  type CreateTaskInput,
  type Priority,
  type Task,
  type TaskStatus,
  type UUID,
} from "@backoffice/domain";
import { toTask, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { assertEntityInOrg, assertUserIsMember } from "./entities";
import { recordEvent } from "./events";

export async function createTask(ctx: ServiceContext, input: CreateTaskInput): Promise<Task> {
  await ctx.authorize("task.create");
  const data = parseInput(createTaskInput, input);
  await assertEntityInOrg(ctx, data.entityType, data.entityId);
  if (data.assignedUserId) await assertUserIsMember(ctx, data.assignedUserId);

  const { rows } = await ctx.scoped<Row>(
    `insert into public.tasks
       (organization_id, title, description, priority, due_at, entity_type, entity_id, assigned_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      ctx.organizationId,
      data.title,
      data.description ?? null,
      data.priority,
      data.dueAt ?? null,
      data.entityType ?? null,
      data.entityId ?? null,
      data.assignedUserId ?? null,
    ],
  );
  const task = toTask(rows[0] as Row);
  await recordEvent(ctx, {
    type: EVENT_TYPES.taskCreated,
    entityType: "task",
    entityId: task.id,
    payload: { title: task.title, priority: task.priority },
  });
  return task;
}

/**
 * Agent-callable: create a callback task linked to the call/communication that prompted it
 * (MASTER_SPEC §8 GREEN action). A thin wrapper over `createTask` — authorization, the same-org
 * entity check and the task.created event/audit all come from there.
 */
export async function createCallbackTask(
  ctx: ServiceContext,
  input: CreateCallbackTaskInput,
): Promise<Task> {
  const data = parseInput(createCallbackTaskInput, input);
  return createTask(ctx, {
    title: data.title,
    description: data.description,
    priority: data.priority,
    dueAt: data.dueAt,
    assignedUserId: data.assignedUserId,
    entityType: "communication",
    entityId: data.communicationId,
  });
}

export async function listOpenTasks(
  ctx: ServiceContext,
  priorities: readonly Priority[] = ["high", "urgent"],
): Promise<Task[]> {
  await ctx.authorize("task.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.tasks
      where organization_id = $1
        and status in ('open', 'in_progress')
        and priority = any($2::text[])
      order by case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
               due_at nulls last, created_at`,
    [ctx.organizationId, priorities],
  );
  return rows.map(toTask);
}

export async function updateTaskStatus(
  ctx: ServiceContext,
  taskId: UUID,
  status: TaskStatus,
): Promise<Task> {
  await ctx.authorize("task.update", { entityType: "task", entityId: taskId });
  const data = parseInput(updateTaskStatusInput, { status });
  const { rows } = await ctx.scoped<Row>(
    `update public.tasks set status = $3 where id = $1 and organization_id = $2 returning *`,
    [taskId, ctx.organizationId, data.status],
  );
  if (!rows[0]) throw new NotFoundError("task", taskId);
  const task = toTask(rows[0]);
  await recordEvent(ctx, {
    type: EVENT_TYPES.taskStatusChanged,
    entityType: "task",
    entityId: task.id,
    payload: { status: task.status },
  });
  return task;
}
