import { describe, expect, it } from "vitest";
import { WORKFLOWS_PACKAGE } from "../src";

describe("@backoffice/workflows skeleton", () => {
  it("exports a package marker", () => {
    expect(WORKFLOWS_PACKAGE).toBe("@backoffice/workflows");
  });
});
