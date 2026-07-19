import { describe, expect, it } from "vitest";
import { rewriteCanvasPaths } from "../src/canvas";
import type { Canvas } from "../src/types";

function makeCanvas(): Canvas {
  return {
    nodes: [
      { id: "n1", type: "file", file: "CRM/New/@a/@a.md", x: 0, y: 0, width: 320, height: 100 },
      { id: "n2", type: "file", file: "CRM/New/@a/2026-07-18 - hi.md", x: 0, y: 200, width: 320, height: 160 },
      { id: "n3", type: "file", file: "CRM/New/@b/@b.md", x: 500, y: 0, width: 320, height: 100 },
      { id: "n4", type: "text", x: 0, y: 400, width: 100, height: 50 },
    ],
    edges: [],
  };
}

describe("rewriteCanvasPaths", () => {
  it("moves nodes matching the old prefix to the new prefix", () => {
    const c = makeCanvas();
    const changed = rewriteCanvasPaths(c, "CRM/New/@a", "CRM/Pending/@a");
    expect(changed).toBe(true);
    expect(c.nodes[0].file).toBe("CRM/Pending/@a/@a.md");
    expect(c.nodes[1].file).toBe("CRM/Pending/@a/2026-07-18 - hi.md");
  });

  it("leaves nodes outside the prefix untouched", () => {
    const c = makeCanvas();
    rewriteCanvasPaths(c, "CRM/New/@a", "CRM/Pending/@a");
    expect(c.nodes[2].file).toBe("CRM/New/@b/@b.md");
  });

  it("ignores non-file nodes even if they'd match by path", () => {
    const c = makeCanvas();
    rewriteCanvasPaths(c, "CRM", "OTHER");
    // Text node (type: "text") has no file field and stays the same shape
    expect(c.nodes[3].type).toBe("text");
    expect((c.nodes[3] as any).file).toBeUndefined();
  });

  it("returns false when nothing matches", () => {
    const c = makeCanvas();
    const changed = rewriteCanvasPaths(c, "CRM/NoSuch", "CRM/Other");
    expect(changed).toBe(false);
    // No mutations
    expect(c.nodes[0].file).toBe("CRM/New/@a/@a.md");
  });

  it("normalizes trailing slashes on prefixes", () => {
    const c = makeCanvas();
    const changed = rewriteCanvasPaths(c, "CRM/New/@a/", "CRM/Pending/@a/");
    expect(changed).toBe(true);
    expect(c.nodes[0].file).toBe("CRM/Pending/@a/@a.md");
  });
});
