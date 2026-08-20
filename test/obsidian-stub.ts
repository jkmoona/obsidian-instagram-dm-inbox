// Minimal in-memory shim of the `obsidian` module so we can unit-test
// the plugin's pure helpers and vault-manipulating code without booting
// Obsidian itself. Only the API surface we use is stubbed.

export function normalizePath(p: string): string {
  // Mirrors the real implementation: trim, unify separators, collapse runs,
  // strip leading AND trailing slashes, and return "/" for an empty result.
  const cleaned = p
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return cleaned === "" ? "/" : cleaned;
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
  configDir = ".obsidian";
  /** Deliberately-stale cachedRead contents, keyed by path. Lets a test prove
   *  that process() works from fresh text rather than a snapshot. */
  staleCache = new Map<string, string>();
  /** Fires between process()'s read and its callback, which is the window a
   *  read-modify-write loses a user's keystrokes in. */
  beforeProcess: ((path: string) => void) | null = null;
  private handlers = new Map<string, ((...args: never[]) => unknown)[]>();
  /** Real Obsidian hands out one TAbstractFile per path and mutates `.path` on
   *  rename, so a handle captured before a move stays valid after it. Minting a
   *  fresh TFile per lookup, as this used to, hides code that relies on that. */
  private fileObjs = new Map<string, TFile>();

  fileObj(p: string): TFile {
    let f = this.fileObjs.get(p);
    if (!f) {
      f = new TFile(p);
      this.fileObjs.set(p, f);
    }
    return f;
  }

  /** Re-key a retained handle after a rename, mutating it in place. */
  rekey(oldPath: string, newPath: string): void {
    const obj = this.fileObjs.get(oldPath);
    if (!obj) return;
    this.fileObjs.delete(oldPath);
    obj.path = newPath;
    obj.name = newPath.split("/").pop() || "";
    this.fileObjs.set(newPath, obj);
  }

  on = (name: string, cb: (...args: never[]) => unknown) => {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name, cb };
  };

  trigger = (name: string, ...args: unknown[]) => {
    for (const cb of this.handlers.get(name) ?? []) {
      (cb as (...a: unknown[]) => unknown)(...args);
    }
  };

  adapter = {
    // Consults implied ancestors too: the adapter talks to the filesystem,
    // where a folder holding a file exists whether or not anything registered
    // it. Checking only the explicit set made ensureFolder's guard miss and
    // createFolder throw.
    exists: async (p: string) => this.files.has(p) || this.allFolders().has(p),
    read: async (p: string) => this.files.get(p) ?? "",
    write: async (p: string, body: string) => {
      this.files.set(p, body);
    },
  };

  createFolder = async (p: string) => {
    // "@throws Error if the folder already exists" per the typings. Silently
    // succeeding hides every caller that forgets to guard.
    if (this.allFolders().has(p)) throw new Error(`Folder already exists: ${p}`);
    this.folders.add(p);
    return new TFolder(p);
  };

  create = async (p: string, body: string) => {
    // Obsidian throws rather than overwriting. Mirroring that is what makes
    // filename-collision bugs visible in tests instead of silently clobbering.
    if (this.files.has(p)) throw new Error(`File already exists: ${p}`);
    this.files.set(p, body);
    return this.fileObj(p);
  };

  modify = async (file: TFile, body: string) => {
    this.files.set(file.path, body);
  };

  read = async (file: TFile) => this.files.get(file.path) ?? "";

  /** In-memory read. `staleCache` lets a test make it disagree with disk. */
  cachedRead = async (file: TFile) =>
    this.staleCache.get(file.path) ?? this.files.get(file.path) ?? "";

  process = async (file: TFile, fn: (data: string) => string) => {
    this.beforeProcess?.(file.path);
    // Reads inside the lock, which is the whole point of the API: whatever the
    // hook just wrote is visible to fn.
    const next = fn(this.files.get(file.path) ?? "");
    this.files.set(file.path, next);
    return next;
  };

  append = async (file: TFile, data: string) => {
    this.files.set(file.path, (this.files.get(file.path) ?? "") + data);
  };

  getFileByPath = (p: string): TFile | null => (this.files.has(p) ? this.fileObj(p) : null);

  getFolderByPath = (p: string): TFolder | null => {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFolder ? f : null;
  };

  delete = async (target: TAbstractFile) => {
    this.files.delete(target.path);
    this.folders.delete(target.path);
  };

  /** Explicit folders plus every ancestor implied by a file path. */
  allFolders(): Set<string> {
    const out = new Set<string>(this.folders);
    const addAncestors = (p: string) => {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        out.add(parts.slice(0, i).join("/"));
      }
    };
    for (const f of this.files.keys()) addAncestors(f);
    for (const f of this.folders) addAncestors(f);
    return out;
  }

  private buildFolder(p: string, folders: Set<string>): TFolder {
    const folder = new TFolder(p);
    const prefix = p + "/";
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
        folder.children.push(this.fileObj(path));
      }
    }
    for (const f of folders) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) {
        folder.children.push(this.buildFolder(f, folders));
      }
    }
    return folder;
  }

  getAbstractFileByPath = (p: string): TAbstractFile | null => {
    if (this.files.has(p)) {
      return this.fileObj(p);
    }
    const folders = this.allFolders();
    if (folders.has(p)) {
      return this.buildFolder(p, folders);
    }
    return null;
  };
}

