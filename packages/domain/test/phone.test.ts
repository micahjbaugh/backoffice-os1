import { describe, expect, it } from "vitest";
import { normalizeToE164 } from "../src";

describe("normalizeToE164", () => {
  it("normalizes plain 10-digit US formats", () => {
    expect(normalizeToE164("415-555-0142")).toEqual({ e164: "+14155550142", extension: null });
    expect(normalizeToE164("(415) 555-0142")).toEqual({ e164: "+14155550142", extension: null });
    expect(normalizeToE164("415.555.0142")).toEqual({ e164: "+14155550142", extension: null });
    expect(normalizeToE164("4155550142")).toEqual({ e164: "+14155550142", extension: null });
  });

  it("normalizes formats that already include the country code", () => {
    expect(normalizeToE164("+1 415 555 0142")).toEqual({ e164: "+14155550142", extension: null });
    expect(normalizeToE164("1-415-555-0142")).toEqual({ e164: "+14155550142", extension: null });
    expect(normalizeToE164("+14155550142")).toEqual({ e164: "+14155550142", extension: null });
  });

  it("splits off extensions in common formats", () => {
    expect(normalizeToE164("415-555-0142 ext. 123")).toEqual({
      e164: "+14155550142",
      extension: "123",
    });
    expect(normalizeToE164("415-555-0142 extension 123")).toEqual({
      e164: "+14155550142",
      extension: "123",
    });
    expect(normalizeToE164("415-555-0142x9")).toEqual({ e164: "+14155550142", extension: "9" });
    expect(normalizeToE164("(415) 555-0142 x 123")).toEqual({
      e164: "+14155550142",
      extension: "123",
    });
  });

  it("returns null for junk input", () => {
    expect(normalizeToE164(null)).toBeNull();
    expect(normalizeToE164(undefined)).toBeNull();
    expect(normalizeToE164("")).toBeNull();
    expect(normalizeToE164("not a phone number")).toBeNull();
    expect(normalizeToE164("555-0142")).toBeNull(); // too few digits
    expect(normalizeToE164("415-555-01420000")).toBeNull(); // too many digits
    expect(normalizeToE164("2-415-555-0142")).toBeNull(); // unsupported country code
  });

  it("rejects NANP-reserved area and exchange codes", () => {
    expect(normalizeToE164("015-555-0142")).toBeNull(); // area code starts with 0
    expect(normalizeToE164("115-555-0142")).toBeNull(); // area code starts with 1
    expect(normalizeToE164("415-055-0142")).toBeNull(); // exchange code starts with 0
    expect(normalizeToE164("415-155-0142")).toBeNull(); // exchange code starts with 1
  });
});
