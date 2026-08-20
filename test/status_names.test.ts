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

  it.each([
    ["C0, BEL", 0x07],
    ["DEL", 0x7f],
    ["C1, NEL", 0x85],
    ["C1, top of the block", 0x9f],
  ])("rejects a name carrying a %s control character", (_label, code) => {
    // DEL and the whole C1 block used to slip through: the check spelled its
    // control range as \x00-\x1f, which stops short of both. They are just as
    // unprintable, and one in a stage name yields frontmatter Obsidian cannot
    // parse. Pinned on both sides: the server mirrors this as
    // [\x00-\x1f\x7f-\x9f], since Python has no \p{Cc}.
    expect(validateFunnelName(`hot${String.fromCharCode(code)}lead`)).not.toBeNull();
  });

  it("keeps accepted names usable as a single folder segment", () => {
    const folder = funnelFolderName("Waiting on client");
    expect(folder).toBe("Waiting on client");
    expect(folder.includes("/")).toBe(false);
  });
});
