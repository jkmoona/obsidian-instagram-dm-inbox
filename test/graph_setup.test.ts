/**
 * Coverage for the "Set up graph view" command, which had none.
 *
 * It writes `.obsidian/graph.json`, a file the core graph plugin also owns, so
 * the interesting cases are all about not fighting that owner.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { App, TFile, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { DEFAULT_SETTINGS, PluginSettings } from "../src/types";
import { newPlugin } from "./harness";

const GRAPH = ".obsidian/graph.json";

function makePlugin(app: App, overrides: Partial<PluginSettings> = {}) {
  const plugin = newPlugin(app, overrides);
  return {
    plugin,
    run: () =>
      (
        plugin as unknown as Record<string, () => Promise<void>>
      ).setupGraphView.call(plugin),
  };
}

const notices = (): string[] => ((globalThis as never as Record<string, string[]>).__notices ?? []);

beforeEach(() => {
  (globalThis as never as Record<string, unknown>).__notices = [];
  __setRequestUrl(() => ({ status: 200, json: [] }));
});

describe("setupGraphView", () => {
  it("refuses to write while a graph leaf is open", async () => {
    // An open graph writes its whole state back on close, so anything written
    // underneath it is discarded without a trace.
    const app = new App();
    app.vault.folders.add("CRM");
    const before = JSON.stringify({ colorGroups: [{ query: "mine", color: 1 }] }, null, 2);
    app.vault.files.set(GRAPH, before);
    app.workspace.__leaves.set("graph", [{}]);

    const { run } = makePlugin(app);
    await run();

    expect(app.vault.files.get(GRAPH)).toBe(before);
    expect(notices().some((n) => n.toLowerCase().includes("graph view"))).toBe(true);
  });

  it("adds one colour group per funnel and keeps the user's own", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.files.set(
      GRAPH,
      JSON.stringify({ colorGroups: [{ query: "tag:#mine", color: { a: 1, rgb: 1 } }] }, null, 2),
    );

    const { run } = makePlugin(app);
    await run();

    const cfg = JSON.parse(app.vault.files.get(GRAPH)!);
    expect(cfg.colorGroups[0].query).toBe("tag:#mine");
    expect(cfg.colorGroups).toHaveLength(1 + DEFAULT_SETTINGS.funnels.length);
    expect(typeof cfg.search).toBe("string");
  });

  it("backs the previous graph.json up exactly once", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    const original = JSON.stringify({ colorGroups: [{ query: "tag:#mine", color: 1 }] }, null, 2);
    app.vault.files.set(GRAPH, original);

    const { run } = makePlugin(app);
    await run();

    const bak = "CRM/_meta/graph.json.pre-igcrm.bak";
    expect(app.vault.getAbstractFileByPath(bak)).toBeInstanceOf(TFile);

    // A second run must not overwrite the backup with the plugin's own output.
    await run();

    // Parsed, not substring-matched: the file is JSON, so a quote in a query
    // is escaped on the way in and a `not.toContain` on the raw text passes
    // whether or not the backup was clobbered.
    const saved = JSON.parse(app.vault.files.get(bak)!) as {
      colorGroups: { query: string }[];
    };
    expect(saved.colorGroups.map((g) => g.query)).toEqual(["tag:#mine"]);
  });

  it("leaves an unparseable graph.json untouched", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.files.set(GRAPH, "{ not json at all");

    const { run } = makePlugin(app);
    await run();

    expect(app.vault.files.get(GRAPH)).toBe("{ not json at all");
  });

  it("is a no-op on a second run", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.files.set(GRAPH, "{}");

    const { run } = makePlugin(app);
    await run();
    const afterFirst = app.vault.files.get(GRAPH)!;

    (globalThis as never as Record<string, unknown>).__notices = [];
    await run();

    expect(app.vault.files.get(GRAPH)).toBe(afterFirst);
    expect(notices().some((n) => n.includes("already set up"))).toBe(true);
  });
});
