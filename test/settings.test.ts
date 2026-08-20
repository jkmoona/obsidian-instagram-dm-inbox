/**
 * The settings tab has broken twice, in opposite directions: 0.1.4 added
 * getSettingDefinitions() and Obsidian stopped calling display(), so 1.13+ lost the
 * stage editor; 0.1.6 deleted getSettingDefinitions() and lost settings-search
 * indexing. Since 0.3.0 requires 1.13, the declarative definitions are the only
 * renderer and neither mistake is available.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { App, Setting, __renderedRows, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { IgCrmSettingTab, parseStatusList } from "../src/settings";
import { DEFAULT_FUNNELS, PluginSettings } from "../src/types";
import { newPlugin } from "./harness";

function makeTab(overrides: Partial<PluginSettings> = {}) {
  const app = new App();
  const plugin = newPlugin(app, overrides);
  const tab = new IgCrmSettingTab(app, plugin);
  // Both belong to Obsidian and need a real DOM; the definitions are what
  // these tests are about.
  (tab as unknown as Record<string, unknown>).update = () => undefined;
  return { app, plugin, tab };
}

/** Stage names as the tab is currently rendering them, read off each row's
 *  search alias, which is where the name lives. */
const rows = (tab: IgCrmSettingTab): string[] => {
  const list = defs(tab).find((d) => d.type === "list")!;
  return (list.items as { aliases?: string[] }[]).map((r) => r.aliases?.[0] ?? "");
};

const addStage = (tab: IgCrmSettingTab) =>
  (defs(tab).find((d) => d.type === "list")!.addItem as { action: () => void }).action();

type Def = Record<string, unknown>;
const defs = (tab: IgCrmSettingTab) => tab.getSettingDefinitions() as unknown as Def[];
const byName = (tab: IgCrmSettingTab, name: string) =>
  defs(tab).find((d) => d.name === name) as Def | undefined;

beforeEach(() => __setRequestUrl(() => ({ status: 200, json: [] })));

describe("the definitions cover the whole tab", () => {
  it("has every setting the imperative tab used to render", () => {
    const { tab } = makeTab();
    const names = defs(tab).map((d) => d.name ?? d.heading);
    expect(names).toEqual(
      expect.arrayContaining([
        "Server URL",
        "API key",
        "Inbox folder",
        "Canvas filename",
        "Poll interval (seconds)",
        "Debug logging",
        "Test connection",
        "Funnel stages",
        "Save stages",
      ]),
    );
  });

  it("renders the API key through a render hatch, never a plain text control", () => {
    // A `control` would show the key in clear text: the SettingControl union
    // has no password type.
    const { tab } = makeTab();
    const apiKey = byName(tab, "API key")!;
    expect(typeof apiKey.render).toBe("function");
    expect(apiKey.control).toBeUndefined();
  });

  it("hides the migration row until a migration is actually pending", () => {
    const { plugin, tab } = makeTab();
    const visible = byName(tab, "Layout migration required")!.visible as () => boolean;
    expect(visible()).toBe(false);
    plugin.migrationPending = true;
    expect(visible()).toBe(true);
  });

  it("lists one row per stage, and grows when a stage is added", () => {
    const { plugin, tab } = makeTab();
    expect(rows(tab)).toHaveLength(plugin.settings.funnels.length);

    addStage(tab);

    expect(rows(tab)).toHaveLength(DEFAULT_FUNNELS.length + 1);
  });

  it("starts a new stage with no trigger code", () => {
    // It used to be pre-filled with "!", which matches the end of every reply
    // ending in one, so the broad behaviour was what you got by leaving the
    // field alone. Empty makes the save rules ask for a decision instead.
    const { plugin, tab } = makeTab();

    addStage(tab);

    const added = (tab as unknown as { funnels: { name: string; code: string | null }[] }).funnels
      .at(-1);
    expect(added?.code).toBe("");
  });
});

