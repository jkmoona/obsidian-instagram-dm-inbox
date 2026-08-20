import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Plugin,
  SuggestModal,
  TAbstractFile,
  TFile,
  TFolder,
  apiVersion,
  normalizePath,
} from "obsidian";
import {
  Contact,
  DEFAULT_FUNNELS,
  DEFAULT_SETTINGS,
  InboxMessage,
  LEGACY_DEFAULT_CANVAS,
  PRE_020_INBOX_FOLDER,
  PluginSettings,
  Funnel,
  MAX_STATUSES_PER_FUNNEL,
  contactFunnel,
  defaultFunnelName,
  funnelFolderName,
} from "./types";
import { ApiError, IgCrmClient } from "./api";
import {
  META_FOLDER,
  RecentEntry,
  cleanPath,
  conversationFolderIn,
  stageFolderSpelling,
  ensureFolder,
  applyContactName,
  ensureProfileNote,
  findConversation,
  migrateLegacyLayout,
  migrateToV02Layout,
  moveConversation,
  needsV02Migration,
  onDiskUsername,
  profileNotePath,
  quarantineMessage,
  readProfileStatus,
  resolveConversation,
  setProfileStatus,
  funnelHubPath,
  syncFunnelHubs,
  updateProfileRecentMessages,
  writeFrontmatter,
  writeMessageNote,
} from "./vault";
import {
  canvasEquals,
  loadCanvas,
  rewriteCanvasPaths,
  saveCanvas,
  syncCanvasFromContacts,
} from "./canvas";
import { applyGraphSettings } from "./graph_colors";
import { IgCrmSettingTab } from "./settings";
import { clearWarn, debugLog, logError, logWarn, setDebugLogging, warnOnce } from "./log";

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_WRITE_ATTEMPTS = 3;
/** `/api/messages` returns at most 50 at a time and a stuck ack keeps
 *  redelivering that same head of the queue, so a couple of hundred is several
 *  times the largest window that can ever be replayed. */
const MAX_REMEMBERED_MIDS = 200;

