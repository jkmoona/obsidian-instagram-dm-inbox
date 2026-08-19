import { describe, expect, it } from "vitest";
import { funnelFolderName, validateFunnelName } from "../src/types";

describe("validateFunnelName", () => {
  it.each(["new", "Waiting on client", "follow-up", "Beklemede", "stage 2"])(
    "accepts %j",
    (name) => {
      expect(validateFunnelName(name)).toBeNull();
    },
  );

  it.each([
    "",
    "   ",
    "follow/up",
    "back\\slash",
    "a:b",
    "q?",
    "wild*",
    'quo"te',
    "lt<gt>",
    "pipe|d",
    "hash#",
    "caret^",
    "brack[et]",
    "_archive",
    ".dot",
    "dot.",
    "new\nline",
  ])("rejects %j", (name) => {
    expect(validateFunnelName(name)).not.toBeNull();
  });

  it("keeps accepted names usable as a single folder segment", () => {
    const folder = funnelFolderName("Waiting on client");
    expect(folder).toBe("Waiting on client");
    expect(folder.includes("/")).toBe(false);
  });
});