describe("setControlValue", () => {
  it("goes through saveSettings, which is what 0.1.4 skipped", async () => {
    // Writing straight to plugin data left the poll timer and the paused flag
    // untouched, so a change looked saved and did nothing.
    const { plugin, tab } = makeTab();
    let saved = 0;
    plugin.saveSettings = async () => {
      saved += 1;
    };
    await tab.setControlValue("crmFolder", "Leads");
    expect(plugin.settings.crmFolder).toBe("Leads");
    expect(saved).toBe(1);
  });

  it("normalises the way the old onChange handlers did", async () => {
    const { plugin, tab } = makeTab();
    plugin.saveSettings = async () => undefined;

    await tab.setControlValue("serverUrl", "  https://s.test  ");
    expect(plugin.settings.serverUrl).toBe("https://s.test");

    // A blank value keeps whatever is stored — here the harness's "CRM", not
    // DEFAULT_SETTINGS.crmFolder. See the dedicated test below for why it must
    // not fall back to the shipped default.
    await tab.setControlValue("crmFolder", "   ");
    expect(plugin.settings.crmFolder).toBe("CRM");

    await tab.setControlValue("canvasFile", "");
    expect(plugin.settings.canvasFile).toBe("_meta/Inbox.canvas");

    await tab.setControlValue("pollIntervalSeconds", "0");
    expect(plugin.settings.pollIntervalSeconds).toBe(5);

    await tab.setControlValue("pollIntervalSeconds", "12");
    expect(plugin.settings.pollIntervalSeconds).toBe(12);

    await tab.setControlValue("debugLogging", true);
    expect(plugin.settings.debugLogging).toBe(true);
  });

  it("cleans folder paths, whose stray slashes silently disable the commands", async () => {
    // Every command and menu item guards on `startsWith(crmFolder + "/")`, so
    // a stored "CRM/" makes them all vanish with no error anywhere.
    const { plugin, tab } = makeTab();
    plugin.saveSettings = async () => undefined;

    await tab.setControlValue("crmFolder", "CRM/");
    expect(plugin.settings.crmFolder).toBe("CRM");

    await tab.setControlValue("crmFolder", "Work/CRM/");
    expect(plugin.settings.crmFolder).toBe("Work/CRM");

    await tab.setControlValue("crmFolder", "CRM//sub");
    expect(plugin.settings.crmFolder).toBe("CRM/sub");

    // normalizePath turns the empty string into "/", which must not survive
    // as a folder setting. It keeps the stored value rather than resetting.
    await tab.setControlValue("crmFolder", "/");
    expect(plugin.settings.crmFolder).toBe("CRM/sub");

    await tab.setControlValue("canvasFile", "_meta/Inbox.canvas/");
    expect(plugin.settings.canvasFile).toBe("_meta/Inbox.canvas");
  });

  it("keeps the stored inbox folder when the field is emptied", async () => {
    // This runs on every keystroke and persists straight away, so an empty field
    // is a state the user passes through — select-all then type, or select-all
    // then think again. Falling back to DEFAULT_SETTINGS.crmFolder meant the
    // inbox instantly repointed at "Instagram DMs", and Escape cannot undo a
    // write that already happened. On any vault not using the default name that
    // orphans the whole tree: findConversation stops seeing it, new DMs build a
    // parallel one, and the server's copy is gone once they are acked.
    const { plugin, tab } = makeTab({ crmFolder: "Work/Inbox", canvasFile: "board.canvas" });
    plugin.saveSettings = async () => undefined;

    for (const blank of ["", "   ", "/"]) {
      await tab.setControlValue("crmFolder", blank);
      expect(plugin.settings.crmFolder).toBe("Work/Inbox");
      await tab.setControlValue("canvasFile", blank);
      expect(plugin.settings.canvasFile).toBe("board.canvas");
    }

    // A real value still lands.
    await tab.setControlValue("crmFolder", "Work/Other");
    expect(plugin.settings.crmFolder).toBe("Work/Other");
  });

  it("resumes polling when the API key changes, so a fix takes effect at once", async () => {
    const { plugin, tab } = makeTab();
    plugin.saveSettings = async () => undefined;
    let resumed = 0;
    plugin.resumePolling = () => {
      resumed += 1;
    };
    await tab.setControlValue("apiKey", " k ");
    expect(plugin.settings.apiKey).toBe("k");
    expect(resumed).toBe(1);
  });

  it("reads back what it wrote", async () => {
    const { plugin, tab } = makeTab();
    plugin.saveSettings = async () => undefined;
    await tab.setControlValue("crmFolder", "Leads");
    expect(tab.getControlValue("crmFolder")).toBe("Leads");
  });
});