export default class IgCrmPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  migrationPending = false;
  private migrating = false;
  private settingTab: IgCrmSettingTab | null = null;
  private polling = false;
  private paused = false;
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private pollTimer: number | null = null;
  private writeFailures = new Map<string, number>();
  /** Consecutive ticks whose ack failed, so a stuck server produces one notice
   *  rather than one every poll interval. */
  private ackFailureStreak = 0;
  /** Conversations this plugin is currently moving, keyed by lowercased
   *  username. The value records whether a frontmatter event arrived while the
   *  move was in flight, so a real hand edit made during the window still gets
   *  honoured once the move finishes. */
  private movingConversations = new Map<string, boolean>();
  /** Another device changed data.json while a tick was running. */
  private settingsChangedDuringTick = false;

  async onload() {
    await this.loadSettings();
    // Kept so the tab can be told when the saved stage list changes underneath
    // it. Obsidian renders it once from here for the search index, so without a
    // nudge its rows stay frozen at load time until settings are opened and
    // closed. See IgCrmSettingTab.syncFromSettings.
    this.settingTab = new IgCrmSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addRibbonIcon("refresh-cw", "Sync Instagram DMs", () => {
      void this.syncNow();
    });

    this.addRibbonIcon("layout-grid", "Open Instagram inbox canvas", () => {
      void this.openInboxCanvas();
    });

    this.addCommand({
      id: "open-inbox-canvas",
      name: "Open inbox canvas",
      callback: () => {
        void this.openInboxCanvas();
      },
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow();
      },
    });

    this.addCommand({
      // Id deliberately left at the 0.1.x spelling. Obsidian keys user hotkeys
      // in .obsidian/hotkeys.json by "<plugin-id>:<command-id>", so renaming
      // this would silently unbind whatever anyone had set, with no error and
      // nothing in the UI to explain it. The display name is what users see.
      id: "set-status",
      name: "Move to funnel stage",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isCrmTarget(file)) return false;
        if (checking) return true;
        void this.promptSetFunnelFor(file);
        return true;
      },
    });

    this.addCommand({
      id: "set-conversation-status",
      name: "Set conversation status",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isCrmTarget(file)) return false;
        if (checking) return true;
        void this.promptSetStatusFor(file);
        return true;
      },
    });

    // Right-click menu on any file or folder inside the inbox folder.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!this.isCrmTarget(file)) return;
        menu.addItem((item) =>
          item
            .setTitle("Move to funnel stage")
            .setIcon("tag")
            .onClick(() => void this.promptSetFunnelFor(file)),
        );
        menu.addItem((item) =>
          item
            .setTitle("Set conversation status")
            .setIcon("circle-dot")
            .onClick(() => void this.promptSetStatusFor(file)),
        );
      }),
    );

    // Watch profile-note YAML edits: if `funnel:` diverges from the enclosing
    // folder, treat that as a manual funnel change and sync.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile) void this.onProfileYamlChanged(file);
      }),
    );

    // Dragging a conversation into another funnel folder is a funnel change.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFolder) void this.onConversationFolderMoved(file, oldPath);
      }),
    );

    this.addCommand({
      id: "copy-debug-info",
      name: "Copy debug info",
      callback: async () => {
        await this.copyDebugInfo();
      },
    });

    this.addCommand({
      id: "run-layout-migration",
      name: "Migrate inbox layout",
      // Always offered, not just while migrationPending. The automatic check
      // runs once and then persists migratedToV02, so pre-0.2.0 content that
      // shows up afterwards -- a restored backup, a sync from a device still
      // on 0.1.6 -- would otherwise sit in the old layout with no way to
      // convert it and no visible command to try.
      callback: () => void this.runLayoutMigrationCommand(),
    });

    this.addCommand({
      id: "setup-graph-view",
      name: "Set up graph view",
      callback: async () => {
        await this.setupGraphView();
      },
    });

    // v0.2.0 layout migration: consent-gated. Polling starts HALTED whenever
    // the flag is unset. The check at layout-ready either clears the halt
    // (fresh vault) or opens the consent modal. That ordering is what keeps a
    // tick from writing files or touching the canvas before consent.
    if (!this.settings.migratedToV02 && this.settings.crmFolder) {
      this.migrationPending = true;
      // Wait for the vault index so the folder walk sees real contents.
      this.app.workspace.onLayoutReady(() => void this.checkV02Migration());
    }

    this.restartPollTimer();
    // Pull the server's stage list once at startup. Until now nothing ever
    // called getTagConfig, so a reinstall silently reset the list to the three
    // defaults while the server still held the real one, and a locally-edited
    // list could drift far enough that the server rejects a stage the picker
    // still offers.
    this.app.workspace.onLayoutReady(() => void this.pullTagConfig());
  }

  /**
   * Adopt the server's stage list, but never over local edits.
   *
   * The settings tab mutates `settings.funnels` in place as the user types and
   * several unrelated controls persist it, so the local copy can legitimately
   * be ahead of the server. Overwriting that would throw away work in progress.
   * Adopting only when the local list is still the untouched defaults covers
   * the case this exists for, a fresh install or reinstall, and leaves every
   * other case alone.
   */
  private async pullTagConfig(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.apiKey) return;
    const local = this.settings.funnels;
    const untouched =
      local.length === DEFAULT_FUNNELS.length &&
      local.every(
        (f, i) =>
          f.name === DEFAULT_FUNNELS[i].name &&
          f.code === DEFAULT_FUNNELS[i].code &&
          (f.statuses ?? []).length === 0,
      );
    if (!untouched) return;
    try {
      const remote = await new IgCrmClient(
        this.settings.serverUrl,
        this.settings.apiKey,
      ).getTagConfig();
      if (remote.length === 0) return;
      this.settings.funnels = remote;
      await this.saveSettings();
      this.settingTab?.syncFromSettings();
      clearWarn("pullTagConfig");
      debugLog(`adopted ${remote.length} stage(s) from the server`);
    } catch (e) {
      warnOnce("pullTagConfig", "couldn't read the stage list from the server", e);
    }
  }

  private async checkV02Migration(): Promise<void> {
    try {
      const needs = await needsV02Migration(
        this.app,
        this.settings.crmFolder,
        this.settings.canvasFile === LEGACY_DEFAULT_CANVAS,
      );
      if (!needs) {
        // Nothing to consent to, so resume polling. Only persist the flag if
        // the inbox folder actually exists. On a second device whose sync hasn't
        // delivered the CRM tree yet, persisting here would skip the consent
        // gate for good once the old content finally arrives.
        this.migrationPending = false;
        const crmRoot = this.app.vault.getAbstractFileByPath(this.settings.crmFolder);
        if (crmRoot instanceof TFolder) {
          if (this.settings.canvasFile === LEGACY_DEFAULT_CANVAS) {
            this.settings.canvasFile = DEFAULT_SETTINGS.canvasFile;
          }
          this.settings.migratedLegacyLayout = true;
          this.settings.migratedToV02 = true;
          await this.saveData(this.settings);
        }
        return;
      }
      new MigrationModal(this.app, this.settings.crmFolder, () => this.runV02Migration()).open();
    } catch (e) {
      // Fail closed: migrationPending stays true and polling stays halted.
      // Say so, though. Silence here left the user with a plugin that had
      // simply stopped syncing and a recovery path they could not see.
      logError("v0.2.0 migration check failed", e);
      new Notice(
        "Instagram DM Inbox couldn't check your inbox folder, so syncing is paused. " +
          'Run "Migrate inbox layout" from the command palette, or open plugin settings.',
      );
    }
  }

  /** The manual escape hatch. Invoking the command is itself the consent, so
   *  this bypasses the one-shot flag, but it still checks there is something
   *  to do first rather than rewriting the canvas of a vault already on the
   *  new layout. */
  private async runLayoutMigrationCommand(): Promise<void> {
    if (this.migrating) return;
    try {
      const needs = await needsV02Migration(
        this.app,
        this.settings.crmFolder,
        this.settings.canvasFile === LEGACY_DEFAULT_CANVAS,
      );
      if (!needs) {
        // Clear the halt as well as saying so. The automatic check leaves
        // migrationPending true when it fails to read the folder, and its
        // notice sends the user here; returning without lifting it would leave
        // syncing paused for the rest of the session with no way out. This
        // field is per-session, so clearing it is enough on its own.
        this.migrationPending = false;
        // The persisted flags are a different matter, and only safe once the
        // folder is actually there. On a second device whose sync has not
        // delivered it yet, "nothing to migrate" is a statement about an empty
        // vault, and latching it would skip the consent gate for good when the
        // old content finally arrives.
        if (this.app.vault.getAbstractFileByPath(this.settings.crmFolder) instanceof TFolder) {
          this.settings.migratedLegacyLayout = true;
          this.settings.migratedToV02 = true;
          await this.saveData(this.settings);
        }
        new Notice(
          "Instagram DM Inbox: nothing to migrate, your inbox folder is already on the new layout.",
        );
        return;
      }
    } catch (e) {
      logError("v0.2.0 migration check failed", e);
      new Notice("Instagram DM Inbox: couldn't read your inbox folder. Check the console.");
      return;
    }
    await this.runV02Migration(true);
  }

  async runV02Migration(force = false): Promise<void> {
    if (this.migrating) return;
    if (!force && this.settings.migratedToV02) return;
    this.migrating = true;
    try {
      // The oldest layout first. It leaves message notes flat inside each
      // conversation, which is exactly what the v0.2.0 pass below then files
      // into _history/, so one consented run lands on the final shape.
      await migrateLegacyLayout(
        this.app,
        this.settings.crmFolder,
        defaultFunnelName(this.settings.funnels),
      );
      const result = await migrateToV02Layout(this.app, {
        crmFolder: this.settings.crmFolder,
        canvasFile: this.settings.canvasFile,
        canvasIsLegacyDefault: this.settings.canvasFile === LEGACY_DEFAULT_CANVAS,
      });
      this.settings.canvasFile = result.newCanvasFile;

      // Rebuild the canvas as a contact roster from the migrated profiles.
      const canvasPath = `${this.settings.crmFolder}/${this.settings.canvasFile}`;
      const canvas = await loadCanvas(this.app, canvasPath);
      // The one place that prunes: a pre-0.2.0 canvas had a card per message,
      // and turning it into a roster is what the consent modal promised. The
      // original is already backed up to _meta.
      const rebuilt = syncCanvasFromContacts(canvas, result.profiles, this.settings.funnels, true);
      await saveCanvas(this.app, canvasPath, rebuilt);

      // Both flags, and only now that it worked. The legacy pass used to set
      // its own in a `finally`, so a migration that threw was recorded as done
      // and the half-moved tree could never be repaired.
      this.settings.migratedLegacyLayout = true;
      this.settings.migratedToV02 = true;
      await this.saveData(this.settings);
      this.migrationPending = false;
      new Notice(
        `Instagram DM Inbox: migrated ${result.conversationsMigrated} conversation${result.conversationsMigrated === 1 ? "" : "s"} to the v0.2.0 layout.`,
      );
    } catch (e) {
      logError("v0.2.0 migration failed", e);
      new Notice(
        'Instagram DM Inbox: migration failed. Nothing was deleted, so your vault is intact. Check the console, then run "Migrate inbox layout" from the command palette to try again.',
      );
    } finally {
      this.migrating = false;
    }
  }

  private async openInboxCanvas(): Promise<void> {
    const path = normalizePath(`${this.settings.crmFolder}/${this.settings.canvasFile}`);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice("There's no inbox canvas yet. It gets created on the first sync.");
    }
  }

  private async ensureMetaFolder(): Promise<void> {
    await ensureFolder(this.app, `${this.settings.crmFolder}/${META_FOLDER}`);
  }

  /**
   * Give the graph one colour group per funnel stage and a filter that hides
   * message notes and the canvas, leaving the user's own groups, their own
   * filter text, and every other graph setting alone.
   *
   * Public because the settings tab offers it too: the palette is not a
   * discoverable home for a one-off setup step.
   */
  async setupGraphView(): Promise<void> {
    // An open graph leaf keeps its own copy of these options and writes the
    // whole file back when it closes, silently discarding whatever is put here.
    // Refuse rather than write into that race.
    //
    // Only "graph". A local-graph leaf keeps its settings in workspace.json, so
    // including "localgraph" would refuse for no reason.
    if (this.app.workspace.getLeavesOfType("graph").length > 0) {
      new Notice(
        'Close the graph view first, then run "Set up graph view" again. An open graph ' +
          "overwrites these settings when it closes.",
      );
      return;
    }
    const path = `${this.app.vault.configDir}/graph.json`;
    try {
      let config: Record<string, unknown> = {};
      if (await this.app.vault.adapter.exists(path)) {
        const raw = await this.app.vault.adapter.read(path);
        if (raw.trim()) {
          try {
            config = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            new Notice(
              "Couldn't read your graph settings (graph.json isn't valid JSON), so nothing was changed.",
            );
            return;
          }
        }
      }

      const update = applyGraphSettings(config, this.settings.crmFolder, this.settings.funnels);
      const { addedGroups, filterChanged } = update;

      if (addedGroups === 0 && !filterChanged) {
        new Notice("Your graph view is already set up.");
        return;
      }

      // One copy of whatever was there before this plugin first touched it.
      // graph.json belongs to the core graph view, not to us, so there has to
      // be a way back that does not depend on this code being correct.
      const bak = `${this.settings.crmFolder}/${META_FOLDER}/graph.json.pre-igcrm.bak`;
      if (this.app.vault.getAbstractFileByPath(bak) === null) {
        try {
          await this.ensureMetaFolder();
          await this.app.vault.create(bak, JSON.stringify(config, null, 2) + "\n");
        } catch (e) {
          logWarn("couldn't back up graph.json", e);
        }
      }

      await this.app.vault.adapter.write(path, JSON.stringify(update.config, null, 2));

      const parts: string[] = [];
      if (addedGroups > 0) {
        parts.push(`added ${addedGroups} color group${addedGroups === 1 ? "" : "s"}`);
      }
      if (filterChanged) parts.push("hid message notes and the canvas");
      new Notice(`Graph view: ${parts.join(" and ")}.`);
    } catch (e) {
      logError("graph view setup failed", e);
      new Notice("Couldn't update your graph settings. Check the console for details.");
    }
  }

  /**
   * Put a diagnostic summary on the clipboard, for pasting into an issue.
   *
   * The server URL and API key are reported as `set` or `empty` and never by
   * value. That is deliberate: the whole point of this command is that it gets
   * pasted somewhere public. The 0.2.0 community review flagged clipboard access
   * as worth a look, and this is the only place the plugin touches it: one
   * user-initiated write, no reads, and nothing here that the plugin did not
   * generate itself.
   */
  private async copyDebugInfo(): Promise<void> {
    const s = this.settings;
    const lines = [
      `plugin: ${this.manifest.id} v${this.manifest.version}`,
      `obsidian api: ${apiVersion}`,
      `serverUrl: ${s.serverUrl ? "set" : "empty"}`,
      `apiKey: ${s.apiKey ? "set" : "empty"}`,
      `crmFolder: ${s.crmFolder}`,
      `canvasFile: ${s.canvasFile}`,
      `pollIntervalSeconds: ${s.pollIntervalSeconds}`,
      `funnels: ${s.funnels.map((x) => x.name + (x.code ? `(${x.code})` : "")).join(", ")}`,
      `migratedToV02: ${s.migratedToV02} (pending: ${this.migrationPending})`,
      `paused: ${this.paused}, consecutiveFailures: ${this.consecutiveFailures}`,
      `pendingWriteFailures: ${this.writeFailures.size}`,
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    new Notice("Debug info copied to clipboard.");
  }

  async syncNow(): Promise<void> {
    this.paused = false;
    await this.tick(true);
  }

  async loadSettings() {
    const raw = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };

    // 0.1.x called the funnel a status. Adopt the old keys when the new ones
    // are absent, silently: this is the plugin's own config, not the user's
    // files, so there is nothing to consent to. Dropped in 0.3.0.
    const legacy = (raw ?? {}) as Record<string, unknown>;
    if (!Array.isArray(raw?.funnels) && Array.isArray(legacy.statuses)) {
      this.settings.funnels = legacy.statuses as PluginSettings["funnels"];
    }
    if (!raw?.contactFunnelCache && legacy.contactStatusCache) {
      this.settings.contactFunnelCache = legacy.contactStatusCache as Record<string, string>;
    }
    if (!raw?.pendingFunnel && legacy.pendingStatus) {
      this.settings.pendingFunnel = legacy.pendingStatus as Record<string, string>;
    }

    // 0.2.0 changed two defaults: the inbox folder and the canvas path. An
    // upgrading data.json that is missing either key has just been handed the
    // NEW default by the spread above, which describes a layout that install
    // does not have. Pin both back to what the old default was, so only a first
    // run (no stored data at all) gets the new values.
    //
    // Every version that ever ran wrote the whole settings object, so in
    // practice both keys are present and neither branch fires. They matter for
    // a data.json that was hand-edited or restored partially, and getting
    // canvasFile wrong is the expensive one: it decides
    // `canvasIsLegacyDefault`, and a false reading there means the user's
    // existing canvas is never backed up or relocated, just quietly replaced.
    if (raw) {
      if (raw.crmFolder === undefined) this.settings.crmFolder = PRE_020_INBOX_FOLDER;
      if (raw.canvasFile === undefined) this.settings.canvasFile = LEGACY_DEFAULT_CANVAS;
    }

    // Ensure new fields exist when upgrading from an older settings shape.
    //
    // Every mutable field is copied, never adopted. The spread above shares
    // DEFAULT_SETTINGS' own objects whenever a key is absent from `raw`, so
    // writing through them would mutate the module-level default and leak into
    // the next plugin instance. One instance per app hides that in production;
    // in tests it leaks state between cases.
    // Always a fresh array of fresh objects. Copying only when the array is
    // missing leaves the common case, a data.json with no `funnels` key,
    // holding DEFAULT_SETTINGS' own array, and the first edit in the settings
    // tab then rewrites the module-level default.
    this.settings.funnels =
      Array.isArray(this.settings.funnels) && this.settings.funnels.length > 0
        ? this.settings.funnels.map((s) => ({ ...s }))
        : DEFAULT_SETTINGS.funnels.map((s) => ({ ...s }));
    this.settings.contactFunnelCache =
      this.settings.contactFunnelCache && typeof this.settings.contactFunnelCache === "object"
        ? { ...this.settings.contactFunnelCache }
        : {};
    this.settings.pendingFunnel =
      this.settings.pendingFunnel && typeof this.settings.pendingFunnel === "object"
        ? { ...this.settings.pendingFunnel }
        : {};
    this.settings.writtenMids = Array.isArray(this.settings.writtenMids)
      ? this.settings.writtenMids.filter((m): m is string => typeof m === "string")
      : [];
    // Repair stored paths once per load. Values saved by older versions never
    // went through the settings tab's cleaning, and a stray trailing slash
    // silently disables every command and menu item.
    this.settings.crmFolder = cleanPath(this.settings.crmFolder, DEFAULT_SETTINGS.crmFolder);
    this.settings.canvasFile = cleanPath(this.settings.canvasFile, DEFAULT_SETTINGS.canvasFile);
    setDebugLogging(this.settings.debugLogging === true);
  }

  /**
   * data.json changed underneath us, which on a synced vault means another
   * device edited the settings.
   *
   * Without this the next tick's `saveData` writes our stale copy straight
   * back over theirs, so a stage renamed on a laptop reappears with its old
   * name a few seconds later. Re-reading costs nothing and the two follow-ups
   * are the settings that have live effects.
   */
  async onExternalSettingsChange(): Promise<void> {
    // Never mid-tick. loadSettings replaces `this.settings` wholesale, and a
    // tick holds state there that is not on disk yet: the mids it has just
    // written, before the pre-ack save. Swapping the object under it discards
    // that ledger, and a redelivery then writes those DMs a second time, which
    // is the one thing the ledger exists to prevent. Deferred to the end of the
    // tick instead, which is a few hundred milliseconds away.
    if (this.polling) {
      this.settingsChangedDuringTick = true;
      return;
    }
    await this.loadSettings();
    this.restartPollTimer();
    // loadSettings replaced the whole object, so the tab's rows are describing a
    // list that no longer exists.
    this.settingTab?.syncFromSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    setDebugLogging(this.settings.debugLogging === true);
    this.restartPollTimer();
  }

  resumePolling() {
    this.paused = false;
  }

  restartPollTimer() {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const seconds = Math.max(1, this.settings.pollIntervalSeconds);
    this.pollTimer = window.setInterval(() => void this.tick(), seconds * 1000);
    this.registerInterval(this.pollTimer);
  }

  private async tick(manual = false) {
    // A migration walks the whole tree moving folders, so a tick running beside
    // it is a second file-moving pass over the same subtree with no mutual
    // exclusion: reconcile can move a conversation that migrateToV02Layout is
    // mid-way through, and the notes left behind end up filed under the stage it
    // just left. `migrationPending` does not cover this. It is false on a vault
    // whose migratedToV02 is already latched, and the "Migrate inbox layout"
    // command stays available on purpose for content restored from a backup or a
    // device still on 0.1.6, so the 5s interval keeps firing through the run.
    if (this.migrating) {
      if (manual) new Notice("Instagram DM Inbox: migration in progress.");
      return;
    }
    if (this.migrationPending) {
      if (manual) {
        new Notice(
          "Instagram DM Inbox: your inbox folder needs migrating to the new layout before syncing. Run it from plugin settings.",
        );
      }
      return;
    }
    if (this.polling) {
      if (manual) new Notice("Sync already in progress");
      return;
    }
    if (this.paused) return;
    if (!this.settings.apiKey || !this.settings.serverUrl) {
      if (manual) new Notice("Instagram DM Inbox: configure server URL and API key in settings first.");
      return;
    }
    if (!manual && this.consecutiveFailures > 0) {
      const backoffMs = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (this.consecutiveFailures - 1));
      const nextAllowed = this.lastFailureAt + backoffMs;
      if (Date.now() < nextAllowed) return;
    }
    this.polling = true;
    try {
      const client = new IgCrmClient(this.settings.serverUrl, this.settings.apiKey);

      // Pull contact list first so we know each sender's current funnel before writing new messages.
      let contacts: Contact[] = [];
      let contactsFetched = false;
      try {
        contacts = await client.getContacts();
        contactsFetched = true;
        clearWarn("getContacts");
      } catch (e) {
        // A getContacts outage does not increment consecutiveFailures, by
        // design, so nothing backs this off. Without a key it is one line
        // every poll interval for as long as the endpoint is unhappy.
        warnOnce("getContacts", "getContacts failed (non-fatal)", e);
      }
      const funnelByIgsid = new Map<string, string>();
      for (const c of contacts) {
        funnelByIgsid.set(c.sender_igsid, contactFunnel(c) || defaultFunnelName(this.settings.funnels));
      }

      // Reconcile the vault against the server before writing new messages.
      // This compares where each conversation actually is, not a cached value,
      // so a move that got lost or reverted repairs itself.
      const cache = this.settings.contactFunnelCache;
      const drained = contactsFetched
        ? await this.drainPendingFunnel(client)
        : new Set<string>();
      let cacheChanged = drained.size > 0;
      for (const c of contacts) {
        const remote = contactFunnel(c) || defaultFunnelName(this.settings.funnels);
        // A change the server hasn't accepted yet is still the user's intent.
        if (this.settings.pendingFunnel[c.sender_igsid]) continue;
        // The contact list was fetched before the drain POSTed, so for anything
        // the drain just got accepted this snapshot still shows the old funnel.
        // Reconciling against it would undo the move that was only now pushed,
        // and the next tick would move it back again. Skip; a fresh snapshot
        // next tick reconciles it correctly.
        if (drained.has(c.sender_igsid)) continue;
        // Resolved to the spelling this contact's folder actually uses, which
        // for a pre-0.2.0 vault is the edge-trimmed legacy name. applyFunnelMove
        // installs its in-flight guard under that name, so checking the raw
        // server handle here would miss the guard and start a second move on
        // top of one already running.
        const onDisk = await onDiskUsername(this.app, this.settings.crmFolder, c.sender_username);
        if (this.movingConversations.has(onDisk.toLowerCase())) continue;

        const actual = findConversation(this.app, this.settings.crmFolder, c.sender_username);
        if (actual === null) {
          // Not in the vault yet; the first message will create it in place.
          if (cache[c.sender_igsid] !== remote) {
            cache[c.sender_igsid] = remote;
            cacheChanged = true;
          }
          continue;
        }
        if (actual.toLowerCase() !== funnelFolderName(remote).toLowerCase()) {
          try {
            await this.applyFunnelMove(c.sender_username, actual, remote);
            clearWarn(`move:${c.sender_username}:${actual}->${remote}`);
          } catch (e) {
            warnOnce(
              `move:${c.sender_username}:${actual}->${remote}`,
              `funnel move failed for ${c.sender_username}: ${actual} -> ${remote}`,
              e,
            );
            continue; // leave the cache behind so the next tick retries
          }
        }
        if (cache[c.sender_igsid] !== remote) {
          cache[c.sender_igsid] = remote;
          cacheChanged = true;
        }
      }
      // Persist before fetching messages: a 401 below returns early, and an
      // already-applied move must not be forgotten.
      if (cacheChanged) {
        await this.saveData(this.settings);
        cacheChanged = false;
      }

      let messages: InboxMessage[];
      try {
        messages = await client.getMessages();
        this.consecutiveFailures = 0;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          this.paused = true;
          this.consecutiveFailures = 0;
          if (e.message.includes("ig-token-invalid")) {
            new Notice(
              `Instagram DM Inbox: your Instagram connection has expired. Reconnect at ${this.settings.serverUrl}, then run Sync now.`,
            );
          } else {
            new Notice("Instagram DM Inbox: that API key isn't valid. Update it in plugin settings.");
          }
        } else {
          this.consecutiveFailures += 1;
          this.lastFailureAt = Date.now();
          logWarn(`poll failed (attempt ${this.consecutiveFailures})`, e);
          if (manual) new Notice("Sync failed. Check the console for details.");
        }
        return;
      }

      const ackIds: string[] = [];
      let wroteAny = false;
      for (const msg of messages) {
        // Redelivered because an earlier ack never landed. The note is already
        // on disk, so re-ack it rather than writing a second copy. Checked
        // before resolving a funnel so this costs no vault scan.
        if (this.settings.writtenMids.includes(msg.mid)) {
          ackIds.push(msg.id);
          continue;
        }
        try {
          const funnel = this.resolveWriteFunnel(msg.sender_igsid, msg.sender_username, funnelByIgsid);
          await this.writeOne(msg, funnel);
          this.rememberWritten(msg.mid);
          wroteAny = true;
          if (!cache[msg.sender_igsid]) {
            // The server's spelling, not the resolved one: resolveWriteFunnel
            // can return a folder-cased name that would never compare equal to
            // the remote value in reconcile.
            cache[msg.sender_igsid] = funnelByIgsid.get(msg.sender_igsid) || funnel;
            cacheChanged = true;
          }
          ackIds.push(msg.id);
          this.writeFailures.delete(msg.mid);
          clearWarn(`write:${msg.mid}`);
          clearWarn(`quarantine:${msg.mid}`);
        } catch (e) {
          const attempts = (this.writeFailures.get(msg.mid) ?? 0) + 1;
          this.writeFailures.set(msg.mid, attempts);
          // Keyed on the message, because a DM that can be written neither
          // normally nor to _unfiled stays in the queue and is retried every
          // poll. Logging it each time filled the console with the same two
          // lines forever.
          warnOnce(`write:${msg.mid}`, `write failed for mid=${msg.mid} (attempt ${attempts})`, e);
          if (attempts >= MAX_WRITE_ATTEMPTS) {
            // Acking deletes the message on the server, so it must not happen
            // until the text is somewhere. Quarantine writes it as a plain
            // note; only then is dropping it from the queue safe.
            try {
              const saved = await quarantineMessage(this.app, this.settings.crmFolder, msg);
              // It is on disk now, so the ledger applies: a redelivery before
              // the ack lands gets re-acked instead of written twice.
              this.rememberWritten(msg.mid);
              wroteAny = true;
              ackIds.push(msg.id);
              this.writeFailures.delete(msg.mid);
              logWarn(`quarantined mid=${msg.mid} after ${attempts} failed writes`);
              new Notice(
                `Instagram DM Inbox: couldn't file a DM from @${msg.sender_username}. ` +
                  `Its text is saved in ${saved}.`,
              );
            } catch (qe) {
              // Both write paths are broken. Leaving the message unacked
              // blocks the queue, which is now the right outcome: the
              // alternative is deleting a DM nobody has a copy of.
              warnOnce(
                `quarantine:${msg.mid}`,
                `quarantine failed for mid=${msg.mid}, leaving it on the server`,
                qe,
              );
            }
          }
        }
      }

      // Persist before acking. If the ack fails, or Obsidian is reloaded right
      // here, the next poll gets these messages again and the ledger is the
      // only record that they are already on disk.
      if (cacheChanged || wroteAny) {
        try {
          await this.saveData(this.settings);
          cacheChanged = false;
          clearWarn("saveData");
        } catch (e) {
          // Everything from here to ackMessages has to be non-throwing, and
          // saveData is the one call in that stretch that talks to disk. A
          // throw would skip the ack and redeliver every message forever,
          // which is far worse than losing the ledger for one tick: the notes
          // are already written, and the worst case without the ledger is a
          // duplicate, not a loop.
          warnOnce("saveData", "couldn't persist settings before ack", e);
        }
      }

      // Both rebuild from what is on disk, so they have to come after the
      // writes: a contact created above needs its profile note to exist before
      // it can be charted or linked. Neither may throw, and neither does; each
      // swallows its own errors. A throw here would skip ackMessages below and
      // get every message redelivered forever.
      const charted = await this.syncCanvas(contacts, funnelByIgsid, contactsFetched);
      // Display names, from the resolution syncCanvas already did. Each call is
      // a no-op once the name is on the note, so this does not write every tick.
      for (const p of charted) {
        try {
          await applyContactName(this.app, p.profilePath, p.username, p.name);
        } catch (e) {
          warnOnce("contactName", "could not write a contact's display name", e);
        }
      }
      await this.refreshHubsFor();

      if (messages.length === 0) {
        if (manual) new Notice("No new DMs");
        return;
      }
      if (ackIds.length === 0) {
        if (manual) new Notice("Sync failed. Check the console for details.");
        return;
      }

      let acked = false;
      try {
        await client.ackMessages(ackIds);
        acked = true;
        clearWarn("ack");
      } catch (e) {
        warnOnce("ack", "ack failed", e);
      }
      if (acked) {
        this.ackFailureStreak = 0;
        new Notice(`Synced ${ackIds.length} DM${ackIds.length === 1 ? "" : "s"}`);
        return;
      }
      // A stuck ack retries every poll, so notify once per streak rather than
      // every few seconds. The second sentence matters: the notes are safely on
      // disk and the ledger guarantees no double-write, so without it an honest
      // message reads as data loss.
      this.ackFailureStreak += 1;
      if (manual || this.ackFailureStreak === 1) {
        new Notice(
          `Saved ${ackIds.length} DM${ackIds.length === 1 ? "" : "s"} to your vault, but the server ` +
            `didn't confirm. They won't be duplicated, and this retries on the next sync.`,
        );
      }
    } finally {
      this.polling = false;
      if (this.settingsChangedDuringTick) {
        this.settingsChangedDuringTick = false;
        await this.onExternalSettingsChange();
      }
    }
  }

  /**
   * Where a conversation's files must go.
   *
   * Disk beats every remote or cached opinion. Reconcile normally makes the two
   * agree, but it deliberately steps aside for a pending funnel, an in-flight
   * move and a failed move, and it doesn't run at all when the contact fetch
   * failed. Writing to the server's funnel in any of those windows creates a
   * second profile note and a second `_history/` for one contact, in a folder
   * nothing ever reconciles back together.
   *
   * Below disk: the user's own un-synced change, then the server, then the last
   * funnel the two agreed on. That last rung is what stops a contacts-fetch
   * outage from dumping every incoming DM into the default funnel.
   *
   * `||` rather than `??` throughout, so an empty string from a hand-edited
   * data.json falls through instead of reaching funnelFolderName(""), which
   * silently answers "New".
   */
  private resolveWriteFunnel(
    igsid: string,
    username: string,
    funnelByIgsid: Map<string, string>,
  ): string {
    const onDisk = findConversation(this.app, this.settings.crmFolder, username);
    if (onDisk) return onDisk;
    return (
      this.settings.pendingFunnel[igsid] ||
      funnelByIgsid.get(igsid) ||
      this.settings.contactFunnelCache[igsid] ||
      defaultFunnelName(this.settings.funnels)
    );
  }

  /** Record a mid as written. Capped rather than pruned on ack: the cap already
   *  bounds it, and pruning would cost a settings write on every tick. */
  private rememberWritten(mid: string): void {
    const list = this.settings.writtenMids;
    if (list.includes(mid)) return;
    list.push(mid);
    if (list.length > MAX_REMEMBERED_MIDS) {
      list.splice(0, list.length - MAX_REMEMBERED_MIDS);
    }
  }

  private async writeOne(msg: InboxMessage, funnel: string): Promise<void> {
    const folder = this.settings.crmFolder;
    // Write into the folder the contact already has, which for a pre-0.2.0
    // vault may use the legacy edge-trimmed spelling. Path builders fed the
    // raw handle would fork a second folder. Only the path-building copy is
    // substituted; a brand-new contact resolves to itself, so frontmatter and
    // the Instagram link are never written with a trimmed handle.
    const disk = await onDiskUsername(this.app, folder, msg.sender_username);
    if (disk !== msg.sender_username) msg = { ...msg, sender_username: disk };
    const profilePath = await ensureProfileNote(
      this.app,
      folder,
      funnel,
      msg.sender_username,
      msg.sender_igsid,
    );
    const msgPath = await writeMessageNote(this.app, folder, funnel, msg);
    const notePath = msgPath.replace(/\.md$/, "");
    const entry: RecentEntry = {
      timestampMs: msg.timestamp_ms,
      notePath,
      label: notePath.split("/").pop() ?? notePath,
    };
    try {
      await updateProfileRecentMessages(this.app, profilePath, [entry]);
    } catch (e) {
      // The message note is already on disk at this point. Throwing would lose
      // the write acknowledgement, and the retry picks a fresh numbered
      // filename rather than reusing this one, so every attempt would leave
      // another copy of the same DM. The Recent block is derived and gets
      // rebuilt on the next message, so log it and treat the write as done.
      logWarn(`couldn't update Recent messages in ${profilePath}`, e);
    }
  }

  /** Rebuild the roster canvas from the server contact list. Skipped when the
   *  contacts fetch failed so a transient error never wipes the canvas.
   *
   *  Returns the contacts it resolved to a real note, so the caller can apply
   *  display names without repeating the on-disk spelling lookup. */
  private async syncCanvas(
    contacts: Contact[],
    funnelByIgsid: Map<string, string>,
    contactsFetched: boolean,
  ): Promise<{ profilePath: string; username: string; name?: string | null }[]> {
    if (!contactsFetched) return [];
    try {
      const skipped: string[] = [];
      const profiles: { profilePath: string; username: string; name?: string | null }[] = [];
      // A loop rather than map/filter: resolving the on-disk spelling can read
      // a note when the metadata cache has not caught up, so it is async.
      for (const c of contacts) {
        // On-disk spelling, or contacts in legacy-named folders silently fall
        // off the canvas via the existence check below.
        const profilePath = profileNotePath(
          this.settings.crmFolder,
          this.resolveWriteFunnel(c.sender_igsid, c.sender_username, funnelByIgsid),
          await onDiskUsername(this.app, this.settings.crmFolder, c.sender_username),
        );
        // Only chart profiles that exist on disk. Server state can run ahead of
        // the vault on a fresh device or mid-move, and a node pointing at a
        // file that isn't there renders broken and never recovers. Reconcile
        // repairs the underlying mismatch, so log it rather than hiding it.
        if (this.app.vault.getAbstractFileByPath(profilePath) instanceof TFile) {
          profiles.push({ profilePath, username: c.sender_username, name: c.sender_name });
        } else {
          skipped.push(c.sender_username);
        }
      }
      // Counted, not one line each. Forty contacts without profile notes, which
      // is just what a second device looks like before its sync lands, used to
      // mean forty warnings every five seconds for as long as that took.
      if (skipped.length > 0) {
        debugLog(`canvas: skipped ${skipped.length} contact(s) with no profile note`);
      }
      const canvasPath = `${this.settings.crmFolder}/${this.settings.canvasFile}`;
      const current = await loadCanvas(this.app, canvasPath);
      const rebuilt = syncCanvasFromContacts(current, profiles, this.settings.funnels);
      if (!canvasEquals(current, rebuilt)) {
        // A canvas the plugin generated has no edges of its own, so edges
        // mean either a pre-v0.2.0 thread canvas or connections the user drew.
        // Either way, keep a copy before replacing it, in the same place the
        // migration backs up to. Reached when old content arrives outside the
        // migration path, such as a sync from a device still on 0.1.6.
        if (current.edges.length > 0) {
          const base = this.settings.canvasFile.split("/").pop() ?? "Inbox.canvas";
          const bak = `${this.settings.crmFolder}/${META_FOLDER}/${base}.pre-v020.bak`;
          if (this.app.vault.getAbstractFileByPath(bak) === null) {
            await this.ensureMetaFolder();
            await this.app.vault.create(bak, JSON.stringify(current, null, 2) + "\n");
          }
        }
        await saveCanvas(this.app, canvasPath, rebuilt);
      }
      clearWarn("canvas");
      return profiles;
    } catch (e) {
      warnOnce("canvas", "canvas sync failed", e);
      // The canvas is the thing that failed. Names are written from the same
      // resolution, so returning nothing here would also skip them; but the
      // list is built before anything that can throw, so there is nothing to
      // hand back once we are in here.
      return [];
    }
  }

  private async applyFunnelMove(
    username: string,
    fromFunnel: string | null,
    toFunnel: string,
  ): Promise<void> {
    const folder = this.settings.crmFolder;
    // Resolve to the folder's on-disk spelling first: the moving-guard below
    // and the YAML watcher both key on the folder-derived name, so a raw
    // handle here would miss the guard and resurrect the self-reverting move.
    username = await onDiskUsername(this.app, folder, username);
    // Resolved through the same disk-truth helper moveConversation uses, or the
    // canvas rewrite below would target a path the files were never moved to.
    const oldDir =
      fromFunnel === null
        ? null
        : conversationFolderIn(folder, stageFolderSpelling(this.app, folder, fromFunnel), username);
    const newDir = conversationFolderIn(
      folder,
      stageFolderSpelling(this.app, folder, toFunnel),
      username,
    );
    // Moving a conversation renames its folder, which makes Obsidian re-index
    // the profile note and fire a frontmatter change while the note still
    // holds the old funnel. Without this guard the watcher reads that as the
    // user asking for the old funnel and moves everything back.
    //
    // Preserve a `true` an outer guard already recorded rather than resetting
    // to false. onConversationFolderMoved installs this same key before its own
    // await, so a genuine hand edit arriving in that earlier window has already
    // been noted here, and clobbering it would lose the post-move recheck that
    // makes the edit take effect.
    const key = username.toLowerCase();
    this.movingConversations.set(key, this.movingConversations.get(key) === true);
    try {
      await moveConversation(this.app, folder, username, fromFunnel, toFunnel);

      // Update canvas node paths so links to the moved profile/messages don't
      // break. Skipped when there was no source: nothing moved, so there is no
      // old path to rewrite, and passing one in would repoint cards that belong
      // to whatever conversation happens to sit at that path.
      if (oldDir !== null) {
        const canvasPath = `${folder}/${this.settings.canvasFile}`;
        const canvas = await loadCanvas(this.app, canvasPath);
        if (rewriteCanvasPaths(canvas, oldDir, newDir)) {
          await saveCanvas(this.app, canvasPath, canvas);
        }
      }
    } finally {
      const sawEvent = this.movingConversations.get(key) === true;
      this.movingConversations.delete(key);
      // A frontmatter event during the move might have been a real hand edit,
      // so look at the note once now that the guard is down. If it agrees with
      // its folder this returns immediately.
      if (sawEvent) {
        const profile = this.app.vault.getAbstractFileByPath(
          profileNotePath(folder, toFunnel, username),
        );
        if (profile instanceof TFile) await this.onProfileYamlChanged(profile);
      }
      // Refresh both ends now rather than waiting for a tick, which may never
      // come while polling is paused or the vault is offline. With no source
      // there is only one end to refresh.
      await this.refreshHubsFor(
        fromFunnel === null ? [toFunnel] : [fromFunnel, toFunnel],
      );
    }
  }

  /**
   * Rebuild the funnel index notes from what is actually on disk.
   *
   * Rosters never come from the server contact list. It can run ahead of the
   * vault, and a hub linking a contact who isn't in that folder is an
   * unresolved link, which is worse than no link at all.
   *
   * Called with no argument it sweeps every funnel folder, which is what lets
   * a funnel whose last contact left get its hub emptied instead of left
   * advertising someone who moved. Passing a subset is an optimisation for the
   * move path, not a different behaviour.
   *
   * `syncFunnelHubs` replaces a roster wholesale, so it must never be handed a
   * partial list. That is why this derives names from the folder rather than
   * accepting them from the caller.
   */
  private async refreshHubsFor(funnels?: string[]): Promise<void> {
    try {
      const crm = this.settings.crmFolder;
      const root = this.app.vault.getAbstractFileByPath(normalizePath(crm));
      if (!(root instanceof TFolder)) return;

      const wanted = funnels
        ? new Set(funnels.map((s) => funnelFolderName(s).toLowerCase()))
        : null;
      const configured = new Set(
        this.settings.funnels.map((s) => funnelFolderName(s.name).toLowerCase()),
      );

      const byFunnel = new Map<string, string[]>();
      for (const child of root.children) {
        if (!(child instanceof TFolder) || child.name.startsWith("_")) continue;
        if (wanted && !wanted.has(child.name.toLowerCase())) continue;
        // Only ever create a hub inside a funnel the user configured. Any other
        // folder under the CRM root, an archive they made or a funnel they have
        // since removed, keeps an existing hub up to date but never gets a new one.
        const hasHub =
          this.app.vault.getAbstractFileByPath(funnelHubPath(crm, child.name)) instanceof TFile;
        if (!configured.has(child.name.toLowerCase()) && !hasHub) continue;

        const names = child.children
          .filter((c): c is TFolder => c instanceof TFolder && c.name.startsWith("@"))
          .map((c) => c.name.slice(1))
          // `=== child.name` rather than `!== null`: a contact duplicated into
          // two funnel folders is listed once, under whichever findConversation
          // resolves to, so two hubs don't both claim them.
          .filter((u) => findConversation(this.app, crm, u) === child.name);
        byFunnel.set(child.name, names);
      }
      if (byFunnel.size > 0) await syncFunnelHubs(this.app, crm, byFunnel);
      clearWarn("hubs");
    } catch (e) {
      // Must never escape: the caller in tick() sits before ackMessages, and a
      // throw there would get every message redelivered forever.
      warnOnce("hubs", "hub refresh failed", e);
    }
  }

  /** The configured stage whose folder name matches, case-insensitively.
   *  Folder names are compared, not raw names, because that is what is on disk
   *  and what the user sees. */
  private funnelByFolderName(name: string): Funnel | undefined {
    const key = name.toLowerCase();
    return this.settings.funnels.find((f) => funnelFolderName(f.name).toLowerCase() === key);
  }

  private isCrmTarget(file: TAbstractFile): boolean {
    return file.path.startsWith(this.settings.crmFolder + "/");
  }

  /** Path segments below the CRM root, or null when the path isn't inside it.
   *  A prefix parse, because the folder setting may itself contain slashes and
   *  a same-named folder elsewhere in the vault must not match. */
  private crmRelParts(path: string): string[] | null {
    const crm = this.settings.crmFolder;
    if (!path.startsWith(crm + "/")) return null;
    return path.slice(crm.length + 1).split("/");
  }

  /** Open the status picker for whatever conversation `target` sits in. */
  private async promptSetStatusFor(target: TAbstractFile): Promise<void> {
    if (!(target instanceof TFile) && !(target instanceof TFolder)) return;
    const ref = await resolveConversation(this.app, this.settings.crmFolder, target);
    if (!ref) {
      new Notice("That note isn't inside one of your conversations.");
      return;
    }
    const stage = this.funnelByFolderName(ref.funnel);
    const known = stage?.statuses ?? [];
    const current = readProfileStatus(this.app, ref.profilePath);

    new StatusSuggestModal(this.app, known, current, async (pick) => {
      const ok = await setProfileStatus(this.app, ref.profilePath, pick.value);
      if (!ok) {
        // Only reason to refuse is a note still on the pre-0.2.0 key, where
        // `status:` would mean the stage.
        new Notice(
          "That conversation hasn't been migrated yet. Change its stage once, then set a status.",
        );
        return;
      }
      if (pick.kind === "clear") {
        new Notice(`Cleared the status on @${ref.username}`);
        return;
      }
      new Notice(`@${ref.username}: ${pick.value}`);
      if (pick.kind === "create" && stage) await this.promoteStatus(stage, pick.value);
    }).open();
  }

  /**
   * Remember a freshly typed status so it is suggested next time.
   *
   * Case-insensitive dedupe with the existing spelling winning, so "Waiting on
   * money" typed once does not sit beside "waiting on money" forever. The
   * frontmatter write has already happened by the time this runs, so a failed
   * push costs a suggestion, never the user's data.
   */
  private async promoteStatus(stage: Funnel, value: string): Promise<void> {
    const existing = stage.statuses ?? [];
    if (existing.some((v) => v.toLowerCase() === value.toLowerCase())) return;
    if (existing.length >= MAX_STATUSES_PER_FUNNEL) {
      debugLog(`not promoting "${value}": ${stage.name} already has the maximum`);
      return;
    }
    stage.statuses = [...existing, value];
    await this.saveSettings();
    if (!this.settings.serverUrl || !this.settings.apiKey) return;
    try {
      const client = new IgCrmClient(this.settings.serverUrl, this.settings.apiKey);
      this.settings.funnels = await client.putTagConfig(this.settings.funnels);
      await this.saveSettings();
      // Mutated in place above, so the tab is holding the pre-promotion entry.
      this.settingTab?.syncFromSettings();
      clearWarn("promote-status");
    } catch (e) {
      // Kept locally regardless: the next successful save carries it up.
      warnOnce("promote-status", `couldn't sync the new status "${value}"`, e);
    }
  }

  private async promptSetFunnelFor(target: TAbstractFile): Promise<void> {
    if (!(target instanceof TFile) && !(target instanceof TFolder)) return;
    const ref = await resolveConversation(this.app, this.settings.crmFolder, target);
    if (!ref) {
      new Notice("That note isn't inside one of your conversations.");
      return;
    }
    const currentLower = ref.funnel.toLowerCase();
    const choices = this.settings.funnels.filter((s) => s.name.toLowerCase() !== currentLower);
    if (choices.length === 0) {
      new Notice("No other funnel stages configured.");
      return;
    }
    new FunnelSuggestModal(this.app, choices, (pick) =>
      this.applyManualFunnel(ref, pick.name),
    ).open();
  }

  private async applyManualFunnel(
    // `funnel: null` means "already at the destination, only the note is stale",
    // which is what a drag in from outside the CRM tree looks like.
    ref: { username: string; funnel: string | null; igsid: string },
    toFunnel: string,
  ): Promise<void> {
    if (ref.funnel !== null && ref.funnel.toLowerCase() === toFunnel.toLowerCase()) return;
    try {
      await this.applyFunnelMove(ref.username, ref.funnel, toFunnel);

      // Claim the contact BEFORE the round-trip, not after it resolves.
      //
      // applyFunnelMove drops its in-flight guard in its own `finally`, so the
      // await below used to run with nothing shielding this contact. A tick
      // landing in that window holds a contact snapshot that predates the commit,
      // sees the folder disagree with it, and moves the folder back — rewriting
      // `funnel:` in the note as it goes, which on the YAML path overwrites the
      // edit the user has just typed. Reconcile skips any contact with a pending
      // entry, so writing it first closes the window. A slow rejection made this
      // worse, not better: it left several ticks unshielded.
      //
      // Safe to leave behind if anything below throws: drainPendingFunnel re-POSTs
      // a value the folder already agrees with, and resolveWriteFunnel reads disk
      // first, so routing is unaffected either way.
      if (ref.igsid) this.settings.pendingFunnel[ref.igsid] = toFunnel;

      let accepted = true;
      if (ref.igsid && this.settings.apiKey && this.settings.serverUrl) {
        const client = new IgCrmClient(this.settings.serverUrl, this.settings.apiKey);
        try {
          await client.setContactFunnel(ref.igsid, toFunnel);
        } catch (e) {
          accepted = false;
          logWarn("setContactFunnel failed", e);
          new Notice("Moved the folder. The server hasn't caught up yet, so this will retry.");
        }
      }
      if (ref.igsid && accepted) {
        this.settings.contactFunnelCache[ref.igsid] = toFunnel;
        delete this.settings.pendingFunnel[ref.igsid];
      }
      // On rejection the pending entry stays exactly where it was written above.
      // Caching the value instead would make the server look stale and let
      // reconcile drag the folder back on the very next tick.
      await this.saveData(this.settings);
      new Notice(`@${ref.username} → ${toFunnel}`);
    } catch (e) {
      logError("set-funnel failed", e);
      new Notice("Couldn't move the conversation. Check the console.");
    }
  }

  /** Retry funnel changes the server hasn't accepted yet. Returns the igsids
   *  the server just took, which reconcile has to leave alone this tick. */
  private async drainPendingFunnel(client: IgCrmClient): Promise<Set<string>> {
    const accepted = new Set<string>();
    for (const [igsid, funnel] of Object.entries(this.settings.pendingFunnel)) {
      try {
        await client.setContactFunnel(igsid, funnel);
        delete this.settings.pendingFunnel[igsid];
        this.settings.contactFunnelCache[igsid] = funnel;
        accepted.add(igsid);
        clearWarn(`pending:${igsid}`);
      } catch (e) {
        // A 4xx other than 429 is the server's final answer: the stage isn't
        // configured any more, or the contact is gone. Retrying cannot fix
        // either, and keeping the entry is actively harmful, because reconcile
        // skips every contact with a pending entry. Leaving it would exclude
        // this conversation from server-to-vault reconciliation permanently,
        // not just stall this one change.
        // 401 and 429 are excluded: a dead token clears when the user
        // reconnects, and a throttle clears on its own. Neither is the
        // server's final answer about this stage.
        const status = e instanceof ApiError ? e.status : 0;
        const permanent = status >= 400 && status < 500 && status !== 401 && status !== 429;
        if (permanent) {
          delete this.settings.pendingFunnel[igsid];
          clearWarn(`pending:${igsid}`);
          // Persisted here rather than left to the tick. The tick only saves
          // when `cacheChanged` is set, and that is seeded from the count of
          // *accepted* drains, which a rejection does not contribute to. Skip
          // this and the entry reappears on the next reload and loops again.
          try {
            await this.saveData(this.settings);
          } catch (saveErr) {
            logWarn("couldn't persist the dropped pending stage", saveErr);
          }
          logWarn(`server rejected funnel ${funnel} for ${igsid}, giving up`, e);
          new Notice(
            `The server rejected the stage "${funnel}". Check your funnel stages in settings, ` +
              `then set the stage again.`,
          );
          continue;
        }
        // Anything else is transient: keep it queued for the next tick.
        warnOnce(`pending:${igsid}`, `retry of funnel ${funnel} for ${igsid} failed`, e);
      }
    }
    return accepted;
  }

  /** A conversation folder the user dragged into a different funnel folder.
   *  Adopt the new location rather than letting reconcile pull it back. */
  private async onConversationFolderMoved(folder: TFolder, oldPath: string): Promise<void> {
    const crm = this.settings.crmFolder;
    if (!folder.name.startsWith("@") || !folder.path.startsWith(crm + "/")) return;
    if (this.movingConversations.has(folder.name.slice(1).toLowerCase())) return;

    // Must sit exactly at <crm>/<Funnel>/@user, and have actually changed funnel.
    const rel = this.crmRelParts(folder.path);
    if (!rel || rel.length !== 2) return;
    const newFunnel = rel[0];
    const oldRel = this.crmRelParts(oldPath);
    if (oldRel && oldRel.length === rel.length && oldRel[0] === newFunnel) return;

    const configured = this.funnelByFolderName(newFunnel);
    if (!configured) {
      new Notice(`"${newFunnel}" isn't one of your funnel stages.`);
      return;
    }
    // Guard first, await second. Straight after a folder rename the metadata
    // cache knows nothing about the new path, which is precisely why
    // resolveConversation carries a cachedRead fallback, so the await below is
    // a real async read rather than a single microtask. The re-index event for
    // the moved profile lands inside that window, and until applyFunnelMove
    // installs the guard the YAML watcher reads the user's own drag as a hand
    // edit asking for the OLD stage and moves the whole conversation back.
    const key = folder.name.slice(1).toLowerCase();
    this.movingConversations.set(key, false);
    try {
      const ref = await resolveConversation(this.app, crm, folder);
      if (!ref) return;
      // A drag in from outside the tree has no old funnel, and `null` says so.
      //
      // This used to pass `""`, on the belief that an empty string "matches no
      // funnel folder, so the move finds nothing to relocate". It does the
      // opposite: `funnelFolderName("")` returns "New" (types.ts), so the source
      // resolved to the default stage's folder. With a live conversation sitting
      // there under the same handle, its notes were moved into the folder the user
      // had just dragged in and the emptied folder was trashed, all reported as a
      // successful stage change.
      await this.applyManualFunnel({ ...ref, funnel: oldRel?.[0] ?? null }, configured.name);
    } finally {
      // applyFunnelMove sets and clears the same key inside this window; the
      // extra delete is idempotent and covers the paths that return early.
      this.movingConversations.delete(key);
    }
  }

  /**
   * Rewrite a pre-0.2.0 profile's `status:` key to `funnel:`.
   *
   * Only ever called when `funnel:` is absent, which is what makes it
   * unambiguous: once the key exists, `status:` means the secondary detail and
   * this never fires again. Best-effort, because it is housekeeping rather than
   * the user's request; the read path already fell back, so a failure costs
   * nothing but a retry next time the note is touched.
   */
  private async adoptLegacyFunnelKey(file: TFile, value: string): Promise<void> {
    const key = `migrate-funnel-key:${file.path}`;
    try {
      await writeFrontmatter(this.app, file, (fm: Record<string, unknown>) => {
        if (fm.funnel !== undefined) return; // someone got there first
        fm.funnel = value;
        delete fm.status;
      });
      clearWarn(key);
      debugLog(`migrated status -> funnel in ${file.path}`);
    } catch (e) {
      warnOnce(key, `couldn't migrate the funnel key in ${file.path}`, e);
    }
  }

  private async onProfileYamlChanged(file: TFile): Promise<void> {
    // Only react to profile notes: <crmFolder>/<Funnel>/@<user>/@<user>.md
    const rel = this.crmRelParts(file.path);
    if (!rel || rel.length !== 3) return;
    const [, userDir, basename] = rel;
    if (!userDir.startsWith("@") || basename !== `${userDir}.md`) return;

    // Our own move is mid-flight; note that an event arrived so applyFunnelMove
    // re-checks afterwards, then stay out of the way.
    const movingKey = userDir.slice(1).toLowerCase();
    if (this.movingConversations.has(movingKey)) {
      this.movingConversations.set(movingKey, true);
      return;
    }

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    // `funnel:` present means this note has been through the rename, so a
    // `status:` key on it is the secondary detail and none of our business.
    // Absent means it is a pre-0.2.0 note whose `status:` still means the
    // stage: adopt it and rewrite the key. Checked per note rather than once
    // per vault, so a note restored from a backup or synced late from a device
    // that never upgraded converges whenever it turns up.
    let rawFunnel: unknown = fm?.funnel;
    if (rawFunnel === undefined && typeof fm?.status === "string") {
      rawFunnel = fm.status;
      void this.adoptLegacyFunnelKey(file, fm.status);
    }
    if (typeof rawFunnel !== "string" || !rawFunnel.trim()) return;
    const yamlFunnel = rawFunnel.trim();

    const ref = await resolveConversation(this.app, this.settings.crmFolder, file);
    if (!ref) return;

    // Loop breaker: YAML matches folder → nothing to do (including our own writes).
    if (yamlFunnel.toLowerCase() === ref.funnel.toLowerCase()) return;

    // Validate the new funnel is one the user has configured.
    const configured = this.settings.funnels.find(
      (s) => s.name.toLowerCase() === yamlFunnel.toLowerCase(),
    );
    if (!configured) {
      new Notice(`Unknown funnel stage: ${yamlFunnel}`);
      return;
    }

    await this.applyManualFunnel(ref, configured.name);
  }
}

