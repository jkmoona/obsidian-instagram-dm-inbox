import { describe, expect, it } from "vitest";
import { canvasEquals, rewriteCanvasPaths, syncCanvasFromContacts } from "../src/canvas";
import { FUNNEL_COLOR_HEX, colorCssHexForIndex } from "../src/palette";
import type { Canvas, Funnel } from "../src/types";

const STATUSES: Funnel[] = [
  { name: "new", code: null },
  { name: "pending", code: "!pending" },
  { name: "done", code: "!done" },
];

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

describe("syncCanvasFromContacts", () => {
  const profiles = [
    { profilePath: "CRM/New/@bee/@bee.md", username: "bee" },
    { profilePath: "CRM/Done/@ant/@ant.md", username: "ant" },
  ];

  it("produces exactly one file node per contact, sorted by username", () => {
    const out = syncCanvasFromContacts({ nodes: [], edges: [] }, profiles, STATUSES);
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(0);
    expect(out.nodes[0].file).toBe("CRM/Done/@ant/@ant.md"); // ant before bee
    expect(out.nodes[1].file).toBe("CRM/New/@bee/@bee.md");
    expect(out.nodes.every((n) => n.type === "file")).toBe(true);
  });

  it("is deterministic across repeated runs (stable ids for known files)", () => {
    const first = syncCanvasFromContacts({ nodes: [], edges: [] }, profiles, STATUSES);
    const second = syncCanvasFromContacts(first, profiles, STATUSES);
    expect(second).toEqual(first);
    expect(canvasEquals(first, second)).toBe(true);
  });

  it("drops legacy message nodes and their edges, keeps user text cards", () => {
    // The migration, and only the migration, prunes: it is turning a thread
    // canvas into a roster, which is what the consent modal describes.
    const legacy = makeCanvas(); // profile nodes + a message node + a text node
    legacy.edges.push({ id: "e1", fromNode: "n1", toNode: "n2" });
    const out = syncCanvasFromContacts(legacy, [
      { profilePath: "CRM/New/@a/@a.md", username: "a" },
    ], STATUSES, true);
    const files = out.nodes.filter((n) => n.type === "file");
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe("CRM/New/@a/@a.md");
    expect(files[0].id).toBe("n1"); // profile node preserved verbatim
    expect(out.nodes.some((n) => n.type === "text")).toBe(true);
    expect(out.edges).toHaveLength(0);
  });

  it("leaves a card the user pinned there themselves alone", () => {
    // Anything on the canvas that is not a contact card belongs to the user.
    // An ordinary sync used to delete all of it on the next tick.
    const canvas: Canvas = {
      nodes: [
        { id: "n1", type: "file", file: "CRM/New/@bee/@bee.md", x: 0, y: 0, width: 320, height: 100 },
        { id: "mine", type: "file", file: "Projects/brief.md", x: 0, y: 300, width: 320, height: 100, color: "5" },
        { id: "note", type: "text", x: 0, y: 500, width: 100, height: 50 },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "mine" }],
    };

    const out = syncCanvasFromContacts(canvas, [{ profilePath: "CRM/New/@bee/@bee.md", username: "bee" }], STATUSES);

    const mine = out.nodes.find((n) => n.id === "mine");
    expect(mine).toBeDefined();
    expect(mine!.color).toBe("5"); // their colour, not a stage colour
    expect(out.nodes.some((n) => n.id === "note")).toBe(true);
    expect(out.edges).toHaveLength(1); // the edge they drew survives with it
  });

  it("keeps a pinned message note out of the roster's way", () => {
    // A message note pinned to the canvas is not a contact card, so it is not
    // removed for failing to match the contact list.
    const canvas: Canvas = {
      nodes: [
        { id: "m", type: "file", file: "CRM/New/@bee/_history/2026-07-18 - hi.md", x: 0, y: 0, width: 320, height: 100 },
      ],
      edges: [],
    };
    const out = syncCanvasFromContacts(canvas, [], STATUSES);
    expect(out.nodes.some((n) => n.id === "m")).toBe(true);
  });

  it("removes nodes for contacts no longer present", () => {
    const current = syncCanvasFromContacts({ nodes: [], edges: [] }, profiles, STATUSES);
    const out = syncCanvasFromContacts(current, [profiles[0]], STATUSES);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].file).toBe("CRM/New/@bee/@bee.md");
  });

  it("preserves user-modified geometry and places new contacts below", () => {
    const first = syncCanvasFromContacts({ nodes: [], edges: [] }, [profiles[0]], STATUSES);
    const moved: Canvas = {
      nodes: first.nodes.map((n) => ({ ...n, x: 999, y: 777, width: 500, height: 300 })),
      edges: [],
    };
    const out = syncCanvasFromContacts(moved, profiles, STATUSES);
    const bee = out.nodes.find((n) => n.file === "CRM/New/@bee/@bee.md")!;
    expect(bee.x).toBe(999);
    expect(bee.width).toBe(500);
    const ant = out.nodes.find((n) => n.file === "CRM/Done/@ant/@ant.md")!;
    expect(ant.y).toBeGreaterThanOrEqual(777 + 300);
  });

  it("keeps user-drawn edges between surviving nodes", () => {
    const c = syncCanvasFromContacts({ nodes: [], edges: [] }, profiles, STATUSES);
    c.edges.push({ id: "ue", fromNode: c.nodes[0].id, toNode: c.nodes[1].id });
    const out = syncCanvasFromContacts(c, profiles, STATUSES);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].id).toBe("ue");
  });
});

