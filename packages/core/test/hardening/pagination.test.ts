// PH-T02 done_when: "No unbounded list queries remain" for customers, jobs, vendors, audit log,
// ops cases and the inbox (pending approvals, open tasks). Static check on the actual service
// source: every SQL template literal inside these list functions' implementation must carry an
// explicit `limit` clause, whether the caller asked for a cursor page or took the legacy capped
// array. A future edit that drops the limit (e.g. while "simplifying" a query) fails this test
// instead of shipping an unbounded query.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const servicesDir = join(here, "../../src/services");

const TARGETS: ReadonlyArray<{ file: string; functionName: string }> = [
  { file: "records.ts", functionName: "listCustomers" },
  { file: "records.ts", functionName: "listVendors" },
  { file: "jobs.ts", functionName: "listJobs" },
  { file: "audit.ts", functionName: "listAudit" },
  { file: "ops.ts", functionName: "listOrgOpsCases" },
  { file: "ops.ts", functionName: "listOperatorCases" },
  { file: "approvals.ts", functionName: "listPendingApprovals" },
  { file: "tasks.ts", functionName: "listOpenTasks" },
];

/**
 * The real implementation, not an overload signature: the one declared `async`. Skips past the
 * parameter list by tracking paren depth first, since a parameter's inline object type (e.g.
 * `options: { includeClosed?: boolean } = {}`) contains braces that are not the function body.
 */
function extractImplementation(source: string, name: string): string {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`could not find "async function ${name}" implementation`);
  let parenDepth = 0;
  let afterParams = start + marker.length - 1;
  for (; afterParams < source.length; afterParams++) {
    if (source[afterParams] === "(") parenDepth++;
    else if (source[afterParams] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const braceStart = source.indexOf("{", afterParams + 1);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** Every backtick template literal appearing in `body`, in source order. */
function templateLiterals(body: string): string[] {
  const templates: string[] = [];
  const regex = /`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) templates.push(match[1] ?? "");
  return templates;
}

describe("PH-T02: no unbounded list queries", () => {
  for (const { file, functionName } of TARGETS) {
    it(`${functionName} (${file}): every SQL statement carries a limit clause`, () => {
      const source = readFileSync(join(servicesDir, file), "utf8");
      const body = extractImplementation(source, functionName);
      // Every list query here is ordered (stable pagination needs it); use that as the marker for
      // "this is a full statement", since some queries interpolate their `select ... from` clause
      // from a module-level constant rather than spelling it out again in this literal.
      const statements = templateLiterals(body).filter((t) => /\border\s+by\b/i.test(t));
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement.toLowerCase()).toMatch(/\blimit\s+\$/);
      }
    });
  }
});