class MigrationModal extends Modal {
  private onMigrate: () => void | Promise<void>;
  private inboxFolder: string;

  constructor(app: App, inboxFolder: string, onMigrate: () => void | Promise<void>) {
    super(app);
    this.inboxFolder = inboxFolder;
    this.onMigrate = onMigrate;
  }

  onOpen(): void {
    this.setTitle("Instagram DM Inbox: layout update");
    const { contentEl } = this;
    contentEl.createEl("p", {
      text:
        "This version reorganizes your inbox folder. Message notes move into a " +
        "_history folder inside each conversation, profile notes get a Recent " +
        "messages section, and the canvas becomes one card per contact. If you " +
        "still have conversations in the older Profiles and Messages folders, " +
        "those get moved into per-conversation folders at the same time.",
    });
    const pre = contentEl.createEl("pre");
    // The user's actual folder, not a hardcoded name: the default changed in
    // 0.2.0 and an upgrading vault keeps whatever it already had.
    pre.setText(
      `${this.inboxFolder}/\n` +
        "  _meta/Inbox.canvas\n" +
        "  New/\n" +
        "    @contact/\n" +
        "      @contact.md\n" +
        "      _history/\n" +
        "        2026-07-18 - hello.md",
    );
    contentEl.createEl("p", {
      text:
        "Files are renamed, never deleted, and every move is written to " +
        "_meta/migration-v020.log. Back up your vault first anyway, by " +
        "duplicating the vault folder.",
    });
    contentEl.createEl("p", {
      text: "Syncing stays paused until the migration runs. You can also start it later from plugin settings.",
    });
    new ButtonComponent(contentEl)
      .setButtonText("Migrate now")
      .setCta()
      .onClick(() => {
        this.close();
        void this.onMigrate();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** One row of the status picker: an existing suggestion, free text the user
 *  just typed, or the clear action. */
interface StatusChoice {
  value: string;
  kind: "existing" | "create" | "clear";
  current: boolean;
}

class StatusSuggestModal extends SuggestModal<StatusChoice> {
  private known: string[];
  private current: string;
  private onPick: (pick: StatusChoice) => void | Promise<void>;

  constructor(
    app: App,
    known: string[],
    current: string,
    onPick: (pick: StatusChoice) => void | Promise<void>,
  ) {
    super(app);
    this.known = known;
    this.current = current;
    this.onPick = onPick;
    this.setPlaceholder("Set a status, or type a new one");
  }

  getSuggestions(query: string): StatusChoice[] {
    const q = query.trim();
    const lower = q.toLowerCase();
    const matches = this.known.filter((v) => !q || v.toLowerCase().includes(lower));
    // Current value first so it is obvious what is already set, and so
    // re-picking it is a no-op rather than a hunt.
    matches.sort((a, b) => {
      const ac = a.toLowerCase() === this.current.toLowerCase() ? 0 : 1;
      const bc = b.toLowerCase() === this.current.toLowerCase() ? 0 : 1;
      return ac - bc || a.localeCompare(b);
    });
    const out: StatusChoice[] = matches.map((v) => ({
      value: v,
      kind: "existing",
      current: v.toLowerCase() === this.current.toLowerCase(),
    }));
    // Free text is always allowed; the configured list is a suggestion list,
    // not a whitelist. Only offer it when it is genuinely new.
    if (q && !this.known.some((v) => v.toLowerCase() === lower)) {
      out.push({ value: q, kind: "create", current: false });
    }
    if (this.current) out.push({ value: "", kind: "clear", current: false });
    return out;
  }

  renderSuggestion(item: StatusChoice, el: HTMLElement): void {
    if (item.kind === "clear") {
      el.createDiv({ text: "Clear status" });
      return;
    }
    el.createDiv({ text: item.value });
    if (item.kind === "create") {
      el.createEl("small", { cls: "igcrm-suggestion-hint", text: "new status" });
    } else if (item.current) {
      el.createEl("small", { cls: "igcrm-suggestion-hint", text: "current" });
    }
  }

  onChooseSuggestion(item: StatusChoice): void {
    void this.onPick(item);
  }
}

class FunnelSuggestModal extends SuggestModal<Funnel> {
  private choices: Funnel[];
  private onPick: (pick: Funnel) => void | Promise<void>;

  constructor(app: App, choices: Funnel[], onPick: (pick: Funnel) => void | Promise<void>) {
    super(app);
    this.choices = choices;
    this.onPick = onPick;
    this.setPlaceholder("Pick a funnel stage");
  }

  getSuggestions(query: string): Funnel[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.choices;
    return this.choices.filter((s) => s.name.toLowerCase().includes(q));
  }

  renderSuggestion(item: Funnel, el: HTMLElement): void {
    el.createDiv({ text: item.name });
    if (item.code) {
      el.createEl("small", { cls: "igcrm-suggestion-hint", text: `trigger: ${item.code}` });
    }
  }

  onChooseSuggestion(item: Funnel): void {
    void this.onPick(item);
  }
}
