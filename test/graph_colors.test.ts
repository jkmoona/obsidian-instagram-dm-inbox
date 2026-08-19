import { describe, expect, it } from "vitest";
import {
  GRAPH_FILTER_TERMS,
  GraphColorGroup,
  buildGraphColorGroups,
  buildGraphFilter,
  funnelQuery,
} from "../src/graph_colors";
import { FUNNEL_COLOR_HEX } from "../src/palette";
import type { Funnel } from "../src/types";

const STATUSES: Funnel[] = [
  { name: "new", code: null },
  { name: "pending", code: "!pending" },
  { name: "done", code: "!done" },
];

describe("funnelQuery", () => {
  it("builds a folder-cased path query", () => {
    expect(funnelQuery("CRM", "new")).toBe('path:"CRM/New"');
    expect(funnelQuery("Clients", "Waiting on client")).toBe('path:"Clients/Waiting on client"');
  });
});

describe("buildGraphColorGroups", () => {
  it("adds one group per funnel with palette colors", () => {
    const groups = buildGraphColorGroups("CRM", STATUSES, []);
    expect(groups.map((g) => g.query)).toEqual([
      'path:"CRM/New"',
      'path:"CRM/Pending"',
      'path:"CRM/Done"',
    ]);
    expect(groups[0].color).toEqual({ a: 1, rgb: FUNNEL_COLOR_HEX[0] });
    expect(groups[2].color).toEqual({ a: 1, rgb: FUNNEL_COLOR_HEX[2] });
  });

  it("preserves the user's existing groups untouched", () => {
    const mine: GraphColorGroup[] = [
      { query: "tag:#project", color: { a: 1, rgb: 0x111111 } },
    ];
    const groups = buildGraphColorGroups("CRM", STATUSES, mine);
    expect(groups[0]).toEqual(mine[0]);
    expect(groups).toHaveLength(4);
  });

  it("is idempotent when fed its own output", () => {
    const once = buildGraphColorGroups("CRM", STATUSES, []);
    const twice = buildGraphColorGroups("CRM", STATUSES, once);
    expect(twice).toEqual(once);
  });

  it("cycles the palette beyond its length", () => {
    const many: Funnel[] = Array.from({ length: FUNNEL_COLOR_HEX.length + 1 }, (_, i) => ({
      name: `s${i}`,
      code: `!s${i}`,
    }));
    const groups = buildGraphColorGroups("CRM", many, []);
    expect(groups).toHaveLength(many.length);
    expect(groups[FUNNEL_COLOR_HEX.length].color.rgb).toBe(groups[0].color.rgb);
  });

  it("honors a custom CRM folder", () => {
    const groups = buildGraphColorGroups("Inbox/Leads", STATUSES, []);
    expect(groups[0].query).toBe('path:"Inbox/Leads/New"');
  });
});

describe("buildGraphFilter", () => {
  it("adds both terms to an empty filter", () => {
    expect(buildGraphFilter("")).toBe(GRAPH_FILTER_TERMS.join(" "));
  });

  it("keeps a filter the user wrote and appends the terms", () => {
    const out = buildGraphFilter("tag:#project");
    expect(out.startsWith("tag:#project ")).toBe(true);
    for (const term of GRAPH_FILTER_TERMS) expect(out).toContain(term);
  });

  it("returns the filter unchanged when both terms are present", () => {
    const already = `tag:#project ${GRAPH_FILTER_TERMS.join(" ")}`;
    expect(buildGraphFilter(already)).toBe(already);
  });

  it("adds only the missing term", () => {
    const out = buildGraphFilter(GRAPH_FILTER_TERMS[0]);
    expect(out).toBe(GRAPH_FILTER_TERMS.join(" "));
  });

  it("upgrades the unanchored terms written by earlier versions", () => {
    // The old terms matched any path containing the text, so a contact called
    // @art_history vanished from the graph entirely.
    const out = buildGraphFilter("-path:_history -path:_meta");
    expect(out).toBe(GRAPH_FILTER_TERMS.join(" "));
    expect(out).not.toContain("-path:_history ");
  });

  it("upgrades legacy terms in place, keeping the user's own filter", () => {
    const out = buildGraphFilter("tag:#project -path:_history");
    expect(out.startsWith("tag:#project ")).toBe(true);
    expect(out).toBe(`tag:#project ${GRAPH_FILTER_TERMS.join(" ")}`);
  });

  it("anchors the terms so an underscored username still shows in the graph", () => {
    const filter = buildGraphFilter("");
    // Paths the plugin actually wants hidden.
    expect(filter).toContain('-path:"/_history/"');
    expect(filter).toContain('-path:"/_meta/"');
    // A real contact path that must NOT be matched by either term.
    const contactPath = "CRM/New/@art_history/@art_history.md";
    for (const term of GRAPH_FILTER_TERMS) {
      const needle = term.replace('-path:"', "").replace('"', "");
      expect(contactPath.includes(needle)).toBe(false);
    }
  });
});
