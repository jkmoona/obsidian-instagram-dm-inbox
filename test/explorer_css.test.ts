import { describe, expect, it } from "vitest";
import { buildExplorerCss } from "../src/explorer_css";
import { FUNNEL_COLOR_VARS } from "../src/palette";
import type { Funnel } from "../src/types";
import { META_FOLDER, quarantineFolder } from "../src/vault";

const STATUSES: Funnel[] = [
  { name: "new", code: null },
  { name: "pending", code: "!pending" },
  { name: "done", code: "!done" },
];

/** The colour variable the generated sheet assigns to one stage folder. */
function colorVarFor(css: string, folder: string): string {
  const rule = new RegExp(
    `\\.nav-folder-title\\[data-path="CRM/${folder}"\\] \\{ color: var\\((--[a-z-]+)\\)`,
  ).exec(css);
  if (!rule) throw new Error(`no colour rule for CRM/${folder}`);
  return rule[1];
}

describe("buildExplorerCss", () => {
  it("hides the _meta folder", () => {
    const css = buildExplorerCss("CRM", STATUSES);
    expect(css).toContain('[data-path="CRM/_meta"]');
    expect(css).toContain("display: none");
  });

  it("emits colored rules per funnel folder (folder-cased paths)", () => {
    const css = buildExplorerCss("CRM", STATUSES);
    expect(css).toContain('[data-path="CRM/New"]');
    expect(css).toContain('[data-path="CRM/Pending"]');
    expect(css).toContain('[data-path="CRM/Done"]');
    expect(css).toContain("--color-blue");
    expect(css).toContain("--color-yellow");
    expect(css).toContain("--color-green");
  });

  it("cycles the palette once funnels outnumber the hues", () => {
    // Asserted per stage. Counting occurrences of one colour cannot work here:
    // every stage emits two rules that each name its colour, so a single
    // funnel already produces two matches and a count-based assertion passes
    // whether the palette wraps or not.
    const many: Funnel[] = Array.from({ length: FUNNEL_COLOR_VARS.length + 1 }, (_, i) => ({
      name: `s${i}`,
      code: `!s${i}`,
    }));
    const css = buildExplorerCss("CRM", many);

    const first = colorVarFor(css, "S0");
    const second = colorVarFor(css, "S1");
    const wrapped = colorVarFor(css, `S${FUNNEL_COLOR_VARS.length}`);

    expect(wrapped).toBe(first); // the ninth stage reuses the first hue
    expect(second).not.toBe(first); // and it is cycling, not painting one colour
  });

  it("gives eight funnels eight distinct hues", () => {
    const eight: Funnel[] = FUNNEL_COLOR_VARS.map((_, i) => ({
      name: `s${i}`,
      code: `!s${i}`,
    }));
    const css = buildExplorerCss("CRM", eight);
    for (const cssVar of FUNNEL_COLOR_VARS) {
      expect(css).toContain(cssVar);
    }
  });

  it("keeps rescued messages visible in the file tree", () => {
    // The quarantine folder sits beside _meta rather than inside it precisely
    // so it is not hidden. A rescued DM the user cannot see would defeat the
    // point of rescuing it, and the notice names a path they would then be
    // unable to browse to.
    // Stated as "not underneath the folder we hide". Asserting the generated
    // CSS merely lacks the quarantine path would pass trivially: the sheet
    // names `CRM/_meta`, never a child of it, so a quarantine back inside
    // _meta would still not appear in the text.
    const hidden = `CRM/${META_FOLDER}`;
    expect(buildExplorerCss("CRM", STATUSES)).toContain(
      `.nav-folder:has(> .nav-folder-title[data-path="${hidden}"]) { display: none; }`,
    );
    expect(quarantineFolder("CRM").startsWith(hidden)).toBe(false);
  });

  it("escapes quotes in the CRM folder name", () => {
    const css = buildExplorerCss('C"RM', STATUSES);
    expect(css).toContain('C\\"RM');
  });
});
