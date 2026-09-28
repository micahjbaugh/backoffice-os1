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
import { buildPage, decodeCursor, MAX_UNPAGINATED_ROWS, resolvePageSize } from "../pagination";
import type { CursorPage, PageParams } from "../pagination";
import { toTask, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { assertEntityInOrg, assertUserIsMember } from "./entities";
import { recordEvent } from "./events";

/**
 * Create a task. Idempotent on (organization_id, idempotency_key) when the caller supplies one
 * (agent-callable wrappers always do; manual/UI tasks don't): a retried call with the same key
 * returns the original task and writes no new event or audit.
 */
export async function createTask(ctx: ServiceContext, input: CreateTaskInput): Promise<Task> {
  await ctx.authorize("task.create");
  const data = parseInput(createTaskInput, input);
  await assertEntityInOrg(ctx, data.entityType, data.entityId);
  if (data.assignedUserId) await assertUserIsMember(ctx, data.assignedUserId);

  const { rows } = await ctx.scoped<Row>(
    `insert into public.tasks
       (organization_id, title, description, priority, due_at, entity_type, entity_id, assigned_user_id, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
     returning *`,
    [
      ctx.organizationId,
      data.title,
      data.description ?? null,
      data.priority,
      data.dueAt ?? null,
      data.entityType ?? null,
      data.entityId ?? null,
      data.assignedUserId ?? null,
      data.idempotencyKey ?? null,
    ],
  );

  if (!rows[0]) {
    const existing = await ctx.scoped<Row>(
      `select * from public.tasks where organization_id = $1 and idempotency_key = $2`,
      [ctx.organizationId, data.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error("task idempotency conflict without existing row");
    return toTask(existing.rows[0]);
  }

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
    idempotencyKey: data.idempotencyKey,
    entityType: "communication",
    entityId: data.communicationId,
  });
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const TASK_ORDER = `case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
               coalesce(due_at, 'infinity'::timestamptz), created_at, id`;

interface TaskCursor {
  priorityRank: number;
  /** ISO timestamp, or the literal "infinity" standing in for a null due date (sorted last). */
  dueRank: string;
  createdAt: string;
  id: string;
}

export function listOpenTasks(
  ctx: ServiceContext,
  priorities?: readonly Priority[],
): Promise<Task[]>;
export function listOpenTasks(
  ctx: ServiceContext,
  priorities: readonly Priority[],
  page: PageParams,
): Promise<CursorPage<Task>>;
export async function listOpenTasks(
  ctx: ServiceContext,
  priorities: readonly Priority[] = ["high", "urgent"],
  page?: PageParams,
): Promise<Task[] | CursorPage<Task>> {
  await ctx.authorize("task.read");
  if (page === undefined) {
    const { rows } = await ctx.scoped<Row>(
      `select * from public.tasks
        where organization_id = $1
          and status in ('open', 'in_progress')
          and priority = any($2::text[])
        order by ${TASK_ORDER}
        limit $3`,
      [ctx.organizationId, priorities, MAX_UNPAGINATED_ROWS],
    );
    return rows.map(toTask);
  }
  const limit = resolvePageSize(page.limit);
  const cursor = decodeCursor<TaskCursor>(page.cursor);
  const { rows } = await ctx.scoped<Row>(
    `select * from public.tasks
      where organization_id = $1
        and status in ('open', 'in_progress')
        and priority = any($2::text[])
        and (
          $3::int is null
          or (case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
              coalesce(due_at, 'infinity'::timestamptz), created_at, id)
             > ($3, $4::timestamptz, $5::timestamptz, $6::uuid)
        )
      order by ${TASK_ORDER}
      limit $7`,
    [
      ctx.organizationId,
      priorities,
      cursor?.priorityRank ?? null,
      cursor?.dueRank ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const tasks = rows.map(toTask);
  return buildPage(tasks, limit, (t) => ({
    priorityRank: PRIORITY_RANK[t.priority],
    dueRank: t.dueAt ?? "infinity",
    createdAt: t.createdAt,
    id: t.id,
  }));
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
