import { describe, expect, it } from "vitest";
import { INTEGRATIONS_PACKAGE } from "../src";

describe("@backoffice/integrations skeleton", () => {
  it("exports a package marker", () => {
    expect(INTEGRATIONS_PACKAGE).toBe("@backoffice/integrations");
  });
});
