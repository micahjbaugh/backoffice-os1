/** Result of a server action, rendered by <ActionForm>. `null` before the first submit. */
export type ActionState = { ok: boolean; message?: string } | null;