/** Frontmatter parser good enough for the fields the plugin writes. */
function parseFrontmatter(body: string): Record<string, unknown> | null {
  if (!body.startsWith("---")) return null;
  const end = body.indexOf("\n---", 3);
  if (end < 0) return null;
  const out: Record<string, unknown> = {};
  for (const line of body.slice(4, end).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    // Both quoting styles: the serialiser emits single quotes like js-yaml,
    // while notes the plugin wrote by template use double.
    out[m[1]] = raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2
      ? raw.slice(1, -1).replace(/''/g, "'")
      : raw.replace(/^"([\s\S]*)"$/, "$1");
  }
  return out;
}

/** Split a note into its parsed frontmatter and the body after the block.
 *  Deliberately preserves the body byte-for-byte: processFrontMatter must
 *  never disturb what the user wrote. */
function splitFrontmatter(body: string): { fm: Record<string, unknown>; rest: string } {
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) {
      const afterClose = body.indexOf("\n", end + 1);
      return {
        fm: parseFrontmatter(body) ?? {},
        rest: afterClose >= 0 ? body.slice(afterClose + 1) : "",
      };
    }
  }
  return { fm: {}, rest: body };
}

/** Emit a frontmatter block, creating one when the note had none, which is
 *  what real processFrontMatter does. Quoting is approximate on purpose: tests
 *  must assert with a regex, never on exact bytes, because Obsidian's own YAML
 *  serialiser quotes on its own schedule. */
