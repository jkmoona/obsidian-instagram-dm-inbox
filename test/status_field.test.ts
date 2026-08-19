/**
 * The secondary status: a free-text detail within a funnel stage.
 *
 * It shares a frontmatter key name with the pre-0.2.0 spelling of the stage,
 * so most of what matters here is that the two never get confused.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { App, __openedSuggesters, __resetOpenedSuggesters, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { PluginSettings } from "../src/types";
import { newPlugin } from "./harness";
import { readProfileStatus, setProfileStatus } from "../src/vault";

const USER = "peer";
const PROFILE = `CRM/Pending/@${USER}/@${USER}.md`;

function seed(app: App, frontmatter: string) {
  app.vault.folders.add("CRM");
  app.vault.folders.add("CRM/Pending");
  app.vault.folders.add(`CRM/Pending/@${USER}`);
  app.vault.files.set(PROFILE, `---\n${frontmatter}\n---\n\n# @${USER}\n\n## Notes\n\nmine\n`);
}

const makePlugin = (app: App, overrides: Partial<PluginSettings> = {}) =>
  newPlugin(app, { serverUrl: "https://s.test", apiKey: "k", ...overrides });

let puts: string[] = [];
beforeEach(() => {
  puts = [];
  (globalThis as never as Record<string, unknown>).__notices = [];
  __setRequestUrl((p) => {
    const url = String(p.url);
    if (url.includes("/api/tag-config") && String(p.method) === "PUT") {
      puts.push(p.body as string);
      return { status: 200, json: JSON.parse(p.body as string) };
    }
    if (url.includes("/api/tag-config")) return { status: 200, json: { funnels: [] } };
    return { status: 200, json: [] };
  });
});

describe("reading and writing the status", () => {
  it("writes and clears the frontmatter key without disturbing the note", async () => {
    const app = new App();
    seed(app, `igsid: "IG1"\nfunnel: pending`);

    expect(await setProfileStatus(app as never, PROFILE, "waiting on money")).toBe(true);
    expect(app.vault.files.get(PROFILE)).toMatch(/^status: waiting on money$/m);
    expect(app.vault.files.get(PROFILE)).toContain("mine");
    expect(readProfileStatus(app as never, PROFILE)).toBe("waiting on money");

    expect(await setProfileStatus(app as never, PROFILE, "")).toBe(true);
    expect(app.vault.files.get(PROFILE)).not.toMatch(/^status:/m);
    expect(readProfileStatus(app as never, PROFILE)).toBe("");
    expect(app.vault.files.get(PROFILE)).toMatch(/^funnel: pending$/m);
  });

  it("refuses on a pre-0.2.0 note, where status: still means the stage", async () => {
    // Writing here would silently move the conversation instead of tagging it.
    const app = new App();
    seed(app, `igsid: "IG1"\nstatus: pending`);

    expect(await setProfileStatus(app as never, PROFILE, "thinking")).toBe(false);
    expect(app.vault.files.get(PROFILE)).toMatch(/^status: pending$/m);
  });

  it("reports no status on a pre-0.2.0 note rather than the stage name", async () => {
    const app = new App();
    seed(app, `igsid: "IG1"\nstatus: pending`);
    expect(readProfileStatus(app as never, PROFILE)).toBe("");
  });

  it("survives a funnel move, because it is a different key", async () => {
    const app = new App();
    seed(app, `igsid: "IG1"\nfunnel: pending`);
    await setProfileStatus(app as never, PROFILE, "waiting on money");

    const plugin = makePlugin(app);
    const anyPlugin = plugin as unknown as Record<string, unknown>;
    await (anyPlugin.applyFunnelMove as (u: string, f: string, t: string) => Promise<void>).call(
      plugin,
      USER,
      "Pending",
      "done",
    );
    await new Promise((r) => setTimeout(r, 0));

    const moved = `CRM/Done/@${USER}/@${USER}.md`;
    expect(app.vault.files.get(moved)).toMatch(/^funnel: done$/m);
    expect(app.vault.files.get(moved)).toMatch(/^status: waiting on money$/m);
  });
});

describe("auto-promotion", () => {
  it("remembers a freshly typed status and pushes it to the server", async () => {
    const app = new App();
    seed(app, `igsid: "IG1"\nfunnel: pending`);
    const plugin = makePlugin(app);
    const anyPlugin = plugin as unknown as Record<string, unknown>;
    const stage = plugin.settings.funnels.find((f) => f.name === "pending")!;

    await (anyPlugin.promoteStatus as (s: unknown, v: string) => Promise<void>).call(
      plugin,
      stage,
      "waiting on money",
    );

    expect(plugin.settings.funnels.find((f) => f.name === "pending")!.statuses).toContain(
      "waiting on money",
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain("waiting on money");
  });

  it("dedupes case-insensitively, keeping the spelling already stored", async () => {
    const app = new App();
    const plugin = makePlugin(app, {
      funnels: [
        { name: "new", code: null },
        { name: "pending", code: "!pending", statuses: ["waiting on money"] },
      ],
    });
    const anyPlugin = plugin as unknown as Record<string, unknown>;
    const stage = plugin.settings.funnels.find((f) => f.name === "pending")!;

    await (anyPlugin.promoteStatus as (s: unknown, v: string) => Promise<void>).call(
      plugin,
      stage,
      "Waiting On Money",
    );

    expect(stage.statuses).toEqual(["waiting on money"]);
    expect(puts).toHaveLength(0);
  });

  it("keeps the value locally when the push fails", async () => {
    // The frontmatter write has already happened by then, so a failed push
    // must cost a suggestion and never the user's data.
    const app = new App();
    const plugin = makePlugin(app);
    const anyPlugin = plugin as unknown as Record<string, unknown>;
    __setRequestUrl(() => ({ status: 500, json: { detail: "boom" } }));
    const stage = plugin.settings.funnels.find((f) => f.name === "pending")!;

    await (anyPlugin.promoteStatus as (s: unknown, v: string) => Promise<void>).call(
      plugin,
      stage,
      "thinking",
    );

    expect(plugin.settings.funnels.find((f) => f.name === "pending")!.statuses).toContain(
      "thinking",
    );
  });
});

describe("pulling the stage list on load", () => {
  it("adopts the server's list when the local one is untouched defaults", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    __setRequestUrl((p) => {
      if (String(p.url).includes("/api/tag-config")) {
        return {
          status: 200,
          json: { funnels: [{ name: "lead", code: null, statuses: ["cold"] }] },
        };
      }
      return { status: 200, json: [] };
    });

    await (plugin as unknown as Record<string, () => Promise<void>>).pullTagConfig.call(plugin);

    expect(plugin.settings.funnels.map((f) => f.name)).toEqual(["lead"]);
    expect(plugin.settings.funnels[0].statuses).toEqual(["cold"]);
    // Persisted, not just held in memory. Before the test environment had a
    // `window`, saveSettings threw inside pullTagConfig's own catch and this
    // assertion was the difference between a real pass and a silent skip.
    const stored = (await plugin.loadData()) as { funnels?: { name: string }[] } | null;
    expect(stored?.funnels?.map((f) => f.name)).toEqual(["lead"]);
  });

  it("leaves a locally edited list alone", async () => {
    // The settings tab mutates funnels in place as the user types, and several
    // unrelated controls persist it, so local can legitimately lead the server.
    const app = new App();
    const plugin = makePlugin(app, {
      funnels: [{ name: "mine", code: null }],
    });
    __setRequestUrl((p) => {
      if (String(p.url).includes("/api/tag-config")) {
        return { status: 200, json: { funnels: [{ name: "lead", code: null }] } };
      }
      return { status: 200, json: [] };
    });

    await (plugin as unknown as Record<string, () => Promise<void>>).pullTagConfig.call(plugin);

    expect(plugin.settings.funnels.map((f) => f.name)).toEqual(["mine"]);
  });

  it("does nothing without a configured server", async () => {
    const app = new App();
    const plugin = makePlugin(app, { serverUrl: "", apiKey: "" });
    let called = false;
    __setRequestUrl(() => {
      called = true;
      return { status: 200, json: {} };
    });

    await (plugin as unknown as Record<string, () => Promise<void>>).pullTagConfig.call(plugin);

    expect(called).toBe(false);
  });
});

describe("the two concepts stay separate", () => {
  it("a status is not a stage and never creates a folder", async () => {
    const app = new App();
    seed(app, `igsid: "IG1"\nfunnel: pending`);
    const before = new Set(app.vault.folders);

    await setProfileStatus(app as never, PROFILE, "waiting on money");

    expect(new Set(app.vault.folders)).toEqual(before);
    expect([...app.vault.files.keys()].every((p) => !p.includes("waiting"))).toBe(true);
  });

  it("clearing a status leaves the stage untouched", async () => {
    const app = new App();
    seed(app, `igsid: "IG1"\nfunnel: pending`);
    await setProfileStatus(app as never, PROFILE, "thinking");
    await setProfileStatus(app as never, PROFILE, "");
    expect(app.vault.files.get(PROFILE)).toMatch(/^funnel: pending$/m);
    expect(app.vault.files.has(PROFILE)).toBe(true);
  });
});

describe("the pickers themselves", () => {
  // Until now these were covered only by grepping src/main.ts for their class
  // names, which says nothing about what they offer or which stage's list they
  // were handed. Driven through the real prompt path, so the wiring counts too.

  const open = (plugin: IgCrmPlugin, app: App, method: string) =>
    (plugin as unknown as Record<string, (t: unknown) => Promise<void>>)[method].call(
      plugin,
      app.vault.getAbstractFileByPath(PROFILE)!,
    );

  const suggestions = (query = "") => {
    const modal = __openedSuggesters[__openedSuggesters.length - 1];
    expect(modal, "no suggester was opened").toBeDefined();
    return modal.getSuggestions(query) as Record<string, unknown>[];
  };

  beforeEach(() => __resetOpenedSuggesters());

  it("offers every stage except the one it is already in, filtered as you type", async () => {
    // Offering the current stage would be a row that does nothing, since
    // applyManualFunnel returns early when the stage has not changed.
    const app = new App();
    seed(app, `igsid: "IG"\nfunnel: pending`);
    const plugin = makePlugin(app);

    await open(plugin, app, "promptSetFunnelFor");

    expect(suggestions().map((s) => s.name)).toEqual(["new", "done"]);
    expect(suggestions("do").map((s) => s.name)).toEqual(["done"]);
  });

  it("offers the statuses belonging to the stage the conversation is in", async () => {
    // Per-stage, not global. Handing it the wrong stage's list is the mistake
    // the class-name grep could never catch.
    const app = new App();
    seed(app, `igsid: "IG"\nfunnel: pending`);
    const plugin = makePlugin(app, {
      funnels: [
        { name: "new", code: null, statuses: ["should not appear"] },
        { name: "pending", code: "!pending", statuses: ["waiting on money", "thinking"] },
        { name: "done", code: "!done" },
      ],
    });

    await open(plugin, app, "promptSetStatusFor");

    expect(suggestions().map((s) => s.value)).toEqual(["thinking", "waiting on money"]);
  });

  it("accepts free text, and only offers to create something genuinely new", async () => {
    const app = new App();
    seed(app, `igsid: "IG"\nfunnel: pending`);
    const plugin = makePlugin(app, {
      funnels: [{ name: "pending", code: null, statuses: ["thinking"] }],
    });

    await open(plugin, app, "promptSetStatusFor");

    const typed = suggestions("chasing an invoice");
    expect(typed.filter((s) => s.kind === "create").map((s) => s.value)).toEqual([
      "chasing an invoice",
    ]);
    // Typing something already on the list must not offer to add it twice.
    expect(suggestions("thinking").some((s) => s.kind === "create")).toBe(false);
  });

  it("puts the current status first and offers to clear it", async () => {
    const app = new App();
    seed(app, `igsid: "IG"\nfunnel: pending\nstatus: waiting on money`);
    const plugin = makePlugin(app, {
      funnels: [
        { name: "pending", code: null, statuses: ["aaa first alphabetically", "waiting on money"] },
      ],
    });

    await open(plugin, app, "promptSetStatusFor");

    const rows = suggestions();
    expect(rows[0].value).toBe("waiting on money");
    expect(rows[0].current).toBe(true);
    expect(rows.some((s) => s.kind === "clear")).toBe(true);
  });

  it("has no clear row when there is no status to clear", async () => {
    const app = new App();
    seed(app, `igsid: "IG"\nfunnel: pending`);
    const plugin = makePlugin(app, {
      funnels: [{ name: "pending", code: null, statuses: ["thinking"] }],
    });

    await open(plugin, app, "promptSetStatusFor");

    expect(suggestions().some((s) => s.kind === "clear")).toBe(false);
  });
});
