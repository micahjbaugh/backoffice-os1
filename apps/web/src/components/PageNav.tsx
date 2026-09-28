import Link from "next/link";

/** Forward-only cursor pagination control: "Next" when there's more, "Start over" once paged in. */
export function PageNav({
  basePath,
  cursor,
  nextCursor,
  cursorParam = "cursor",
}: {
  basePath: string;
  cursor: string | undefined;
  nextCursor: string | null;
  cursorParam?: string;
}) {
  if (!cursor && !nextCursor) return null;
  return (
    <p className="row page-nav">
      {cursor ? <Link href={basePath}>← Start over</Link> : null}
      {nextCursor ? (
        <Link href={`${basePath}?${cursorParam}=${encodeURIComponent(nextCursor)}`}>
          Next page →
        </Link>
      ) : null}
    </p>
  );
}