describe("the stage list is a draft until you save it", () => {
  // Edits land in a working copy, never in settings. "Save stages" is the only
  // thing that commits, and it is what runs the whole-list checks. Editing
  // settings directly meant any OTHER control's save persisted a half-typed
  // stage that none of those checks had seen.

  it("does not freeze the rows when the tab is only rendered, never edited", async () => {
    // Obsidian calls getSettingDefinitions() once from addSettingTab(), for the
    // settings search index, and the plugin calls addSettingTab in onload. A
    // getter that seeded the draft on read therefore froze the list at load time,
    // before pullTagConfig had fetched the server's stages, and hide() had never
    // run to clear it. Opening settings for the first time that session showed the
    // stale rows, and Save Stages pushed them back over the server's config.
    const { plugin, tab } = makeTab();
    plugin.saveSettings = async () => undefined;

    // Rendered, as addSettingTab does. This must not take a snapshot.
    tab.getSettingDefinitions();

    // The server's list arrives afterwards.
    plugin.settings.funnels = [
      { name: "new", code: null },
      { name: "warm", code: "!warm" },
      { name: "won", code: "!won" },
    ];

    expect(rows(tab).length).toBe(3);
    const save = (t: IgCrmSettingTab) =>
      (t as unknown as Record<string, () => Promise<void>>).saveFunnels.call(t);
    await save(tab);
    expect(plugin.settings.funnels.map((f) => f.name)).toEqual(["new", "warm", "won"]);
  });

  it("keeps an in-progress edit when the saved list changes underneath it", () => {
    // The other direction: once the user has started editing, their draft is what
    // they asked for and a server pull must not wipe it mid-sentence.
    const { plugin, tab } = makeTab();
    addStage(tab);
    const before = rows(tab).length;

    plugin.settings.funnels = [{ name: "new", code: null }];
    tab.syncFromSettings();

    expect(rows(tab).length).toBe(before);
  });

  it("deletes by index, in the draft", () => {
    const { plugin, tab } = makeTab();
    (defs(tab).find((d) => d.type === "list")!.onDelete as (i: number) => void)(1);

    expect(rows(tab)).toEqual(["new", "done"]);
    expect(plugin.settings.funnels.map((f) => f.name)).toEqual(["new", "pending", "done"]);
  });

  it("reorders by index, in the draft", () => {
    const { plugin, tab } = makeTab();
    (defs(tab).find((d) => d.type === "list")!.onReorder as (a: number, b: number) => void)(0, 2);

    expect(rows(tab)).toEqual(["pending", "done", "new"]);
    expect(plugin.settings.funnels.map((f) => f.name)).toEqual(["new", "pending", "done"]);
  });

  it("does not let another control persist an unsaved stage", async () => {
    // The bug the draft exists for: add a stage, then change anything else, and
    // a nameless stage reached data.json without passing a single check.
    const { plugin, tab } = makeTab();
    const saved: string[][] = [];
    plugin.saveSettings = async () => {
      saved.push(plugin.settings.funnels.map((f) => f.name));
    };

    addStage(tab);
    await tab.setControlValue("pollIntervalSeconds", "9");

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(["new", "pending", "done"]);
    expect(plugin.settings.funnels.map((f) => f.name)).not.toContain("");
  });

  it("forgets the draft when settings close", () => {
    const { tab } = makeTab();
    addStage(tab);
    expect(rows(tab)).toHaveLength(DEFAULT_FUNNELS.length + 1);

    tab.hide();

    expect(rows(tab)).toHaveLength(DEFAULT_FUNNELS.length);
  });
});

