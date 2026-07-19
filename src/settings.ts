import { App, ButtonComponent, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type IgCrmPlugin from "./main";
import { IgCrmClient } from "./api";
import { TagStatus } from "./types";

export class IgCrmSettingTab extends PluginSettingTab {
  plugin: IgCrmPlugin;

  constructor(app: App, plugin: IgCrmPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Instagram DM Inbox").setHeading();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Your IG CRM hosted server.")
      .addText((t) =>
        t
          .setPlaceholder("https://...")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (v) => {
            this.plugin.settings.serverUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Issued after you connect your Instagram account on the web app.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.apiKey).onChange(async (v) => {
          this.plugin.settings.apiKey = v.trim();
          await this.plugin.saveSettings();
          this.plugin.resumePolling();
        });
      });

    new Setting(containerEl)
      .setName("CRM folder")
      .setDesc("Vault-relative folder for profiles, messages, and canvas.")
      .addText((t) =>
        t.setValue(this.plugin.settings.crmFolder).onChange(async (v) => {
          this.plugin.settings.crmFolder = v.trim() || "CRM";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Canvas filename")
      .setDesc("Master canvas inside the CRM folder.")
      .addText((t) =>
        t.setValue(this.plugin.settings.canvasFile).onChange(async (v) => {
          this.plugin.settings.canvasFile = v.trim() || "Inbox.canvas";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("How often to fetch new messages.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.pollIntervalSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.pollIntervalSeconds = isNaN(n) || n < 1 ? 5 : n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the server URL and API key.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const client = new IgCrmClient(
            this.plugin.settings.serverUrl,
            this.plugin.settings.apiKey,
          );
          try {
            await client.getMessages(1);
            new Notice("Connection ok");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`Connection failed: ${msg}`);
          }
        }),
      );

    this.renderStatuses(containerEl);
  }

  private renderStatuses(root: HTMLElement): void {
    new Setting(root).setName("Conversation statuses").setHeading();
    const help = root.createEl("p", {
      text: "Each row defines a folder your conversations can live in. Type the trigger code at the end of an Instagram reply (e.g. \"Confirmed! !done\") and the server moves the conversation to that status. One status must have an empty trigger code — that's the default landing status for new conversations.",
    });
    help.setCssStyles({ opacity: "0.75", fontSize: "0.9em" });

    const listWrap = root.createDiv();

    const drawRows = () => {
      listWrap.empty();
      this.plugin.settings.statuses.forEach((row, i) => this.renderStatusRow(listWrap, row, i, drawRows));
    };
    drawRows();

    const controls = new Setting(root);
    controls.addButton((b) =>
      b.setButtonText("Add status").onClick(async () => {
        this.plugin.settings.statuses.push({ name: "", code: "!" });
        drawRows();
      }),
    );
    controls.addButton((b) =>
      b
        .setButtonText("Save statuses")
        .setCta()
        .onClick(async () => {
          await this.saveStatuses();
        }),
    );
  }

  private renderStatusRow(
    parent: HTMLElement,
    row: TagStatus,
    index: number,
    redraw: () => void,
  ): void {
    const setting = new Setting(parent);
    setting.setName(`#${index + 1}`);

    let nameInput: TextComponent | null = null;
    let codeInput: TextComponent | null = null;

    setting.addText((t) => {
      nameInput = t;
      t.setPlaceholder("status name (e.g. done)")
        .setValue(row.name)
        .onChange((v) => {
          this.plugin.settings.statuses[index].name = v.trim();
        });
    });

    setting.addText((t) => {
      codeInput = t;
      t.setPlaceholder("!code (blank = default)")
        .setValue(row.code ?? "")
        .onChange((v) => {
          const trimmed = v.trim();
          this.plugin.settings.statuses[index].code = trimmed ? trimmed : null;
        });
    });

    setting.addButton((b: ButtonComponent) =>
      b
        .setIcon("trash")
        .setTooltip("Remove status")
        .onClick(() => {
          this.plugin.settings.statuses.splice(index, 1);
          redraw();
        }),
    );

    // Prevent TS "unused" warnings when strict-mode is on.
    void nameInput;
    void codeInput;
  }

  private async saveStatuses(): Promise<void> {
    const statuses = this.plugin.settings.statuses
      .map((s) => ({ name: (s.name || "").trim(), code: (s.code ?? "").trim() || null }))
      .filter((s) => s.name.length > 0);

    // Local validation before hitting the server.
    const names = statuses.map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      new Notice("Status names must be unique.");
      return;
    }
    const defaults = statuses.filter((s) => s.code === null);
    if (defaults.length !== 1) {
      new Notice("Exactly one status must have an empty trigger code (the default).");
      return;
    }
    for (const s of statuses) {
      if (s.code !== null && !s.code.startsWith("!")) {
        new Notice(`Trigger code for "${s.name}" must start with "!".`);
        return;
      }
    }
    if (statuses.length === 0) {
      new Notice("At least one status is required.");
      return;
    }

    if (!this.plugin.settings.apiKey || !this.plugin.settings.serverUrl) {
      // Save locally even without server sync.
      this.plugin.settings.statuses = statuses;
      await this.plugin.saveSettings();
      new Notice("Saved locally (configure server URL + API key to sync).");
      return;
    }

    try {
      const client = new IgCrmClient(
        this.plugin.settings.serverUrl,
        this.plugin.settings.apiKey,
      );
      const persisted = await client.putTagConfig(statuses);
      this.plugin.settings.statuses = persisted;
      await this.plugin.saveSettings();
      new Notice("Statuses saved.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Save failed: ${msg}`);
    }
  }
}
