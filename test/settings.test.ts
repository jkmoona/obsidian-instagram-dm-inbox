/**
 * The settings tab has broken twice, in opposite directions.
 *
 * 0.1.4 added getSettingDefinitions() and Obsidian silently stopped calling
 * display(), so users on 1.13+ lost the stage editor and the Test connection
 * button and got their API key rendered in clear text. 0.1.6 fixed that by
 * deleting the method, which cost settings-search indexing and drew a review
 * warning. Both paths now exist, and both are asserted here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, __renderedRows, __resetRenderedRows, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { IgCrmSettingTab, parseStatusList } from "../src/settings";
import { DEFAULT_FUNNELS, DEFAULT_SETTINGS, PluginSettings } from "../src/types";
import { newPlugin } from "./harness";

function makeTab(overrides: Partial<PluginSettings> = {}) {
  const app = new App();
  const plugin = newPlugin(app, overrides);
  const tab = new IgCrmSettingTab(app, plugin);
  // Both belong to Obsidian and need a real DOM; the definitions are what
  // these tests are about.
  (tab as unknown as Record<string, unknown>).update = () => undefined;
  (tab as unknown as Record<string, unknown>).display = () => undefined;
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

describe("both rendering paths exist", () => {
  const source = readFileSync(join(__dirname, "..", "src", "settings.ts"), "utf8");

  it("defines getSettingDefinitions and display", () => {
    expect(source).toContain("getSettingDefinitions()");
    expect(source).toContain("display(): void");
  });

  it("returns a non-empty array, or Obsidian falls back to display()", () => {
    const { tab } = makeTab();
    expect(defs(tab).length).toBeGreaterThan(5);
  });
});

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

    await tab.setControlValue("crmFolder", "   ");
    expect(plugin.settings.crmFolder).toBe(DEFAULT_SETTINGS.crmFolder);

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
    // as a folder setting.
    await tab.setControlValue("crmFolder", "/");
    expect(plugin.settings.crmFolder).toBe(DEFAULT_SETTINGS.crmFolder);

    await tab.setControlValue("canvasFile", "_meta/Inbox.canvas/");
    expect(plugin.settings.canvasFile).toBe("_meta/Inbox.canvas");
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

describe("redrawing on older Obsidian", () => {
  it("falls back to display() when update() does not exist", () => {
    // update() is @since 1.13.0. On an older build it is simply absent, and
    // calling it threw, inside the very fallback renderer those installs use,
    // so every button in the tab was dead.
    const { tab } = makeTab();
    const anyTab = tab as unknown as Record<string, unknown>;
    delete anyTab.update;
    let displayed = 0;
    anyTab.display = () => {
      displayed += 1;
    };

    (anyTab.refresh as () => void).call(tab);

    expect(displayed).toBe(1);
  });

  it("prefers update() where it exists, since that is what indexes search", () => {
    const { tab } = makeTab();
    const anyTab = tab as unknown as Record<string, unknown>;
    let updated = 0;
    let displayed = 0;
    anyTab.update = () => {
      updated += 1;
    };
    anyTab.display = () => {
      displayed += 1;
    };

    (anyTab.refresh as () => void).call(tab);

    expect(updated).toBe(1);
    expect(displayed).toBe(0);
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

describe("the stage help reaches both renderers", () => {
  it("is a definition item, not something only the fallback draws", () => {
    // It used to be drawn inside display()'s list branch. Obsidian 1.13+ never
    // calls display(), so the majority of users saw the stage editor with
    // nothing explaining trigger codes or the status list.
    const { tab } = makeTab();
    const help = byName(tab, "About stages and statuses");
    expect(help).toBeDefined();
    expect(String(help!.desc)).toMatch(/trigger|code/i);
    expect(String(help!.desc)).toMatch(/status/i);
  });

  it("is not duplicated by the fallback renderer", () => {
    const source = readFileSync(join(__dirname, "..", "src", "settings.ts"), "utf8");
    const display = source.slice(source.indexOf("display(): void"));
    expect(display).not.toContain("STAGE_HELP");
  });
});

describe("the pre-1.13 renderer", () => {
  // Obsidian below 1.13 never calls getSettingDefinitions, so display() and its
  // two helpers are the whole tab for those users. They had no behavioural test
  // at all: a wrong control key or a dead button would ship with every other
  // test green, because minAppVersion is 1.6.6 and nothing here was exercised.

  const render = (overrides: Partial<PluginSettings> = {}) => {
    const made = makeTab(overrides);
    // The real one, not the no-op the other tests install.
    delete (made.tab as unknown as Record<string, unknown>).display;
    __resetRenderedRows();
    made.tab.display();
    return made;
  };

  const row = (name: string) => __renderedRows.find((r) => r.name === name);

  it("draws every setting the declarative tab declares", () => {
    const { tab } = render();
    const declared = tab
      .getSettingDefinitions()
      .map((d) => (d as unknown as Record<string, string>).name)
      .filter(Boolean);

    for (const name of declared) {
      // The migration row is hidden unless a migration is pending, which is the
      // one legitimate absence.
      if (name === "Layout migration required") continue;
      expect(row(name), `no row rendered for "${name}"`).toBeDefined();
    }
  });

  it("masks the API key", () => {
    // A plain text control here would put the key on screen in clear text.
    const { tab } = render();
    void tab;
    expect(row("API key")!.texts[0].inputEl.type).toBe("password");
  });

  it("routes a typed value through setControlValue, not straight to disk", async () => {
    const { plugin } = render();
    let saved = 0;
    plugin.saveSettings = async () => {
      saved += 1;
    };

    row("Inbox folder")!.texts[0].fire("Leads/");

    await Promise.resolve();
    // Cleaned on the way in, and persisted through saveSettings so the poll
    // timer and the explorer CSS are refreshed with it.
    expect(plugin.settings.crmFolder).toBe("Leads");
    expect(saved).toBe(1);
  });

  it("wires the toggle to its own key", async () => {
    const { plugin } = render();
    plugin.saveSettings = async () => undefined;

    row("Debug logging")!.toggles[0].fire(true);

    await Promise.resolve();
    expect(plugin.settings.debugLogging).toBe(true);
  });

  it("gives each stage a row, and its delete button removes that stage", () => {
    const { plugin, tab } = render();
    const list = tab.getSettingDefinitions().find((d) => (d as { type?: string }).type === "list")!;
    const names = plugin.settings.funnels.map((f) => f.name);

    // One numbered row per stage, in order.
    for (let i = 0; i < names.length; i++) {
      expect(row(`#${i + 1}`), `no row for stage ${i + 1}`).toBeDefined();
    }
    // The delete affordance the declarative renderer supplies itself.
    expect((list as unknown as { onDelete?: unknown }).onDelete).toBeTypeOf("function");
    const trash = __renderedRows.flatMap((r) => r.buttons).filter((b) => b.icon === "trash");
    expect(trash).toHaveLength(names.length);

    // Clicked, not just counted. The button carries an index, and handing it
    // the wrong one deletes somebody else's stage while looking correct.
    trash[1].click();
    expect(rows(tab)).toEqual([names[0], names[2]]);
  });

  it("runs an action when its button is clicked", () => {
    const { plugin } = render();
    let ran = 0;
    plugin.setupGraphView = async () => {
      ran += 1;
    };

    row("Set up graph view")!.buttons[0].click();

    expect(ran).toBe(1);
  });
});
