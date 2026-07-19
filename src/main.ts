import { App, Notice, Plugin, SuggestModal, TAbstractFile, TFile, TFolder } from "obsidian";
import {
  Contact,
  DEFAULT_SETTINGS,
  InboxMessage,
  PluginSettings,
  TagStatus,
  defaultStatusName,
  statusFolderName,
} from "./types";
import { ApiError, IgCrmClient } from "./api";
import {
  conversationFolder,
  ensureProfileNote,
  migrateLegacyLayout,
  moveConversation,
  resolveConversation,
  writeMessageNote,
} from "./vault";
import {
  addMessageToCanvas,
  loadCanvas,
  rewriteCanvasPaths,
  saveCanvas,
} from "./canvas";
import { IgCrmSettingTab } from "./settings";

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_WRITE_ATTEMPTS = 3;

export default class IgCrmPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private polling = false;
  private paused = false;
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private pollTimer: number | null = null;
  private writeFailures = new Map<string, number>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new IgCrmSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync Instagram DMs", () => {
      void this.syncNow();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow();
      },
    });

    this.addCommand({
      id: "set-status",
      name: "Set status of current conversation",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !file.path.startsWith(this.settings.crmFolder + "/")) return false;
        if (checking) return true;
        void this.promptSetStatusFor(file);
        return true;
      },
    });

    // Right-click menu on any file or folder inside the CRM tree.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!this.isCrmTarget(file)) return;
        menu.addItem((item) =>
          item
            .setTitle("IG CRM: Set status")
            .setIcon("tag")
            .onClick(() => void this.promptSetStatusFor(file)),
        );
      }),
    );

    // Watch profile-note YAML edits: if `status:` diverges from the enclosing
    // folder, treat that as a manual status change and sync.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile) void this.onProfileYamlChanged(file);
      }),
    );

    // One-time legacy layout migration.
    if (!this.settings.migratedLegacyLayout && this.settings.crmFolder) {
      try {
        await migrateLegacyLayout(
          this.app,
          this.settings.crmFolder,
          defaultStatusName(this.settings.statuses),
        );
      } catch (e) {
        console.warn("igcrm legacy migration failed", e);
      } finally {
        this.settings.migratedLegacyLayout = true;
        await this.saveData(this.settings);
      }
    }

    this.restartPollTimer();
  }

  async syncNow(): Promise<void> {
    this.paused = false;
    await this.tick(true);
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    // Ensure new fields exist when upgrading from an older settings shape.
    if (!Array.isArray(this.settings.statuses) || this.settings.statuses.length === 0) {
      this.settings.statuses = DEFAULT_SETTINGS.statuses.map((s) => ({ ...s }));
    }
    if (!this.settings.contactStatusCache || typeof this.settings.contactStatusCache !== "object") {
      this.settings.contactStatusCache = {};
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
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

      // Pull contact list first so we know each sender's current status before writing new messages.
      let contacts: Contact[] = [];
      try {
        contacts = await client.getContacts();
      } catch (e) {
        console.warn("igcrm getContacts failed (non-fatal)", e);
      }
      const statusByIgsid = new Map<string, string>();
      for (const c of contacts) statusByIgsid.set(c.sender_igsid, c.status || defaultStatusName(this.settings.statuses));

      // Apply any status changes (server-side status differs from local cache) BEFORE writing new messages.
      const cache = this.settings.contactStatusCache;
      let cacheChanged = false;
      for (const c of contacts) {
        const local = cache[c.sender_igsid];
        const remote = c.status || defaultStatusName(this.settings.statuses);
        if (local && local !== remote) {
          try {
            await this.applyStatusMove(c.sender_username, local, remote);
          } catch (e) {
            console.warn(`igcrm status move failed for ${c.sender_username}: ${local} → ${remote}`, e);
          }
        }
        if (local !== remote) {
          cache[c.sender_igsid] = remote;
          cacheChanged = true;
        }
      }

      let messages: InboxMessage[];
      try {
        messages = await client.getMessages();
        this.consecutiveFailures = 0;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          this.paused = true;
          this.consecutiveFailures = 0;
          new Notice("Instagram DM Inbox: API key invalid — open plugin settings to update.");
        } else {
          this.consecutiveFailures += 1;
          this.lastFailureAt = Date.now();
          console.warn(`igcrm poll failed (attempt ${this.consecutiveFailures})`, e);
          if (manual) new Notice("Sync failed — check console for details.");
        }
        return;
      }

      if (cacheChanged) await this.saveData(this.settings);

      if (messages.length === 0) {
        if (manual) new Notice("No new DMs");
        return;
      }

      const ackIds: string[] = [];
      for (const msg of messages) {
        try {
          const status = statusByIgsid.get(msg.sender_igsid) || defaultStatusName(this.settings.statuses);
          await this.writeOne(msg, status);
          if (!cache[msg.sender_igsid]) {
            cache[msg.sender_igsid] = status;
            cacheChanged = true;
          }
          ackIds.push(msg.id);
          this.writeFailures.delete(msg.mid);
        } catch (e) {
          const attempts = (this.writeFailures.get(msg.mid) ?? 0) + 1;
          this.writeFailures.set(msg.mid, attempts);
          console.error(`igcrm write failed for mid=${msg.mid} (attempt ${attempts})`, e);
          if (attempts >= MAX_WRITE_ATTEMPTS) {
            console.warn(`igcrm dropping poison message mid=${msg.mid} after ${attempts} failed writes`);
            ackIds.push(msg.id);
            this.writeFailures.delete(msg.mid);
          }
        }
      }

      if (cacheChanged) await this.saveData(this.settings);

      if (ackIds.length === 0) {
        if (manual) new Notice("Sync failed — check console for details.");
        return;
      }

      try {
        await client.ackMessages(ackIds);
      } catch (e) {
        console.warn("igcrm ack failed", e);
      }
      new Notice(`Synced ${ackIds.length} DM${ackIds.length === 1 ? "" : "s"}`);
    } finally {
      this.polling = false;
    }
  }

  private async writeOne(msg: InboxMessage, status: string): Promise<void> {
    const folder = this.settings.crmFolder;
    const profilePath = await ensureProfileNote(
      this.app,
      folder,
      status,
      msg.sender_username,
      msg.sender_igsid,
    );
    const msgPath = await writeMessageNote(this.app, folder, status, msg);
    const canvasPath = `${folder}/${this.settings.canvasFile}`;
    const canvas = await loadCanvas(this.app, canvasPath);
    addMessageToCanvas(canvas, profilePath, msgPath, msg.sender_username);
    await saveCanvas(this.app, canvasPath, canvas);
  }

  private async applyStatusMove(
    username: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<void> {
    const folder = this.settings.crmFolder;
    const oldDir = conversationFolder(folder, fromStatus, username);
    const newDir = conversationFolder(folder, toStatus, username);
    await moveConversation(this.app, folder, username, fromStatus, toStatus);

    // Update canvas node paths so links to the moved profile/messages don't break.
    const canvasPath = `${folder}/${this.settings.canvasFile}`;
    const canvas = await loadCanvas(this.app, canvasPath);
    if (rewriteCanvasPaths(canvas, oldDir, newDir)) {
      await saveCanvas(this.app, canvasPath, canvas);
    }
  }

  private isCrmTarget(file: TAbstractFile): boolean {
    if (!file || !file.path) return false;
    return file.path.startsWith(this.settings.crmFolder + "/");
  }

  private async promptSetStatusFor(target: TAbstractFile): Promise<void> {
    let refTarget: TFile | TFolder;
    if (target instanceof TFolder) {
      refTarget = target;
    } else if (target instanceof TFile) {
      refTarget = target;
    } else {
      return;
    }
    const ref = await resolveConversation(this.app, this.settings.crmFolder, refTarget);
    if (!ref) {
      new Notice("Not inside a CRM conversation folder.");
      return;
    }
    const currentLower = ref.status.toLowerCase();
    const choices = this.settings.statuses.filter((s) => s.name.toLowerCase() !== currentLower);
    if (choices.length === 0) {
      new Notice("No other statuses configured.");
      return;
    }
    new StatusSuggestModal(this.app, choices, (pick) =>
      this.applyManualStatus(ref, pick.name),
    ).open();
  }

  private async applyManualStatus(
    ref: { username: string; status: string; igsid: string },
    toStatus: string,
  ): Promise<void> {
    if (ref.status.toLowerCase() === toStatus.toLowerCase()) return;
    try {
      await this.applyStatusMove(ref.username, ref.status, statusFolderName(toStatus));
      if (ref.igsid && this.settings.apiKey && this.settings.serverUrl) {
        const client = new IgCrmClient(this.settings.serverUrl, this.settings.apiKey);
        try {
          await client.setContactStatus(ref.igsid, toStatus);
        } catch (e) {
          console.warn("igcrm setContactStatus failed", e);
          new Notice("Moved locally, but server sync failed — see console.");
        }
      }
      if (ref.igsid) this.settings.contactStatusCache[ref.igsid] = toStatus;
      await this.saveData(this.settings);
      new Notice(`@${ref.username} → ${toStatus}`);
    } catch (e) {
      console.error("igcrm set-status failed", e);
      new Notice("Set status failed — see console.");
    }
  }

  private async onProfileYamlChanged(file: TFile): Promise<void> {
    // Only react to profile notes: <crmFolder>/<Status>/@<user>/@<user>.md
    if (!this.isCrmTarget(file)) return;
    const parts = file.path.split("/");
    const crmIdx = parts.indexOf(this.settings.crmFolder);
    if (crmIdx < 0 || parts.length !== crmIdx + 4) return;
    const userDir = parts[crmIdx + 2];
    const basename = parts[crmIdx + 3];
    if (!userDir.startsWith("@") || basename !== `${userDir}.md`) return;

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const rawStatus = fm?.status;
    if (typeof rawStatus !== "string" || !rawStatus.trim()) return;
    const yamlStatus = rawStatus.trim();

    const ref = await resolveConversation(this.app, this.settings.crmFolder, file);
    if (!ref) return;

    // Loop breaker: YAML matches folder → nothing to do (including our own writes).
    if (yamlStatus.toLowerCase() === ref.status.toLowerCase()) return;

    // Validate the new status is one the user has configured.
    const configured = this.settings.statuses.find(
      (s) => s.name.toLowerCase() === yamlStatus.toLowerCase(),
    );
    if (!configured) {
      new Notice(`Unknown status: ${yamlStatus}`);
      return;
    }

    await this.applyManualStatus(ref, configured.name);
  }
}

class StatusSuggestModal extends SuggestModal<TagStatus> {
  private choices: TagStatus[];
  private onPick: (pick: TagStatus) => void | Promise<void>;

  constructor(app: App, choices: TagStatus[], onPick: (pick: TagStatus) => void | Promise<void>) {
    super(app);
    this.choices = choices;
    this.onPick = onPick;
    this.setPlaceholder("Pick a status");
  }

  getSuggestions(query: string): TagStatus[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.choices;
    return this.choices.filter((s) => s.name.toLowerCase().includes(q));
  }

  renderSuggestion(item: TagStatus, el: HTMLElement): void {
    el.createEl("div", { text: item.name });
    if (item.code) {
      const sub = el.createEl("small", { text: `trigger: ${item.code}` });
      sub.style.opacity = "0.6";
    }
  }

  onChooseSuggestion(item: TagStatus): void {
    void this.onPick(item);
  }
}
