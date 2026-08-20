import {
  App,
  ButtonComponent,
  Notice,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  SettingDefinitionList,
  SettingGroupItem,
} from "obsidian";
import type IgCrmPlugin from "./main";
import { IgCrmClient } from "./api";
import { cleanPath } from "./vault";
import {
  DEFAULT_SETTINGS,
  Funnel,
  MAX_STATUSES_PER_FUNNEL,
  MAX_STATUS_LENGTH,
  MAX_TRIGGER_CODE_LENGTH,
  validateFunnelName,
} from "./types";

// Short on purpose. The plugin page carries the detail: what a trigger code
// matches, the naming rules, how statuses are remembered. Repeating it here just
// buried the controls.
const STAGE_HELP =
  "Each stage is a folder. One stage must leave its trigger code empty; that's where new " +
  "conversations land. A status is an optional label within a stage.";

/**
 * The settings tab, defined once and rendered two ways.
 *
 * `getSettingDefinitions()` is the source of truth. On Obsidian 1.13 and newer
 * the app renders from it directly and indexes it for settings search, which
 * is what 0.1.6 lost by deleting the method. `display()` below walks the same
 * array with the imperative API for anyone on an older build, so the two can
 * never describe different tabs.
 */
export class IgCrmSettingTab extends PluginSettingTab {
  plugin: IgCrmPlugin;

  /**
   * The stage list being edited, held apart from the saved settings.
   *
   * Editing `settings.funnels` directly looked like it worked, because nothing
   * in this list persists on its own. But every other control here calls
   * `saveSettings()`, which writes the whole settings object: adding a stage
   * and then changing the poll interval persisted a nameless stage that none
   * of the checks in `saveFunnels` had seen. A draft is what makes "takes
   * effect when you save" true rather than nearly true.
   */
  private draft: Funnel[] | null = null;