function serializeFrontmatter(fm: Record<string, unknown>): string {
  const keys = Object.keys(fm);
  if (keys.length === 0) return "";
  const lines = keys.map((k) => {
    const v = fm[k];
    // Quote the way js-yaml does, which is what Obsidian's dumper is: single
    // quotes by default, and anything that would reparse as a non-string gets
    // quoted so it stays a string. An all-digits igsid is the case that
    // matters, and emitting it bare here would let a reader that only handles
    // double quotes pass in tests and break in the real app.
    const mustQuote =
      typeof v === "string" &&
      (/[:#\n'"]/.test(v) || /^(-?\d+(\.\d+)?|true|false|null|~|)$/i.test(v));
    if (mustQuote) return `${k}: '${(v as string).replace(/'/g, "''")}'`;
    return `${k}: ${String(v)}`;
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

type MetaHandler = (file: TAbstractFile) => unknown;

/** Reads frontmatter straight from the fake vault and lets tests fire the
 *  "changed" event, including from inside an in-flight rename. */
export class FakeMetadataCache {
  private handlers = new Map<string, MetaHandler[]>();
  constructor(private vault: FakeVault) {}

  /** Paths the cache is pretending not to know yet. Right after a create or a
   *  rename Obsidian really does return nothing here, and that window is the
   *  only reason the file-reading fallbacks exist. */
  coldPaths = new Set<string>();

  getFileCache = (file: TAbstractFile) => {
    if (this.coldPaths.has(file.path)) return null;
    const body = this.vault.files.get(file.path);
    if (body === undefined) return null;
    const frontmatter = parseFrontmatter(body);
    return frontmatter ? { frontmatter } : {};
  };

  on = (name: string, cb: MetaHandler) => {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name, cb };
  };

  trigger = (name: string, file: TAbstractFile) => {
    for (const cb of this.handlers.get(name) ?? []) cb(file);
  };

  get handlerCount(): number {
    return (this.handlers.get("changed") ?? []).length;
  }
}

export class FakeFileManager {
  /** Set by tests to mimic Obsidian re-indexing a renamed note, which fires
   *  metadataCache "changed" while the caller is still mid-move. */
  onRenamed: ((file: TAbstractFile) => void) | null = null;

  constructor(private vault: FakeVault) {}

  renameFile = async (file: TAbstractFile, newPath: string) => {
    if (file instanceof TFolder) {
      const old = file.path;
      for (const p of [...this.vault.files.keys()]) {
        if (p === old || p.startsWith(old + "/")) {
          const body = this.vault.files.get(p) as string;
          this.vault.files.delete(p);
          const moved = newPath + p.slice(old.length);
          this.vault.files.set(moved, body);
          // Obsidian moves the same TFile instance, so a handle captured before
          // the rename keeps working. Code that relies on that must be able to
          // fail here rather than in production.
          this.vault.rekey(p, moved);
        }
      }
      for (const f of [...this.vault.folders]) {
        if (f === old || f.startsWith(old + "/")) {
          this.vault.folders.delete(f);
          this.vault.folders.add(newPath + f.slice(old.length));
        }
      }
      this.vault.folders.add(newPath);
      file.path = newPath;
      // Obsidian re-indexes the moved children, which fires "changed" for
      // each note while the caller is still finishing the move.
      if (this.onRenamed) {
        for (const p of this.vault.files.keys()) {
          if (p.startsWith(newPath + "/") && p.endsWith(".md")) {
            this.onRenamed(new TFile(p));
          }
        }
      }
      return;
    }
    const body = this.vault.files.get(file.path);
    if (body !== undefined) {
      this.vault.files.delete(file.path);
      this.vault.files.set(newPath, body);
    }
    this.vault.rekey(file.path, newPath);
    file.path = newPath;
    file.name = newPath.split("/").pop() || "";
    if (this.onRenamed && newPath.endsWith(".md")) this.onRenamed(this.vault.fileObj(newPath));
  };

  /** Paths whose metadata cache is pretending to lag, so the
   *  reindex-after-rename caveat is actually reachable from a test. */
  frontmatterIndexLag = new Set<string>();

  processFrontMatter = async (
    file: TAbstractFile,
    fn: (frontmatter: Record<string, unknown>) => void,
  ) => {
    if (this.frontmatterIndexLag.has(file.path)) {
      throw new Error(`metadata cache not ready for ${file.path}`);
    }
    const body = this.vault.files.get(file.path);
    if (body === undefined) throw new Error(`File not found: ${file.path}`);
    const { fm, rest } = splitFrontmatter(body);
    fn(fm);
    this.vault.files.set(file.path, serializeFrontmatter(fm) + rest);
  };

  trashFile = async (target: TAbstractFile) => {
    this.vault.files.delete(target.path);
    this.vault.folders.delete(target.path);
  };
}

export class App {
  vault: FakeVault;
  fileManager: FakeFileManager;
  metadataCache: FakeMetadataCache;
  workspace = {
    on: () => ({}),
    getActiveFile: () => null,
    onLayoutReady: (cb: () => void) => cb(),
    getLeaf: () => ({ openFile: async () => {} }),
    /** Tests push fake leaves in here to pretend a view is open. */
    __leaves: new Map<string, unknown[]>(),
    getLeavesOfType(type: string): unknown[] {
      return (this.__leaves as Map<string, unknown[]>).get(type) ?? [];
    },
  };
  constructor() {
    this.vault = new FakeVault();
    this.fileManager = new FakeFileManager(this.vault);
    this.metadataCache = new FakeMetadataCache(this.vault);
  }
}

export class Plugin {
  app: App;
  manifest = { id: "instagram-dm-inbox", version: "0.2.0-test" };
  private stored: unknown = null;

  constructor(app: App, manifest?: { id: string; version: string }) {
    this.app = app;
    if (manifest) this.manifest = manifest;
  }

  addSettingTab(_tab: unknown) {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void) {
    return {} as HTMLElement;
  }
  addCommand(_cmd: unknown) {
    return {} as unknown;
  }
  registerEvent(_ref: unknown) {}
  registerInterval(id: number) {
    return id;
  }
  register(_cb: () => void) {}
  async loadData(): Promise<unknown> {
    return this.stored;
  }
  async saveData(data: unknown): Promise<void> {
    this.stored = JSON.parse(JSON.stringify(data));
  }
}

export class PluginSettingTab {
  app: App;
  plugin: unknown;
  containerEl = {
    empty: () => {},
    createEl: () => ({ setText: () => {}, setCssStyles: () => {} }),
    createDiv: () => ({ empty: () => {} }),
  } as unknown as HTMLElement;
  /** Populated by update(), as on 1.13+. */
  settingItems: unknown[] = [];
  constructor(app: App, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  getSettingDefinitions(): unknown[] {
    return [];
  }
  /** Real contract: stores getSettingDefinitions() for rendering and search
   *  indexing. Modelled because refresh() calls it unconditionally now. */
  update(): void {
    this.settingItems = this.getSettingDefinitions();
  }
}

/**
 * Rows the imperative renderer built since the last reset.
 *
 * `display()` is what every Obsidian below 1.13 uses, and with a Setting whose
 * methods all did nothing it could only ever be tested by grepping the source
 * for its name. These doubles record what it asked for and hand back real
 * callbacks, so a test can read the rows back and click things.
 */
export interface FakeText {
  value: string;
  placeholder: string;
  inputEl: { type: string };
  fire(v: string): void;
}
export interface FakeToggle {
  value: boolean;
  fire(v: boolean): void;
}
export interface FakeButton {
  text: string;
  icon: string;
  tooltip: string;
  click(): void;
}
export interface FakeRow {
  name: string;
  desc: string;
  heading: boolean;
  classes: string[];
  texts: FakeText[];
  toggles: FakeToggle[];
  buttons: FakeButton[];
}

export const __renderedRows: FakeRow[] = [];

export function __resetRenderedRows(): void {
  __renderedRows.length = 0;
}

export class Setting {
  private row: FakeRow = {
    name: "",
    desc: "",
    heading: false,
    classes: [],
    texts: [],
    toggles: [],
    buttons: [],
  };
  constructor(_el: unknown) {
    __renderedRows.push(this.row);
  }
  setName(n: string): this {
    this.row.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.row.desc = d;
    return this;
  }
  setHeading(): this {
    this.row.heading = true;
    return this;
  }
  /** Real setClass adds to settingEl, which is why Obsidian's own `mod-toggle`
   *  works alongside `setting-item`. */
  setClass(cls: string): this {
    this.row.classes.push(cls);
    return this;
  }
  addText(cb: (t: TextComponent) => void): this {
    const t = new TextComponent();
    cb(t);
    this.row.texts.push(t as unknown as FakeText);
    return this;
  }
  addButton(cb: (b: ButtonComponent) => void): this {
    const b = new ButtonComponent(null);
    cb(b);
    this.row.buttons.push(b as unknown as FakeButton);
    return this;
  }
  addToggle(cb: (t: ToggleComponent) => void): this {
    const t = new ToggleComponent();
    cb(t);
    this.row.toggles.push(t as unknown as FakeToggle);
    return this;
  }
}

export class TextComponent {
  value = "";
  placeholder = "";
  inputEl = { type: "text" };
  private handler: (v: string) => void = () => {};
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  setPlaceholder(p: string): this {
    this.placeholder = p;
    return this;
  }
  onChange(cb: (v: string) => void): this {
    this.handler = cb;
    return this;
  }
  /** What typing in the box does. */
  fire(v: string): void {
    this.value = v;
    this.handler(v);
  }
}

export class ToggleComponent {
  value = false;
  private handler: (v: boolean) => void = () => {};
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  onChange(cb: (v: boolean) => void): this {
    this.handler = cb;
    return this;
  }
  fire(v: boolean): void {
    this.value = v;
    this.handler(v);
  }
}
/**
 * Every suggest modal opened since the last reset, most recent last.
 *
 * The plugin's pickers are module-private, so this is how a test gets hold of
 * one without exporting them purely for testing. Driving the instance the real
 * code path constructed also covers the wiring, which is the half most likely
 * to be wrong: whether the status picker was handed *this* stage's list and
 * the contact's current value.
 */
export const __openedSuggesters: { getSuggestions(q: string): unknown[] }[] = [];

export function __resetOpenedSuggesters(): void {
  __openedSuggesters.length = 0;
}

export class SuggestModal<T> {
  app: App;
  placeholder = "";
  constructor(app: App) {
    this.app = app;
  }
  setPlaceholder(p: string): this {
    this.placeholder = p;
    return this;
  }
  open() {
    __openedSuggesters.push(this as unknown as { getSuggestions(q: string): unknown[] });
  }
  getSuggestions(_q: string): T[] {
    return [];
  }
  renderSuggestion(_item: T, _el: HTMLElement) {}
  onChooseSuggestion(_item: T) {}
}

/** Class names of the modals opened since the last reset, most recent last.
 *  Without this, "the plugin asked before touching anything" and "the check
 *  crashed and touched nothing" leave a test exactly the same state. */
export const __openedModals: string[] = [];

export function __resetOpenedModals(): void {
  __openedModals.length = 0;
}

export class Modal {
  app: App;
  contentEl = { createEl: () => ({ setText: () => {} }), empty: () => {} } as unknown as HTMLElement;
  constructor(app: App) {
    this.app = app;
  }
  setTitle(_t: string): this {
    return this;
  }
  open() {
    __openedModals.push(this.constructor.name);
  }
  close() {}
}

export class ButtonComponent {
  text = "";
  icon = "";
  tooltip = "";
  private handler: () => void = () => {};
  constructor(_el: unknown) {}
  setButtonText(t: string): this {
    this.text = t;
    return this;
  }
  setIcon(i: string): this {
    this.icon = i;
    return this;
  }
  setTooltip(t: string): this {
    this.tooltip = t;
    return this;
  }
  setCta(): this {
    return this;
  }
  onClick(cb: () => void): this {
    this.handler = cb;
    return this;
  }
  click(): void {
    this.handler();
  }
}

export const apiVersion = "1.13.0-stub";

export interface FakeResponse {
  status: number;
  json?: unknown;
  text?: string;
}

let requestUrlHandler: ((p: Record<string, unknown>) => FakeResponse) | null = null;

/** Tests install a handler to observe and control HTTP from the plugin. */
export function __setRequestUrl(h: ((p: Record<string, unknown>) => FakeResponse) | null) {
  requestUrlHandler = h;
}

export async function requestUrl(p: Record<string, unknown>): Promise<FakeResponse> {
  if (!requestUrlHandler) {
    throw new Error("requestUrl not stubbed: call __setRequestUrl in your test");
  }
  const r = requestUrlHandler(p);
  return { text: JSON.stringify(r.json ?? null), ...r };
}

export type RequestUrlParam = Record<string, unknown>;
