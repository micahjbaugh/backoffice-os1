// Static guards on the client/server boundary. Cheap, fast, and catch mistakes before a build does.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = join(import.meta.dirname, "..");
const srcDir = join(appDir, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(srcDir).filter((f) => /\.(ts|tsx)$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(appDir, f).replaceAll("\\", "/");
const isClient = (f: string) => /^\s*["']use client["']/.test(read(f));
const isServerAction = (f: string) => /^\s*["']use server["']/.test(read(f));

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SECRET_NAME = /SECRET|SERVICE|DATABASE|PASSWORD|PRIVATE|TOKEN/i;

describe("client/server boundary", () => {
  it("every module under src/server is marked server-only", () => {
    const missing = sourceFiles
      .filter((f) => rel(f).startsWith("src/server/"))
      .filter((f) => !read(f).includes(`import "server-only"`))
      .map(rel);
    expect(missing).toEqual([]);
  });

  it("client components never import server modules, the core services, or the DB driver", () => {
    const forbidden = [
      /from ["']@\/server/,
      /from ["']@backoffice\/core/,
      /from ["']pg["']/,
      /from ["']next\/headers["']/,
    ];
    const violations = sourceFiles
      .filter(isClient)
      .flatMap((f) =>
        forbidden.filter((re) => re.test(read(f))).map((re) => `${rel(f)} matches ${re}`),
      );
    expect(sourceFiles.some(isClient)).toBe(true);
    expect(violations).toEqual([]);
  });

  it("no NEXT_PUBLIC_ variable carries a secret-looking name", () => {
    const files = [...sourceFiles, join(appDir, ".env.example"), join(appDir, "next.config.ts")];
    const names = files.flatMap((f) =>
      [...read(f).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)].map((m) => m[0]),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => SECRET_NAME.test(n.replace("NEXT_PUBLIC_", "")))).toEqual([]);
  });

  it("browser-importable modules only read NEXT_PUBLIC_ environment variables", () => {
    const browserReachable = sourceFiles.filter(
      (f) => isClient(f) || rel(f).startsWith("src/lib/") || rel(f).startsWith("src/components/"),
    );
    const violations = browserReachable.flatMap((f) =>
      [...read(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)]
        .map((m) => m[1] ?? "")
        .filter((name) => !name.startsWith("NEXT_PUBLIC_"))
        .map((name) => `${rel(f)} reads ${name}`),
    );
    expect(violations).toEqual([]);
  });

  it("every exported server action authenticates before doing work", () => {
    const actionFiles = sourceFiles.filter(isServerAction);
    expect(actionFiles.length).toBeGreaterThan(0);
    const guards =
      /withTenant\(|withOperator\(|requireUser\(|getUserSession\(|auth\.sign(In|Up|Out)/;
    const unguarded = actionFiles.flatMap((f) => {
      const source = read(f);
      const exports = [...source.matchAll(/export async function (\w+)/g)];
      return exports
        .map((m, i) => {
          const start = m.index ?? 0;
          const end = exports[i + 1]?.index ?? source.length;
          return { name: m[1], body: source.slice(start, end) };
        })
        .filter(({ body }) => !guards.test(body))
        .map(({ name }) => `${rel(f)}#${name}`);
    });
    expect(unguarded).toEqual([]);
  });

  it("server actions never expose raw event/audit writers", () => {
    const exposed = sourceFiles
      .filter(isServerAction)
      .filter((f) => /\b(recordEvent|writeAudit)\b/.test(stripComments(read(f))))
      .map(rel);
    expect(exposed).toEqual([]);
  });

  it("server actions take the organization from the session, not from the form", () => {
    const offenders = sourceFiles
      .filter(isServerAction)
      .filter((f) => /field\(form, ["']organizationId["']\)/.test(read(f)))
      .filter((f) => !/selectOrganizationAction[\s\S]*organizations\.some/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
