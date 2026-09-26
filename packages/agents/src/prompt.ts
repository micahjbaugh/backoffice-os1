/**
 * A prompt is versioned source, not runtime configuration (ARCHITECTURE.md §9): it is tested and
 * tied to a tool-schema version, carries no secrets, and never encodes authorization decisions —
 * those live in packages/domain/permissions.ts and are enforced server-side regardless of what
 * the prompt text says.
 */
export interface VersionedPrompt {
  readonly agent: string;
  readonly version: number;
  readonly template: string;
}

/**
 * Fill `{{key}}` placeholders in a prompt template with tenant-specific values. Throws on a
 * missing value so a gap in the caller-supplied context fails closed instead of sending the
 * model a literal, unfilled placeholder.
 */
export function renderPrompt(prompt: VersionedPrompt, values: Readonly<Record<string, string>>): string {
  return prompt.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`renderPrompt: missing value for "${key}"`);
    return value;
  });
}