describe("canvas colours follow funnel", () => {
  it("gives contacts in the same funnel the same colour, and different funnels different ones", () => {
    const out = syncCanvasFromContacts(
      { nodes: [], edges: [] },
      [
        { profilePath: "CRM/New/@a/@a.md", username: "a" },
        { profilePath: "CRM/New/@b/@b.md", username: "b" },
        { profilePath: "CRM/Done/@c/@c.md", username: "c" },
      ],
      STATUSES,
    );
    const byUser = Object.fromEntries(out.nodes.map((n) => [n.file, n.color]));
    expect(byUser["CRM/New/@a/@a.md"]).toBe(byUser["CRM/New/@b/@b.md"]);
    expect(byUser["CRM/Done/@c/@c.md"]).not.toBe(byUser["CRM/New/@a/@a.md"]);
    expect(byUser["CRM/New/@a/@a.md"]).toBe(colorCssHexForIndex(0)); // new is first
    expect(byUser["CRM/Done/@c/@c.md"]).toBe(colorCssHexForIndex(2)); // done is third
  });

  it("repaints a moved card while leaving its geometry alone", () => {
    const before = syncCanvasFromContacts(
      { nodes: [], edges: [] },
      [{ profilePath: "CRM/New/@a/@a.md", username: "a" }],
      STATUSES,
    );
    const moved: Canvas = {
      nodes: before.nodes.map((n) => ({
        ...n,
        file: "CRM/Done/@a/@a.md",
        x: 42,
        y: 84,
        width: 500,
        height: 300,
      })),
      edges: [],
    };
    const out = syncCanvasFromContacts(
      moved,
      [{ profilePath: "CRM/Done/@a/@a.md", username: "a" }],
      STATUSES,
    );
    expect(out.nodes[0].color).toBe(colorCssHexForIndex(2));
    expect(out.nodes[0].x).toBe(42);
    expect(out.nodes[0].y).toBe(84);
    expect(out.nodes[0].width).toBe(500);
    expect(out.nodes[0].height).toBe(300);
  });

  it("does not mutate the canvas it was given", () => {
    // The caller diffs its own object against the result to decide whether to
    // write. Recolouring in place would make that diff empty and the repaint
    // would never reach disk, which asserting on the return value can't catch.
    const input = syncCanvasFromContacts(
      { nodes: [], edges: [] },
      [{ profilePath: "CRM/New/@a/@a.md", username: "a" }],
      STATUSES,
    );
    input.nodes[0].color = "1"; // as if written by an older version
    const snapshot = JSON.stringify(input);
    const out = syncCanvasFromContacts(
      input,
      [{ profilePath: "CRM/New/@a/@a.md", username: "a" }],
      STATUSES,
    );
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(canvasEquals(input, out)).toBe(false);
    expect(out.nodes[0].color).toBe(colorCssHexForIndex(0));
  });

  it("colours a funnel this device doesn't know about instead of throwing", () => {
    const out = syncCanvasFromContacts(
      { nodes: [], edges: [] },
      [{ profilePath: "CRM/Archived/@a/@a.md", username: "a" }],
      STATUSES,
    );
    expect(out.nodes[0].color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("renders every palette entry as six hex digits", () => {
    for (let i = 0; i < FUNNEL_COLOR_HEX.length; i++) {
      expect(colorCssHexForIndex(i)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(colorCssHexForIndex(-1)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("loadCanvas on a file it cannot parse", () => {
  it("returns null instead of an empty canvas", async () => {
    // An empty canvas reads as "nothing to keep", and the caller then writes a
    // rebuilt roster over the file, discarding every card the user placed.
    const { App } = await import("./obsidian-stub");
    const { loadCanvas } = await import("../src/canvas");
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.files.set("CRM/Inbox.canvas", "{ this is not json");

    expect(await loadCanvas(app as never, "CRM/Inbox.canvas")).toBeNull();
  });

  it("still returns an empty canvas for a missing or blank file", async () => {
    const { App } = await import("./obsidian-stub");
    const { loadCanvas } = await import("../src/canvas");
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.files.set("CRM/Blank.canvas", "   \n");

    expect(await loadCanvas(app as never, "CRM/Missing.canvas")).toEqual({ nodes: [], edges: [] });
    expect(await loadCanvas(app as never, "CRM/Blank.canvas")).toEqual({ nodes: [], edges: [] });
  });
});
