// Minimal in-memory shim of the `obsidian` module so we can unit-test
// the plugin's pure helpers and vault-manipulating code without booting
// Obsidian itself. Only the API surface we use is stubbed.

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null = null;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || "";
  }
}

export class TFile extends TAbstractFile {
  // marker class
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  message: string;
  constructor(message: string) {
    this.message = message;
    // record for assertions if a test cares
    (globalThis as any).__notices = (globalThis as any).__notices || [];
    (globalThis as any).__notices.push(message);
  }
}

/**
 * Minimal fake Vault: keeps files + folders in a Map keyed by path.
 * Only supports the operations vault.ts actually calls: adapter.exists,
 * adapter.read, adapter.write, createFolder, getAbstractFileByPath, read,
 * create, modify.
 */
export class FakeVault {
  files = new Map<string, string>();
  folders = new Set<string>();

  adapter = {
    exists: async (p: string) => this.files.has(p) || this.folders.has(p),
    read: async (p: string) => this.files.get(p) ?? "",
    write: async (p: string, body: string) => {
      this.files.set(p, body);
    },
  };

  createFolder = async (p: string) => {
    this.folders.add(p);
    return new TFolder(p);
  };

  create = async (p: string, body: string) => {
    this.files.set(p, body);
    const f = new TFile(p);
    return f;
  };

  modify = async (file: TFile, body: string) => {
    this.files.set(file.path, body);
  };

  read = async (file: TFile) => this.files.get(file.path) ?? "";

  delete = async (target: TAbstractFile) => {
    this.files.delete(target.path);
    this.folders.delete(target.path);
  };

  getAbstractFileByPath = (p: string): TAbstractFile | null => {
    if (this.files.has(p)) {
      const f = new TFile(p);
      return f;
    }
    if (this.folders.has(p)) {
      const folder = new TFolder(p);
      // children = files/folders whose parent path == p
      for (const path of this.files.keys()) {
        if (path.startsWith(p + "/") && !path.slice(p.length + 1).includes("/")) {
          folder.children.push(new TFile(path));
        }
      }
      return folder;
    }
    return null;
  };
}

export class FakeFileManager {
  constructor(private vault: FakeVault) {}
  renameFile = async (file: TAbstractFile, newPath: string) => {
    const body = this.vault.files.get(file.path);
    if (body !== undefined) {
      this.vault.files.delete(file.path);
      this.vault.files.set(newPath, body);
    }
    file.path = newPath;
  };
}

export class App {
  vault: FakeVault;
  fileManager: FakeFileManager;
  metadataCache = { getFileCache: () => null, on: () => ({}) };
  workspace = { on: () => ({}), getActiveFile: () => null };
  constructor() {
    this.vault = new FakeVault();
    this.fileManager = new FakeFileManager(this.vault);
  }
}

// Placeholders — plugin code only imports these types, never instantiates.
export class Plugin {}
export class SuggestModal<T> {
  app: App;
  constructor(app: App) {
    this.app = app;
  }
  setPlaceholder(_p: string): this {
    return this;
  }
  open() {}
  getSuggestions(_q: string): T[] {
    return [];
  }
  renderSuggestion(_item: T, _el: HTMLElement) {}
  onChooseSuggestion(_item: T) {}
}

export function requestUrl(_p: unknown): unknown {
  throw new Error("requestUrl not stubbed — pass a mock explicitly in tests");
}

export type RequestUrlParam = Record<string, unknown>;
export type PluginSettingTab = unknown;
export interface Setting {}