describe("saving stages", () => {
  const save = (tab: IgCrmSettingTab) =>
    (tab as unknown as Record<string, () => Promise<void>>).saveFunnels.call(tab);

  it("keeps the per-stage statuses on the local-only path", async () => {
    // Rebuilding each row from name and code alone dropped them, and with no
    // server configured there is no round trip to put them back.
    const { plugin, tab } = makeTab({
      serverUrl: "",
      apiKey: "",
      funnels: [{ name: "new", code: null, statuses: ["thinking"] }],
    });
    plugin.saveSettings = async () => undefined;

    await save(tab);

    expect(plugin.settings.funnels[0].statuses).toEqual(["thinking"]);
  });

  it("refuses a list with no landing stage", async () => {
    const { plugin, tab } = makeTab({
      funnels: [
        { name: "a", code: "!a" },
        { name: "b", code: "!b" },
      ],
    });
    plugin.saveSettings = async () => undefined;
    const before = JSON.stringify(plugin.settings.funnels);

    await save(tab);

    expect(JSON.stringify(plugin.settings.funnels)).toBe(before);
  });

  it("still accepts a bare ! as a deliberate catch-all", async () => {
    // Broad, and the row now says so, but legal and sometimes wanted: ties go to
    // the longest code, so it collects whatever a specific code did not claim.
    // Asserted because the tempting "fix" for the broad default was to reject
    // this value, which would break anyone relying on it.
    const { plugin, tab } = makeTab({
      serverUrl: "",
      apiKey: "",
      funnels: [
        { name: "new", code: null },
        { name: "touched", code: "!" },
      ],
    });
    plugin.saveSettings = async () => undefined;

    await save(tab);

    expect(plugin.settings.funnels.map((f) => f.code)).toEqual([null, "!"]);
  });

  it("refuses duplicate stage names", async () => {
    const { plugin, tab } = makeTab({
      funnels: [
        { name: "new", code: null },
        { name: "New", code: "!x" },
      ],
    });
    plugin.saveSettings = async () => undefined;
    const before = JSON.stringify(plugin.settings.funnels);

    await save(tab);

    expect(JSON.stringify(plugin.settings.funnels)).toBe(before);
  });
});

describe("parseStatusList", () => {
  it("trims, drops blanks, and dedupes case-insensitively", () => {
    expect(parseStatusList(" thinking , Thinking ,, paid ")).toEqual(["thinking", "paid"]);
  });

  it("returns nothing for an empty field", () => {
    expect(parseStatusList("")).toEqual([]);
    expect(parseStatusList("  ,  ")).toEqual([]);
  });
});


describe("editing the stage list", () => {
  it("does not persist until Save stages runs", async () => {
    // Add, remove and reorder are edits to one list that is validated as a
    // whole. Reorder used to save on its own, skipping those checks.
    const { plugin, tab } = makeTab();
    let saves = 0;
    plugin.saveSettings = async () => {
      saves += 1;
    };
    const list = defs(tab).find((d) => d.type === "list") as Record<string, unknown>;

    (list.onReorder as (a: number, b: number) => void)(0, 1);
    (list.onDelete as (i: number) => void)(0);
    ((list.addItem as Record<string, unknown>).action as () => void)();

    expect(saves).toBe(0);
  });

  it("tags each stage row so styles.css can lay it out", () => {
    // Three inputs go into one Obsidian setting row, whose two columns are both
    // flex: 1 1 auto with no wrapping — so a narrow pane squeezed the "#1" column
    // away. The class is the hook the CSS needs; without it the rule matches
    // nothing and the squeeze comes back silently.
    const { tab } = makeTab();
    const list = defs(tab).find((d) => d.type === "list") as Record<string, unknown>;
    const rowDefs = list.items as { render: (s: Setting) => void }[];
    expect(rowDefs.length).toBeGreaterThan(0);

    for (const def of rowDefs) {
      const setting = new Setting(null);
      def.render(setting);
      const row = __renderedRows.at(-1)!;
      expect(row.classes).toContain("igcrm-stage-row");
      // And the row still builds its three inputs, which is what needs the space.
      expect(row.texts).toHaveLength(3);
    }
  });
});

describe("graph setup from settings", () => {
  it("is offered as an action, not only in the command palette", () => {
    const { plugin, tab } = makeTab();
    const row = byName(tab, "Set up graph view");
    expect(row).toBeDefined();
    let ran = 0;
    plugin.setupGraphView = async () => {
      ran += 1;
    };
    (row!.action as () => void)();
    expect(ran).toBe(1);
  });
});