  constructor(app: App, plugin: IgCrmPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * The list to render: the user's edits if they have made any, otherwise
   * whatever is saved right now.
   *
   * Reading must NOT create the draft. Obsidian calls `getSettingDefinitions()`
   * once from `addSettingTab()`, for the settings search index, and this plugin
   * calls `addSettingTab` in `onload`. A seeding getter therefore froze the rows
   * at load time, before `pullTagConfig` had fetched the server's stage list, and
   * `hide()` had never run to clear it. Opening settings for the first time that
   * session showed the load-time list, and "Save stages" pushed it back — quietly
   * reverting a stage renamed on another device, which then cost a folder rename
   * per affected contact on the next reconcile.
   */
  private get funnels(): Funnel[] {
    return this.draft ?? this.plugin.settings.funnels;
  }

  /** The working copy, created on the first edit rather than the first read. */
  private get editableFunnels(): Funnel[] {
    if (this.draft === null) {
      this.draft = this.plugin.settings.funnels.map((f) => ({
        ...f,
        statuses: [...(f.statuses ?? [])],
      }));
    }
    return this.draft;
  }

  /** Settings closed, or the list saved: the next open starts from disk. */
  hide(): void {
    this.draft = null;
    super.hide?.();
  }

  /**
   * The saved stage list changed underneath us: a server pull, another device, or
   * a status promoted during a sync. Re-render so the rows show it.
   *
   * A draft in progress wins and is left alone. Overwriting what someone is
   * typing would be worse than showing them a stale row, and once they have
   * edited, saving their version is what they asked for.
   */
  syncFromSettings(): void {
    if (this.draft !== null) return;
    this.refresh();
  }

  // --- the definitions -----------------------------------------------------

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Layout migration required",
        desc:
          "Syncing is paused until your inbox folder moves to the new layout. Files are " +
          "renamed, never deleted.",
        // Evaluated on every render, so the row disappears once the migration
        // runs without the tab needing to know it happened.
        visible: () => this.plugin.migrationPending,
        action: () => {
          void (async () => {
            await this.plugin.runV02Migration();
            this.refresh();
          })();
        },
      },
      {
        name: "Server URL",
        desc: "Your Instagram DM Inbox server (shown on the connect page).",
        control: { type: "text", key: "serverUrl", placeholder: "https://..." },
      },
      {
        name: "API key",
        desc: "Issued after you connect your Instagram account on the web app.",
        // A render hatch, not a control: the SettingControl union has no
        // password type, and this field must not render in clear text.
        render: (setting: Setting) => {
          setting.addText((t) => {
            t.inputEl.type = "password";
            t.setValue(this.plugin.settings.apiKey).onChange((v) => {
              void this.setControlValue("apiKey", v);
            });
          });
        },
      },
      {
        name: "Inbox folder",
        desc: "Vault-relative folder for profiles, messages, and canvas.",
        control: { type: "text", key: "crmFolder", placeholder: "Instagram DMs" },
      },
      {
        name: "Canvas filename",
        desc: "Roster canvas, relative to the inbox folder.",
        control: { type: "text", key: "canvasFile", placeholder: "_meta/Inbox.canvas" },
      },
      {
        name: "Poll interval (seconds)",
        desc: "How often to fetch new messages.",
        control: {
          type: "number",
          key: "pollIntervalSeconds",
          min: 1,
          validate: (v: number) => (v >= 1 ? undefined : "Must be at least 1 second."),
        },
      },
      {
        name: "Debug logging",
        desc: "Extra detail in the developer console. Off unless you're chasing a problem.",
        control: { type: "toggle", key: "debugLogging" },
      },
      {
        name: "Test connection",
        desc: "Verify the server URL and API key.",
        action: () => void this.testConnection(),
      },
      {
        name: "Set up graph view",
        desc:
          "Colours the graph by stage and hides message notes. Close the graph first, or " +
          "it overwrites this when it closes.",
        action: () => void this.plugin.setupGraphView(),
      },
      {
        // Its own row rather than something the fallback renderer draws, which
        // is what it used to be: 1.13+ never calls display(), so most users saw
        // the stage editor with nothing explaining trigger codes or statuses.
        name: "About stages and statuses",
        desc: STAGE_HELP,
      },
      this.funnelList(),
      {
        name: "Save stages",
        desc:
          "Checks the list and sends it to the server. Stage edits only take effect once " +
          "you save.",
        action: () => void this.saveFunnels(),
      },
    ];
  }

  /** The stages, as a reorderable list. */
  private funnelList(): SettingDefinitionList {
    return {
      type: "list",
      heading: "Funnel stages",
      emptyState: "No stages yet. Add one to start filing conversations.",
      items: this.funnels.map((row, index) => this.funnelRow(row, index)),
      onDelete: (index: number) => {
        this.editableFunnels.splice(index, 1);
        this.refresh();
      },
      onReorder: (from: number, to: number) => {
        // Not saved here. Adding, deleting and reordering are all edits to the
        // same list, and "Save stages" is what checks it as a whole: unique
        // names, exactly one default. Persisting a reorder on its own skipped
        // those checks and made this one row behave unlike its neighbours.
        const list = this.editableFunnels;
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        this.refresh();
      },
      addItem: {
        name: "Add stage",
        action: () => {
          // Empty, not "!". A code starting with "!" matches the END of a reply,
          // so a bare "!" catches "Thanks!" and everything else ending that way.
          // Pre-filling it made the broad behaviour what you got by not choosing.
          // Empty instead trips the "exactly one blank code" rule on save, which
          // asks for a decision rather than making one.
          //
          // A bare "!" is still allowed, and useful: ties resolve to the longest
          // code, so it sits under the specific codes as a catch-all. Do not turn
          // this into a validation error.
          this.editableFunnels.push({ name: "", code: "" });
          this.refresh();
        },
      },
    };
  }

  private funnelRow(row: Funnel, index: number): SettingGroupItem {
    return {
      name: `#${index + 1}`,
      // Searchable by the stage's own name, so typing "pending" in settings
      // search finds the row rather than just the heading.
      aliases: [row.name].filter(Boolean),
      render: (setting: Setting) => {
        // A note, not a refusal. This configuration works and is sometimes what
        // someone wants, but it is broad enough to be worth saying out loud.
        if (row.code && /^!+$/.test(row.code.trim())) {
          setting.setDesc(`"${row.code.trim()}" matches every reply that ends in "!"`);
        }
        setting.addText((t) =>
          t
            .setPlaceholder("stage name (e.g. done)")
            .setValue(row.name)
            .onChange((v) => {
              this.editableFunnels[index].name = v.trim();
            }),
        );
        setting.addText((t) =>
          t
            .setPlaceholder("!code or exact phrase (blank = default)")
            .setValue(row.code ?? "")
            .onChange((v) => {
              const trimmed = v.trim();
              this.editableFunnels[index].code = trimmed ? trimmed : null;
            }),
        );
        setting.addText((t) =>
          t
            .setPlaceholder("statuses, comma separated (optional)")
            .setValue((row.statuses ?? []).join(", "))
            .onChange((v) => {
              this.editableFunnels[index].statuses = parseStatusList(v);
            }),
        );
      },
    };
  }

  // --- storage -------------------------------------------------------------
  //
  // Both accessors are overridden. PluginSettingTab's own versions write
  // straight to plugin data and never call saveSettings(), so the poll timer
  // is never re-registered and polling is never resumed: the change looks
  // saved and does nothing.

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      case "serverUrl":
        s.serverUrl = String(value).trim();
        break;
      case "apiKey":
        s.apiKey = String(value).trim();
        break;
      // Both of these fall back to the CURRENT value, not the shipped default.
      //
      // This runs per keystroke and persists immediately, so falling back to the
      // default meant select-all-delete instantly repointed the inbox at
      // "Instagram DMs" — and Escape does not undo a write that already happened.
      // On a vault using any other folder that orphans the whole existing tree:
      // findConversation stops seeing it, new DMs build a parallel one, and the
      // server's copy is gone as soon as they are acked. Falling back to the
      // current value makes an empty field a no-op instead.
      case "crmFolder":
        // Cleaned on the way in: a trailing slash left in place makes every
        // `startsWith(crmFolder + "/")` check miss, which silently removes
        // both commands and both context-menu items.
        s.crmFolder = cleanPath(value, s.crmFolder);
        break;
      case "canvasFile":
        s.canvasFile = cleanPath(value, s.canvasFile);
        break;
      case "pollIntervalSeconds": {
        const n = Math.floor(Number(value));
        s.pollIntervalSeconds = Number.isFinite(n) && n >= 1 ? n : 5;
        break;
      }
      case "debugLogging":
        s.debugLogging = Boolean(value);
        break;
      default:
        // Every control this tab defines is handled above. Writing an unknown
        // key straight into settings would let a typo in a definition persist
        // a field nothing reads, and it needed a cast to compile at all.
        return;
    }
    await this.plugin.saveSettings();
    // A new key is worth retrying immediately rather than after the backoff.
    if (key === "apiKey") this.plugin.resumePolling();
  }

  /**
   * Redraw after the definitions change.
   *
   * `update()` is `@since 1.13.0`. On anything older it is simply not there,
   * so calling it throws, and it would throw on exactly the installs the
   * `display()` fallback below exists to serve, taking out every button in the
   * tab. On 1.13+ `update()` is the one that refreshes the search index, so it
   * has to be preferred where it exists.
   */
  private refresh(): void {
    const maybe = (this as unknown as { update?: () => void }).update;
    if (typeof maybe === "function") maybe.call(this);
    else this.display();
  }

  // --- the pre-1.13 renderer ----------------------------------------------

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const item of this.getSettingDefinitions()) this.renderItem(containerEl, item);
  }

  /** Walk one definition with the imperative API. Kept deliberately small: it
   *  only has to handle the shapes this tab actually uses. */
  private renderItem(root: HTMLElement, item: SettingDefinitionItem): void {
    const any = item as unknown as Record<string, unknown>;

    if (any.type === "list" || any.type === "group") {
      const group = item as SettingDefinitionList;
      if (group.visible !== undefined && !resolve(group.visible)) return;
      if (group.heading) new Setting(root).setName(group.heading).setHeading();
      const items = group.items ?? [];
      if (items.length === 0 && group.emptyState) {
        root.createEl("p", { cls: "igcrm-help", text: String(group.emptyState) });
      }
      items.forEach((child, i) => {
        this.renderItem(root, child);
        // The declarative renderer supplies delete affordances itself; this
        // fallback has to draw its own.
        if (group.onDelete) {
          new Setting(root).addButton((b: ButtonComponent) =>
            b
              .setIcon("trash")
              .setTooltip("Remove stage")
              .onClick(() => group.onDelete!(i)),
          );
        }
      });
      if (group.addItem) {
        new Setting(root).addButton((b) =>
          b.setButtonText(group.addItem!.name).onClick(() => group.addItem!.action(root)),
        );
      }
      return;
    }

    if (any.visible !== undefined && !resolve(any.visible)) return;

    const setting = new Setting(root);
    if (typeof any.name === "string") setting.setName(any.name);
    if (typeof any.desc === "string") setting.setDesc(any.desc);

    if (typeof any.render === "function") {
      (any.render as (s: Setting) => void)(setting);
    } else if (typeof any.action === "function") {
      setting.addButton((b: ButtonComponent) =>
        b
          .setButtonText(String(any.name ?? "Run"))
          .onClick(() => (any.action as (el: HTMLElement, i: number) => void)(root, 0)),
      );
    } else if (any.control) {
      this.renderControl(setting, any.control as Record<string, unknown>);
    }
  }

  private renderControl(setting: Setting, control: Record<string, unknown>): void {
    const key = String(control.key);
    const current = this.getControlValue(key);
    if (control.type === "toggle") {
      setting.addToggle((t) =>
        t.setValue(Boolean(current)).onChange((v: boolean) => void this.setControlValue(key, v)),
      );
      return;
    }
    setting.addText((t) => {
      if (typeof control.placeholder === "string") t.setPlaceholder(control.placeholder);
      t.setValue(current === undefined || current === null ? "" : String(current)).onChange(
        (v: string) => void this.setControlValue(key, v),
      );
    });
  }

  // --- actions -------------------------------------------------------------

  private async testConnection(): Promise<void> {
    const client = new IgCrmClient(this.plugin.settings.serverUrl, this.plugin.settings.apiKey);
    try {
      await client.getMessages(1);
      new Notice("Connection ok");
    } catch (e) {
      new Notice(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Validate the whole list and push it.
   *
   * Kept as one explicit action rather than saving per keystroke: the rules
   * that matter here are about the list as a whole (unique names, exactly one
   * landing stage), which no per-field `validate` can express.
   */
  private async saveFunnels(): Promise<void> {
    const funnels: Funnel[] = this.funnels
      .map((s) => ({
        name: (s.name || "").trim(),
        code: (s.code ?? "").trim() || null,
        // Carried through, not dropped. Rebuilding the row from name and code
        // alone used to wipe the status lists on the local-only save path.
        statuses: [...(s.statuses ?? [])],
      }))
      .filter((s) => s.name.length > 0);

    if (funnels.length === 0) {
      new Notice("At least one stage is required.");
      return;
    }
    const names = funnels.map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      new Notice("Stage names must be unique.");
      return;
    }
    // Named rather than counted, because the new-stage row now starts with an
    // empty code, so "two blanks" is the likely mistake and "which two?" is the
    // first thing you want to know.
    const landing = funnels.filter((s) => s.code === null);
    if (landing.length !== 1) {
      new Notice(
        landing.length === 0
          ? "One stage needs an empty trigger code. That's where new conversations land."
          : `Only one stage can have an empty trigger code. Give a code to all but one of: ${landing
              .map((s) => s.name)
              .join(", ")}.`,
      );
      return;
    }
    for (const s of funnels) {
      const problem = validateFunnelName(s.name);
      if (problem) {
        new Notice(problem);
        return;
      }
      if (s.code !== null && s.code.length > MAX_TRIGGER_CODE_LENGTH) {
        new Notice(
          `Trigger code for "${s.name}" is too long (max ${MAX_TRIGGER_CODE_LENGTH} characters).`,
        );
        return;
      }
      const tooLong = (s.statuses ?? []).find((v) => v.length > MAX_STATUS_LENGTH);
      if (tooLong) {
        new Notice(`Status "${tooLong.slice(0, 24)}..." is longer than ${MAX_STATUS_LENGTH}.`);
        return;
      }
    }

    if (!this.plugin.settings.apiKey || !this.plugin.settings.serverUrl) {
      this.plugin.settings.funnels = funnels;
      this.draft = null; // saved, so the rows now come from the stored list
      await this.plugin.saveSettings();
      this.refresh();
      new Notice("Saved locally (configure server URL + API key to sync).");
      return;
    }

    try {
      const client = new IgCrmClient(
        this.plugin.settings.serverUrl,
        this.plugin.settings.apiKey,
      );
      // The server's answer wins: it normalises names and may reject a stage,
      // so the rows have to come from what it actually stored.
      this.plugin.settings.funnels = await client.putTagConfig(funnels);
      this.draft = null;
      await this.plugin.saveSettings();
      this.refresh();
      new Notice("Stages saved.");
    } catch (e) {
      new Notice(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Split a comma-separated status list, trimming and deduping the way the
 *  server does so the settings tab and the picker agree. */
export function parseStatusList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
    if (out.length >= MAX_STATUSES_PER_FUNNEL) break;
  }
  return out;
}

function resolve(v: unknown): boolean {
  return typeof v === "function" ? Boolean((v as () => boolean)()) : Boolean(v);
}
