import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, TFile, TFolder, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { DEFAULT_SETTINGS, PluginSettings } from "../src/types";
import { newPlugin } from "./harness";

const IGSID = "3157963194593114";
const USER = "alice";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function profileBody(funnel: string): string {
  return (
    `---\n` +
    `igsid: "${IGSID}"\n` +
    `username: "${USER}"\n` +
    `funnel: ${funnel}\n` +
    `tags: []\n` +
    `---\n\n` +
    `# @${USER}\n\n` +
    `## Notes\n\nmy own note\n`
  );
}

/** Build a plugin instance without running onload(), then wire the
 *  metadataCache watcher exactly the way onload() does. */
function makePlugin(app: App, cachedFunnel: string, overrides: Partial<PluginSettings> = {}) {
  const plugin = newPlugin(app, {
    serverUrl: "https://server.test",
    apiKey: "k",
    contactFunnelCache: { [IGSID]: cachedFunnel },
    ...overrides,
  });
  const anyPlugin = plugin as unknown as Record<string, unknown>;
  const watcher = (file: TFile) =>
    void (anyPlugin.onProfileYamlChanged as (f: TFile) => Promise<void>).call(plugin, file);
  app.metadataCache.on("changed", watcher as never);
  app.vault.on("rename", ((f: TFolder, oldPath: string) => {
    if (f instanceof TFolder) {
      void (
        anyPlugin.onConversationFolderMoved as (x: TFolder, o: string) => Promise<void>
      ).call(plugin, f, oldPath);
    }
  }) as never);
  // Capped: the pre-fix code re-enters this forever (move fires a change, the
  // watcher moves it back, repeat), which would hang the suite instead of
  // failing. The cap turns a runaway into a loud assertion.
  const RUNAWAY_CAP = 8;
  const state = { renameEvents: 0 };
  app.fileManager.onRenamed = (f) => {
    if (state.renameEvents >= RUNAWAY_CAP) return;
    state.renameEvents += 1;
    if (f instanceof TFile) app.metadataCache.trigger("changed", f);
  };
  return { plugin, anyPlugin, state, RUNAWAY_CAP };
}

function seedConversation(app: App, funnel: string, crm = "CRM") {
  const dir = `${crm}/${funnel}/@${USER}`;
  app.vault.folders.add(crm);
  app.vault.folders.add(`${crm}/${funnel}`);
  app.vault.folders.add(dir);
  app.vault.folders.add(`${dir}/_history`);
  app.vault.files.set(`${dir}/@${USER}.md`, profileBody(funnel.toLowerCase()));
  app.vault.files.set(`${dir}/_history/2026-07-28 - hi.md`, `---\ndate: 2026-07-28 16:04\n---\n\nhi\n`);
}

function profilePath(app: App): string | null {
  for (const p of app.vault.files.keys()) {
    if (p.endsWith(`/@${USER}.md`)) return p;
  }
  return null;
}

let calls: Call[] = [];

/** Responses per endpoint, so a test only states the ones it cares about. */
interface Routes {
  contacts?: () => { status: number; json?: unknown };
  messages?: () => { status: number; json?: unknown };
  ack?: () => { status: number; json?: unknown };
  setFunnel?: () => { status: number; json?: unknown };
}

const OK: { status: number; json?: unknown } = { status: 200, json: [] };

function installRoutes(r: Routes): void {
  __setRequestUrl((p) => {
    const url = String(p.url);
    const method = String(p.method ?? "GET");
    calls.push({ url, method, body: p.body as string | undefined });
    // Order matters: /api/messages/ack also contains /api/messages, and the
    // funnel POST path also contains /api/contacts.
    if (url.includes("/api/messages/ack")) return (r.ack ?? (() => ({ status: 200, json: {} })))();
    if (url.includes("/api/messages")) return (r.messages ?? (() => OK))();
    if (url.includes("/api/contacts") && method === "POST") {
      return (r.setFunnel ?? (() => ({ status: 200, json: {} })))();
    }
    if (url.includes("/api/contacts")) return (r.contacts ?? (() => OK))();
    return OK;
  });
}

function dm(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    mid: "MID-1",
    sender_igsid: IGSID,
    sender_username: USER,
    timestamp_ms: Date.parse("2026-07-30T10:00:00Z"),
    text: "hello there",
    ...over,
  };
}

function contactRow(funnel: string) {
  return { sender_igsid: IGSID, sender_username: USER, funnel, updated_at: 1 };
}

const runTick = (plugin: IgCrmPlugin, anyPlugin: Record<string, unknown>) =>
  (anyPlugin.tick as (m?: boolean) => Promise<void>).call(plugin, true);

const historyFiles = (app: App) =>
  [...app.vault.files.keys()].filter((p) => p.includes("/_history/"));

const notices = (): string[] => ((globalThis as never as Record<string, string[]>).__notices ?? []);

beforeEach(() => {
  calls = [];
  (globalThis as never as Record<string, unknown>).__notices = [];
  __setRequestUrl((p) => {
    calls.push({
      url: String(p.url),
      method: String(p.method ?? "GET"),
      body: p.body as string | undefined,
    });
    if (String(p.url).includes("/status")) return { status: 200, json: {} };
    return { status: 200, json: [] };
  });
});

afterEach(() => __setRequestUrl(null));

describe("manual funnel change", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    seedConversation(app, "Pending");
  });

  it("does not revert itself when the rename re-indexes the note mid-move", async () => {
    // The regression: renaming the folder fires metadataCache "changed" while
    // the profile YAML still says the OLD funnel. The watcher used to read
    // that as a hand edit and move the conversation straight back.
    const { plugin, anyPlugin, state, RUNAWAY_CAP } = makePlugin(app, "pending");
    const ref = { username: USER, funnel: "Pending", igsid: IGSID };

    await (anyPlugin.applyManualFunnel as (r: unknown, s: string) => Promise<void>).call(
      plugin,
      ref,
      "new",
    );
    await new Promise((r) => setTimeout(r, 0));

    // One move, one re-index, no ping-ponging.
    expect(state.renameEvents).toBeLessThan(RUNAWAY_CAP);
    expect(profilePath(app)).toBe(`CRM/New/@${USER}/@${USER}.md`);
    expect(app.vault.files.has(`CRM/New/@${USER}/_history/2026-07-28 - hi.md`)).toBe(true);
    expect(app.vault.files.get(profilePath(app)!)).toMatch(/^funnel:\s*New$/im);
    expect(plugin.settings.contactFunnelCache[IGSID].toLowerCase()).toBe("new");

    const funnelPosts = calls.filter((c) => c.url.includes("/status"));
    expect(funnelPosts).toHaveLength(1);
    expect(funnelPosts[0].body).toContain('"new"');
  });

  it("shields the contact from reconcile before the server round-trip, not after", async () => {
    // applyFunnelMove drops its in-flight guard in its own finally, so the POST
    // used to be awaited with nothing protecting this contact. A tick landing in
    // that window compares the folder against a pre-commit snapshot and moves it
    // back, rewriting funnel: in the note on the way — which on the YAML path
    // overwrites the edit the user just typed.
    //
    // Asserted from inside the request handler, because the ordering is the whole
    // point: by the time the POST is on the wire, reconcile must already be
    // skipping this contact.
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    let pendingDuringPost: string | undefined;
    installRoutes({
      setFunnel: () => {
        pendingDuringPost = plugin.settings.pendingFunnel[IGSID];
        return { status: 200, json: {} };
      },
    });

    await (anyPlugin.applyManualFunnel as (r: unknown, s: string) => Promise<void>).call(
      plugin,
      { username: USER, funnel: "Pending", igsid: IGSID },
      "done",
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(pendingDuringPost).toBe("done");
    // Cleared once the server has it, so nothing is left for drainPendingFunnel.
    expect(plugin.settings.pendingFunnel[IGSID]).toBeUndefined();
    expect(plugin.settings.contactFunnelCache[IGSID].toLowerCase()).toBe("done");
  });

  it("keeps the server and the vault agreeing after the move", async () => {
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    await (anyPlugin.applyManualFunnel as (r: unknown, s: string) => Promise<void>).call(
      plugin,
      { username: USER, funnel: "Pending", igsid: IGSID },
      "done",
    );
    await new Promise((r) => setTimeout(r, 0));

    const path = profilePath(app)!;
    expect(path).toBe(`CRM/Done/@${USER}/@${USER}.md`);
    const yamlStatus = app.vault.files.get(path)!.match(/^funnel:\s*(.+)$/im)![1].trim();
    expect(yamlStatus.toLowerCase()).toBe("done");
    expect(plugin.settings.contactFunnelCache[IGSID].toLowerCase()).toBe("done");
  });

  it("survives the profile re-index landing inside the rename handler's await", async () => {
    // The realistic case, not the happy one. Straight after a folder rename the
    // metadata cache knows nothing about the new path, which is the whole
    // reason resolveConversation has a cachedRead fallback. That makes the
    // await in onConversationFolderMoved a real async read, and the guard that
    // stops the YAML watcher second-guessing a move is only installed further
    // in, inside applyFunnelMove. A "changed" event landing in that window is
    // read as a hand edit asking for the OLD stage, and the drag is undone.
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin } = makePlugin(app, "pending");

    const from = `CRM/Pending/@${USER}`;
    const to = `CRM/Done/@${USER}`;
    for (const p of [...app.vault.files.keys()]) {
      if (p.startsWith(from + "/")) {
        app.vault.files.set(to + p.slice(from.length), app.vault.files.get(p)!);
        app.vault.files.delete(p);
      }
    }
    app.vault.folders.delete(from);
    app.vault.folders.add("CRM/Done");
    app.vault.folders.add(to);
    app.vault.folders.add(`${to}/_history`);

    // Cold cache for the moved profile, exactly as Obsidian leaves it.
    const movedProfile = `${to}/@${USER}.md`;
    app.metadataCache.coldPaths.add(movedProfile);

    app.vault.trigger("rename", new TFolder(to), from);
    // The cache catches up mid-flight and fires the re-index event.
    app.metadataCache.coldPaths.delete(movedProfile);
    app.metadataCache.trigger("changed", new TFile(movedProfile));
    await new Promise((r) => setTimeout(r, 20));

    expect(profilePath(app)).toBe(movedProfile);
    const posts = calls.filter((c) => c.url.includes("/status"));
    expect(posts.map((c) => c.body).join(" ")).not.toContain("pending");
    expect(plugin.settings.contactFunnelCache[IGSID].toLowerCase()).toBe("done");
  });

  it("leaves a live conversation alone when a same-named folder is dragged in from outside", async () => {
    // The one branch no other rename test reaches: the dragged folder's OLD path
    // is outside the CRM tree, so crmRelParts returns null.
    //
    // That used to become `funnel: ""`, and funnelFolderName("") returns "New",
    // so the move's source resolved to CRM/New/@alice — a real, live, unrelated
    // conversation. Its _history notes were renamed into the folder the user had
    // just dragged in and the emptied folder was trashed, reported as
    // "@alice → Done". Everything below the first assertion is about the live
    // conversation, which nothing in this scenario should touch.
    const app = new App();
    seedConversation(app, "New");
    const { plugin } = makePlugin(app, "new");

    const liveProfile = `CRM/New/@${USER}/@${USER}.md`;
    const liveHistory = `CRM/New/@${USER}/_history/2026-07-28 - hi.md`;
    const liveBodyBefore = app.vault.files.get(liveHistory);

    // An archived copy of the same contact, kept outside the inbox tree, that the
    // user drags into a stage folder.
    const dragged = `CRM/Done/@${USER}`;
    app.vault.folders.add("CRM/Done");
    app.vault.folders.add(dragged);
    app.vault.files.set(`${dragged}/@${USER}.md`, profileBody("new"));

    app.vault.trigger("rename", new TFolder(dragged), `Archive/@${USER}`);
    await new Promise((r) => setTimeout(r, 20));

    // The live conversation is untouched: note still there, body unchanged.
    expect(app.vault.files.has(liveProfile)).toBe(true);
    expect(app.vault.files.get(liveHistory)).toBe(liveBodyBefore);
    expect(app.vault.folders.has(`CRM/New/@${USER}/_history`)).toBe(true);
    expect(app.vault.folders.has(`CRM/New/@${USER}`)).toBe(true);
    // Nothing was carried into the dragged folder either.
    expect([...app.vault.files.keys()].filter((p) => p.startsWith(dragged + "/_history"))).toEqual(
      [],
    );
    // And the drag itself still took effect: the dragged note was stamped.
    expect(app.vault.files.get(`${dragged}/@${USER}.md`)).toMatch(/funnel: ['"]?done/i);
    expect(plugin.settings.contactFunnelCache[IGSID].toLowerCase()).toBe("done");
  });

  it("preserves the user's own notes through the move", async () => {
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    await (anyPlugin.applyManualFunnel as (r: unknown, s: string) => Promise<void>).call(
      plugin,
      { username: USER, funnel: "Pending", igsid: IGSID },
      "new",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(app.vault.files.get(profilePath(app)!)).toContain("my own note");
  });
});

describe("hand-edited frontmatter", () => {
  it("still moves the conversation when the user edits funnel themselves", async () => {
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "pending");

    // Simulate the user typing a new funnel into the note.
    const path = `CRM/Pending/@${USER}/@${USER}.md`;
    app.vault.files.set(path, profileBody("done"));
    app.metadataCache.trigger("changed", new TFile(path));
    await new Promise((r) => setTimeout(r, 0));

    expect(profilePath(app)).toBe(`CRM/Done/@${USER}/@${USER}.md`);
    expect(calls.some((c) => c.url.includes("/status") && c.body?.includes("done"))).toBe(true);
    void plugin;
  });
});

describe("dragging a conversation folder", () => {
  it("adopts the new funnel folder instead of pulling it back", async () => {
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, state, RUNAWAY_CAP } = makePlugin(app, "pending");

    // Simulate the user dragging CRM/Pending/@user into CRM/Done/ in the
    // file explorer: the files land in the new folder without going through
    // the plugin, then Obsidian fires a vault rename.
    const from = `CRM/Pending/@${USER}`;
    const to = `CRM/Done/@${USER}`;
    for (const p of [...app.vault.files.keys()]) {
      if (p.startsWith(from + "/")) {
        app.vault.files.set(to + p.slice(from.length), app.vault.files.get(p)!);
        app.vault.files.delete(p);
      }
    }
    app.vault.folders.delete(from);
    app.vault.folders.add("CRM/Done");
    app.vault.folders.add(to);
    app.vault.folders.add(`${to}/_history`);
    app.vault.trigger("rename", new TFolder(to), from);
    await new Promise((r) => setTimeout(r, 0));

    expect(state.renameEvents).toBeLessThan(RUNAWAY_CAP);
    expect(profilePath(app)).toBe(`${to}/@${USER}.md`);
    const yamlStatus = app.vault.files.get(profilePath(app)!)!.match(/^funnel:\s*(.+)$/im)![1];
    expect(yamlStatus.trim().toLowerCase()).toBe("done");
    expect(calls.some((c) => c.url.includes("/status") && c.body?.includes("done"))).toBe(true);
    expect(plugin.settings.contactFunnelCache[IGSID].toLowerCase()).toBe("done");
  });
});

describe("a multi-segment inbox folder", () => {
  // The old parse did parts.indexOf(crmFolder), which can never match a
  // setting like "Work/CRM", so both watchers were silently dead for anyone
  // who nested the folder. Same two scenarios as above, nested one level.

  it("moves the conversation on a hand-edited funnel", async () => {
    const app = new App();
    seedConversation(app, "Pending", "Work/CRM");
    makePlugin(app, "pending", { crmFolder: "Work/CRM" });

    const path = `Work/CRM/Pending/@${USER}/@${USER}.md`;
    app.vault.files.set(path, profileBody("done"));
    app.metadataCache.trigger("changed", new TFile(path));
    await new Promise((r) => setTimeout(r, 0));

    expect(profilePath(app)).toBe(`Work/CRM/Done/@${USER}/@${USER}.md`);
  });

  it("adopts a dragged folder", async () => {
    const app = new App();
    seedConversation(app, "Pending", "Work/CRM");
    const { state, RUNAWAY_CAP } = makePlugin(app, "pending", { crmFolder: "Work/CRM" });

    const from = `Work/CRM/Pending/@${USER}`;
    const to = `Work/CRM/Done/@${USER}`;
    for (const p of [...app.vault.files.keys()]) {
      if (p.startsWith(from + "/")) {
        app.vault.files.set(to + p.slice(from.length), app.vault.files.get(p)!);
        app.vault.files.delete(p);
      }
    }
    app.vault.folders.delete(from);
    app.vault.folders.add("Work/CRM/Done");
    app.vault.folders.add(to);
    app.vault.folders.add(`${to}/_history`);
    app.vault.trigger("rename", new TFolder(to), from);
    await new Promise((r) => setTimeout(r, 0));

    expect(state.renameEvents).toBeLessThan(RUNAWAY_CAP);
    expect(profilePath(app)).toBe(`${to}/@${USER}.md`);
    const yaml = app.vault.files.get(profilePath(app)!)!.match(/^funnel:\s*(.+)$/im)![1];
    expect(yaml.trim().toLowerCase()).toBe("done");
  });
});

describe("a contact whose folder an older version named differently", () => {
  // Releases before 0.2.0 trimmed edge underscores, so "_alice_" was filed in
  // @alice. Fixing the sanitizer must not orphan those folders: the write path
  // has to keep landing in the folder the contact already has.
  const UNDERSCORED = "_alice_";

  function seedLegacyNamedConversation(app: App, funnel: string) {
    const dir = `CRM/${funnel}/@alice`;
    app.vault.folders.add("CRM");
    app.vault.folders.add(`CRM/${funnel}`);
    app.vault.folders.add(dir);
    app.vault.folders.add(`${dir}/_history`);
    app.vault.files.set(
      `${dir}/@alice.md`,
      `---\nplatform: Instagram\nigsid: "${IGSID}"\nusername: "${UNDERSCORED}"\n` +
        `funnel: ${funnel.toLowerCase()}\ntags: []\n---\n\n# @${UNDERSCORED}\n\n## Notes\n\nmy own note\n`,
    );
  }

  it("writes into the existing folder instead of forking a second one", async () => {
    const app = new App();
    seedLegacyNamedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    installRoutes({
      contacts: () => ({
        status: 200,
        json: [{ sender_igsid: IGSID, sender_username: UNDERSCORED, funnel: "pending", updated_at: 1 }],
      }),
      messages: () => ({ status: 200, json: [dm({ sender_username: UNDERSCORED })] }),
    });

    await runTick(plugin, anyPlugin);

    expect(historyFiles(app)).toEqual([`CRM/Pending/@alice/_history/2026-07-30 - hello there.md`]);
    expect([...app.vault.folders].some((f) => f.includes("@_alice_"))).toBe(false);
  });

  it("moves that folder wholesale rather than creating a correctly named twin", async () => {
    const app = new App();
    seedLegacyNamedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    installRoutes({});

    await (anyPlugin.applyFunnelMove as (u: string, f: string, t: string) => Promise<void>).call(
      plugin,
      UNDERSCORED,
      "Pending",
      "done",
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(app.vault.files.has("CRM/Done/@alice/@alice.md")).toBe(true);
    expect(app.vault.files.has("CRM/Pending/@alice/@alice.md")).toBe(false);
    expect([...app.vault.files.keys()].some((p) => p.includes("@_alice_"))).toBe(false);
    expect(app.vault.files.get("CRM/Done/@alice/@alice.md")).toContain("my own note");
  });

  it("gives two accounts that trim to the same name their own folders", async () => {
    // The bug this fixes: both used to land in @alice and their DMs merged.
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes({
      messages: () => ({
        status: 200,
        json: [
          dm({ id: "m1", mid: "MID-1", sender_igsid: "IG-A", sender_username: "alice" }),
          dm({ id: "m2", mid: "MID-2", sender_igsid: "IG-B", sender_username: UNDERSCORED }),
        ],
      }),
    });

    await runTick(plugin, anyPlugin);

    expect(app.vault.files.has("CRM/New/@alice/@alice.md")).toBe(true);
    expect(app.vault.files.has("CRM/New/@_alice_/@_alice_.md")).toBe(true);
    expect(historyFiles(app)).toHaveLength(2);
    // Each profile records its own handle, not the folder-safe spelling.
    expect(app.vault.files.get("CRM/New/@_alice_/@_alice_.md")).toContain(`username: "${UNDERSCORED}"`);
  });
});

describe("a DM the write path keeps failing on", () => {
  // Acking deletes the row on the server, so the old behaviour (ack and move
  // on after three failures) destroyed the message. These cover the copy that
  // makes acking safe.
  const QUARANTINE = "CRM/_unfiled";
  const quarantined = (app: App) =>
    [...app.vault.files.keys()].filter((p) => p.startsWith(QUARANTINE + "/"));

  /** Break only the conversation write path, leaving _unfiled writable. */
  function breakConversationWrites(app: App, alsoBreakQuarantine = false) {
    const real = app.vault.create.bind(app.vault);
    app.vault.create = async (p: string, body: string) => {
      if (alsoBreakQuarantine || p.includes(`/@${USER}/`)) {
        throw new Error(`refusing to write ${p}`);
      }
      return real(p, body);
    };
  }

  function setup(alsoBreakQuarantine = false) {
    const app = new App();
    app.vault.folders.add("CRM");
    breakConversationWrites(app, alsoBreakQuarantine);
    const made = makePlugin(app, "new");
    installRoutes({ messages: () => ({ status: 200, json: [dm()] }) });
    return { app, ...made };
  }

  const ackedMids = () =>
    calls.filter((c) => c.url.includes("/api/messages/ack")).map((c) => c.body ?? "");

  it("keeps retrying before it gives up", async () => {
    const { app, plugin, anyPlugin } = setup();
    await runTick(plugin, anyPlugin);
    await runTick(plugin, anyPlugin);

    expect(quarantined(app)).toHaveLength(0);
    expect(ackedMids().some((b) => b.includes("m1"))).toBe(false);
  });

  it("saves the text and acks once it does", async () => {
    const { app, plugin, anyPlugin } = setup();
    for (let i = 0; i < 3; i++) await runTick(plugin, anyPlugin);

    const files = quarantined(app);
    expect(files).toHaveLength(1);
    expect(app.vault.files.get(files[0])).toContain("hello there");
    expect(app.vault.files.get(files[0])).toContain(`@${USER}`);
    expect(ackedMids().some((b) => b.includes("m1"))).toBe(true);
    expect(plugin.settings.writtenMids).toContain("MID-1");
    expect(notices().filter((n) => /couldn't file a DM/i.test(n))).toHaveLength(1);
  });

  it("re-acks a redelivery instead of writing a second copy", async () => {
    const { app, plugin, anyPlugin } = setup();
    for (let i = 0; i < 4; i++) await runTick(plugin, anyPlugin);

    expect(quarantined(app)).toHaveLength(1);
    expect(ackedMids().filter((b) => b.includes("m1")).length).toBeGreaterThanOrEqual(2);
    expect(notices().filter((n) => /couldn't file a DM/i.test(n))).toHaveLength(1);
  });

  it("does not re-log the same stuck message on every poll", async () => {
    // It stays in the queue by design, so it is retried forever. Logging both
    // failures each time buried everything else in the console.
    const { plugin, anyPlugin } = setup(true);
    // Both channels: warnOnce writes to console.warn and logError to
    // console.error, so watching only one proves nothing about the other.
    const lines: string[] = [];
    const real = { warn: console.warn, error: console.error };
    const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.warn = grab;
    console.error = grab;
    try {
      for (let i = 0; i < 6; i++) await runTick(plugin, anyPlugin);
    } finally {
      console.warn = real.warn;
      console.error = real.error;
    }

    const aboutThisMessage = lines.filter((l) => l.includes("MID-1"));
    // One for the failed write, one for the failed quarantine, and then quiet
    // however long it stays stuck.
    expect(aboutThisMessage.length).toBeLessThanOrEqual(2);
    expect(aboutThisMessage.length).toBeGreaterThan(0);
  });

  it("never acks when it cannot save the text either", async () => {
    // Blocking the queue is the right outcome here: the alternative is
    // deleting a DM that exists nowhere else.
    const { app, plugin, anyPlugin } = setup(true);
    for (let i = 0; i < 4; i++) await runTick(plugin, anyPlugin);

    expect(quarantined(app)).toHaveLength(0);
    expect(ackedMids().some((b) => b.includes("m1"))).toBe(false);
    expect(plugin.settings.writtenMids).toHaveLength(0);
  });
});

describe("the inbox folder default changed in 0.2.0", () => {
  const load = async (stored: unknown) => {
    const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(new App());
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => stored;
    await plugin.loadSettings();
    return plugin.settings.crmFolder;
  };

  it("keeps an upgrading vault pointed at the folder its files are in", async () => {
    // Nobody who is already using the plugin has `crmFolder` in data.json
    // unless they changed it. Handing them the new default would point the
    // plugin at an empty folder and strand every conversation in CRM/.
    expect(await load({ serverUrl: "https://s.test", apiKey: "k" })).toBe("CRM");
  });

  it("respects a folder they chose themselves", async () => {
    expect(await load({ crmFolder: "Leads" })).toBe("Leads");
  });

  it("pins the canvas path too, since that default also changed", async () => {
    // canvasFile decides canvasIsLegacyDefault, which decides whether the
    // user's existing canvas is backed up and relocated at all. Reading the new
    // default here would leave their arranged board orphaned while the plugin
    // wrote a fresh one somewhere else.
    const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(new App());
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => ({
      serverUrl: "https://s.test",
    });
    await plugin.loadSettings();
    expect(plugin.settings.canvasFile).toBe("Inbox.canvas");
  });

  it("gives a first run the new default", async () => {
    expect(await load(null)).toBe(DEFAULT_SETTINGS.crmFolder);
    expect(DEFAULT_SETTINGS.crmFolder).toBe("Instagram DMs");
  });
});

describe("settings arriving from another device", () => {
  it("does not discard the write ledger of a tick in flight", async () => {
    // loadSettings replaces the settings object, and a tick keeps the mids it
    // has just written there until the pre-ack save. Reloading underneath it
    // dropped that ledger, and the next redelivery wrote those DMs again.
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    // What disk holds: an older copy with an empty ledger.
    await plugin.saveData({ ...plugin.settings, writtenMids: [] });

    // Two messages, and the reload lands while the SECOND is being written.
    // By then the first is in the in-memory ledger and the pre-ack save has not
    // happened, which is the only window where the ledger can be lost.
    let notes = 0;
    let fired = false;
    const realWrite = app.vault.create.bind(app.vault);
    app.vault.create = async (p: string, body: string) => {
      if (p.includes("/_history/")) {
        notes += 1;
        if (notes === 2) {
          fired = true;
          await plugin.onExternalSettingsChange();
        }
      }
      return realWrite(p, body);
    };
    installRoutes({
      messages: () => ({
        status: 200,
        json: [dm(), dm({ id: "m2", mid: "MID-2", text: "second one" })],
      }),
    });

    await runTick(plugin, anyPlugin);

    expect(fired).toBe(true);
    expect(plugin.settings.writtenMids).toContain("MID-1");
    expect(plugin.settings.writtenMids).toContain("MID-2");
  });
});

describe("stored path repair", () => {
  it("loadSettings strips a trailing slash saved by an older version", async () => {
    const app = new App();
    const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(app);
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => ({
      ...DEFAULT_SETTINGS,
      crmFolder: "CRM/",
      canvasFile: "_meta/Inbox.canvas/",
    });
    await plugin.loadSettings();
    expect(plugin.settings.crmFolder).toBe("CRM");
    expect(plugin.settings.canvasFile).toBe("_meta/Inbox.canvas");
  });
});

describe("failed funnel POST", () => {
  it("does not leave the cache claiming a funnel the server never took", async () => {
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "pending");

    __setRequestUrl((p) => {
      calls.push({ url: String(p.url), method: String(p.method ?? "GET") });
      if (String(p.url).includes("/status")) return { status: 429, json: { detail: "slow down" } };
      return { status: 200, json: [] };
    });

    await (anyPlugin.applyManualFunnel as (r: unknown, s: string) => Promise<void>).call(
      plugin,
      { username: USER, funnel: "Pending", igsid: IGSID },
      "new",
    );
    await new Promise((r) => setTimeout(r, 0));

    // Exact state, not a disjunction. The previous version of this assertion
    // was three OR'd conditions, so it also passed in the case its own name
    // calls a failure: the cache claiming "new" with nothing queued.
    //
    // The folder moved, so the vault is on "new". The server refused, so the
    // cache must still say "pending" (claiming "new" makes the server look
    // stale and reconcile drags the folder back next tick), and the change has
    // to be queued so it retries.
    expect(profilePath(app)).toBe(`CRM/New/@${USER}/@${USER}.md`);
    expect(plugin.settings.contactFunnelCache[IGSID]).toBe("pending");
    expect(plugin.settings.pendingFunnel[IGSID]).toBe("new");
  });
});

describe("reconcile", () => {
  it("repairs a conversation sitting in the wrong funnel folder", async () => {
    // The stuck state from the bug report: server and cache agree on "new",
    // but the folder is still in Pending.
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "new");

    __setRequestUrl((p) => {
      const url = String(p.url);
      calls.push({ url, method: String(p.method ?? "GET") });
      if (url.includes("/api/contacts") && !url.includes("/status")) {
        return {
          status: 200,
          json: [
            {
              sender_igsid: IGSID,
              sender_username: USER,
              funnel: "new",
              updated_at: 1,
            },
          ],
        };
      }
      if (url.includes("/api/messages")) return { status: 200, json: [] };
      return { status: 200, json: {} };
    });

    await (anyPlugin.tick as (m?: boolean) => Promise<void>).call(plugin, true);
    await new Promise((r) => setTimeout(r, 0));

    expect(profilePath(app)).toBe(`CRM/New/@${USER}/@${USER}.md`);
    expect(app.vault.files.has(`CRM/New/@${USER}/_history/2026-07-28 - hi.md`)).toBe(true);
  });

  it("does not revert the move when the metadata cache is still stale", async () => {
    // Production failure, 2026-08-25. A trigger code moved the conversation to
    // Done, then the server row went back to pending two seconds later. The
    // move guard is already down by then, and metadataCache still served the
    // pre-move frontmatter, so the watcher read "pending" inside Done, called
    // it a hand edit, and undid both ends.
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    installRoutes({ contacts: () => ({ status: 200, json: [contactRow("done")] }) });

    await runTick(plugin, anyPlugin);
    const moved = `CRM/Done/@${USER}/@${USER}.md`;
    expect(profilePath(app)).toBe(moved);

    // The debounced event finally arrives, carrying the old frontmatter.
    app.metadataCache.staleFrontmatter.set(moved, {
      igsid: IGSID,
      username: USER,
      funnel: "pending",
    });
    calls = [];
    app.metadataCache.trigger("changed", new TFile(moved));
    await new Promise((r) => setTimeout(r, 0));

    expect(profilePath(app)).toBe(moved);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("still follows a real hand edit of the funnel key", async () => {
    // The guard above must not become "ignore every event". Here the file on
    // disk really does say pending while the folder says Done.
    const app = new App();
    seedConversation(app, "Done");
    const { plugin, anyPlugin } = makePlugin(app, "done");
    installRoutes({ contacts: () => ({ status: 200, json: [contactRow("done")] }) });

    const path = `CRM/Done/@${USER}/@${USER}.md`;
    app.vault.files.set(path, profileBody("pending"));
    calls = [];
    app.metadataCache.trigger("changed", new TFile(path));
    await new Promise((r) => setTimeout(r, 0));

    expect(profilePath(app)).toBe(`CRM/Pending/@${USER}/@${USER}.md`);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/status"))).toBe(true);
  });

  it("leaves a corrupt canvas alone instead of overwriting it", async () => {
    // The rebuilt roster used to be written straight over a file that would not
    // parse, and the backup was gated on an edge count that is zero in exactly
    // that case. Every card the user placed went with it.
    const app = new App();
    seedConversation(app, "New");
    const canvasPath = "CRM/_meta/Inbox.canvas";
    const broken = "{ not json at all";
    app.vault.folders.add("CRM/_meta");
    app.vault.files.set(canvasPath, broken);
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes({ contacts: () => ({ status: 200, json: [contactRow("new")] }) });

    await runTick(plugin, anyPlugin);

    expect(app.vault.files.get(canvasPath)).toBe(broken);
  });

  it("never creates an empty conversation folder for a contact it cannot find", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");

    __setRequestUrl((p) => {
      const url = String(p.url);
      if (url.includes("/api/contacts") && !url.includes("/status")) {
        return {
          status: 200,
          json: [{ sender_igsid: IGSID, sender_username: USER, funnel: "new", updated_at: 1 }],
        };
      }
      return { status: 200, json: [] };
    });

    await (anyPlugin.tick as (m?: boolean) => Promise<void>).call(plugin, true);
    await new Promise((r) => setTimeout(r, 0));

    expect(app.vault.folders.has(`CRM/New/@${USER}`)).toBe(false);
  });
});

describe("write path funnel resolution", () => {
  it("writes an incoming DM into the folder the conversation is actually in", async () => {
    // The contacts fetch fails, so the server has no opinion at all. Pre-fix
    // that meant falling straight to the default funnel and creating a second
    // profile note plus a second _history for a contact that already exists.
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes({
      contacts: () => ({ status: 500, json: { detail: "boom" } }),
      messages: () => ({ status: 200, json: [dm()] }),
    });

    await runTick(plugin, anyPlugin);

    expect(historyFiles(app).every((p) => p.startsWith(`CRM/Pending/@${USER}/`))).toBe(true);
    expect(app.vault.files.has(`CRM/New/@${USER}/@${USER}.md`)).toBe(false);
    expect(historyFiles(app).length).toBe(2); // the seeded one plus the new DM
  });

  it("keeps messages where the user moved them while the server catches up", async () => {
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "new", {
      pendingFunnel: { [IGSID]: "pending" },
    });
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("new")] }),
      messages: () => ({ status: 200, json: [dm()] }),
      setFunnel: () => ({ status: 429, json: { detail: "slow down" } }),
    });

    await runTick(plugin, anyPlugin);

    // Reconcile steps aside for a pending funnel, so the folder stays put and
    // the write has to follow it rather than the server's stale "new".
    expect(app.vault.files.has(`CRM/New/@${USER}/@${USER}.md`)).toBe(false);
    expect(historyFiles(app).every((p) => p.startsWith(`CRM/Pending/@${USER}/`))).toBe(true);
  });

  it("falls back to the last agreed funnel when the contact list can't be fetched", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "done");
    installRoutes({
      contacts: () => ({ status: 500, json: { detail: "boom" } }),
      messages: () => ({ status: 200, json: [dm()] }),
    });

    await runTick(plugin, anyPlugin);

    expect(app.vault.files.has(`CRM/Done/@${USER}/@${USER}.md`)).toBe(true);
    expect(app.vault.files.has(`CRM/New/@${USER}/@${USER}.md`)).toBe(false);
  });
});

describe("ack failures", () => {
  const failingAck: Routes = {
    contacts: () => ({ status: 200, json: [contactRow("new")] }),
    messages: () => ({ status: 200, json: [dm()] }),
    ack: () => ({ status: 500, json: { detail: "nope" } }),
  };

  it("does not write a second copy when the message comes back", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes(failingAck);

    await runTick(plugin, anyPlugin);
    await runTick(plugin, anyPlugin);

    expect(historyFiles(app).length).toBe(1);
    expect(historyFiles(app).some((p) => p.includes(" (2)"))).toBe(false);
    // One Recent entry too: the duplicate would have landed under a new
    // filename, so updateProfileRecentMessages' path-keyed dedupe would not
    // have caught it either.
    const profile = app.vault.files.get(`CRM/New/@${USER}/@${USER}.md`)!;
    expect(profile.match(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[\[/gm) ?? []).toHaveLength(1);
  });

  it("re-acks a message it has already written", async () => {
    // Without this the dedupe would strand the message on the server forever.
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes(failingAck);

    await runTick(plugin, anyPlugin);
    await runTick(plugin, anyPlugin);

    const acks = calls.filter((c) => c.url.includes("/api/messages/ack"));
    expect(acks).toHaveLength(2);
    expect(acks[1].body).toContain("m1");
  });

  it("does not claim a successful sync the server never confirmed", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes(failingAck);

    await runTick(plugin, anyPlugin);

    expect(notices().some((n) => n.startsWith("Synced "))).toBe(false);
    expect(notices().some((n) => n.includes("didn't confirm"))).toBe(true);
  });

  it("remembers written messages across a plugin reload", async () => {
    // The redelivery window lasts until an ack lands, so it outlives a reload.
    // An in-memory Set would be empty exactly when it is needed most.
    const app = new App();
    app.vault.folders.add("CRM");
    const first = makePlugin(app, "new");
    installRoutes(failingAck);
    await runTick(first.plugin, first.anyPlugin);

    const persisted = JSON.parse(JSON.stringify(first.plugin.settings.writtenMids));
    const second = makePlugin(app, "new", { writtenMids: persisted });
    await runTick(second.plugin, second.anyPlugin);

    expect(historyFiles(app).length).toBe(1);
  });
});

describe("funnel hubs", () => {
  it("links a brand-new contact into its hub on the tick that creates it", async () => {
    // Pre-fix, hubs only refreshed on the branch where no messages arrived, so
    // a contact created by a tick stayed a graph orphan until the next quiet poll.
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("new")] }),
      messages: () => ({ status: 200, json: [dm()] }),
    });

    await runTick(plugin, anyPlugin);

    const hub = app.vault.files.get("CRM/New/@New.md");
    expect(hub).toBeDefined();
    expect(hub).toContain(`[[@${USER}]]`);
  });

  it("refreshes hubs even when the contact list can't be fetched", async () => {
    // Rosters come from disk, so a failed contacts fetch is no reason to leave
    // the hubs stale.
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    installRoutes({ contacts: () => ({ status: 500, json: {} }) });

    await runTick(plugin, anyPlugin);

    expect(app.vault.files.get("CRM/Pending/@Pending.md")).toContain(`[[@${USER}]]`);
  });

  it("clears the hub of the funnel a conversation just left", async () => {
    const app = new App();
    seedConversation(app, "Pending");
    const { plugin, anyPlugin } = makePlugin(app, "pending");
    installRoutes({});

    await (anyPlugin.refreshHubsFor as () => Promise<void>).call(plugin);
    expect(app.vault.files.get("CRM/Pending/@Pending.md")).toContain(`[[@${USER}]]`);

    await (anyPlugin.applyManualFunnel as (r: unknown, s: string) => Promise<void>).call(
      plugin,
      { username: USER, funnel: "Pending", igsid: IGSID },
      "done",
    );
    await new Promise((r) => setTimeout(r, 0));

    const pendingHub = app.vault.files.get("CRM/Pending/@Pending.md");
    expect(pendingHub).toBeDefined();
    expect(pendingHub).not.toContain(`[[@${USER}]]`);
    expect(app.vault.files.get("CRM/Done/@Done.md")).toContain(`[[@${USER}]]`);
  });
});

describe("pending funnel drain", () => {
  it("does not undo a move the server has only just accepted", async () => {
    // The contact list is fetched BEFORE drainPendingFunnel posts, so for a
    // change the drain gets accepted, that snapshot still shows the old funnel.
    // Reconciling against it moves the conversation back, and the next tick
    // moves it forward again: the user watches it bounce, with four folder
    // renames and the Obsidian Sync churn that comes with them.
    const app = new App();
    seedConversation(app, "Done");
    const { plugin, anyPlugin } = makePlugin(app, "pending", {
      pendingFunnel: { [IGSID]: "done" },
    });
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("pending")] }),
      setFunnel: () => ({ status: 200, json: {} }),
    });

    await runTick(plugin, anyPlugin);
    await new Promise((r) => setTimeout(r, 0));

    expect(app.vault.files.has(`CRM/Done/@${USER}/@${USER}.md`)).toBe(true);
    expect(app.vault.files.has(`CRM/Pending/@${USER}/@${USER}.md`)).toBe(false);
    expect(plugin.settings.pendingFunnel[IGSID]).toBeUndefined();
  });
});

describe("write atomicity", () => {
  it("does not duplicate the note when the Recent block update fails", async () => {
    // writeOne creates the message note first and updates the profile's Recent
    // block second. A throw from the second step used to lose the write
    // acknowledgement, and the retry picked a fresh numbered filename instead
    // of reusing the one already on disk, so every attempt left another copy.
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, anyPlugin } = makePlugin(app, "new");
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("new")] }),
      messages: () => ({ status: 200, json: [dm()] }),
    });

    let broken = true;
    const realModify = app.vault.modify;
    app.vault.modify = async (f: never, body: string) => {
      const path = (f as unknown as { path: string }).path;
      if (broken && path.endsWith(`@${USER}.md`)) {
        broken = false;
        throw new Error("file is locked");
      }
      return realModify(f, body);
    };

    await runTick(plugin, anyPlugin);
    await runTick(plugin, anyPlugin);

    expect(historyFiles(app)).toHaveLength(1);
    expect(historyFiles(app).some((p) => p.includes(" (2)"))).toBe(false);
  });
});

describe("pending funnel drain, permanent failures", () => {
  it("gives up on a 4xx instead of excluding the contact from reconcile forever", async () => {
    // Reconcile skips any contact with a pending entry, so a pending entry
    // that can never clear does not just stall one change: it removes that
    // conversation from server-to-vault reconciliation permanently.
    const app = new App();
    seedConversation(app, "Done");
    const { plugin, anyPlugin } = makePlugin(app, "pending", {
      pendingFunnel: { [IGSID]: "nonexistent" },
    });
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("pending")] }),
      setFunnel: () => ({ status: 400, json: { detail: "unknown status 'nonexistent'" } }),
    });

    await runTick(plugin, anyPlugin);
    await new Promise((r) => setTimeout(r, 0));

    expect(plugin.settings.pendingFunnel[IGSID]).toBeUndefined();
    expect(notices().some((n) => n.includes("rejected"))).toBe(true);
  });

  it("keeps retrying a 429, which is not the server's final answer", async () => {
    const app = new App();
    seedConversation(app, "Done");
    const { plugin, anyPlugin } = makePlugin(app, "pending", {
      pendingFunnel: { [IGSID]: "done" },
    });
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("pending")] }),
      setFunnel: () => ({ status: 429, json: { detail: "slow down" } }),
    });

    await runTick(plugin, anyPlugin);
    await new Promise((r) => setTimeout(r, 0));

    expect(plugin.settings.pendingFunnel[IGSID]).toBe("done");
  });

  it("keeps retrying a 401, which clears when the user reconnects", async () => {
    const app = new App();
    seedConversation(app, "Done");
    const { plugin, anyPlugin } = makePlugin(app, "pending", {
      pendingFunnel: { [IGSID]: "done" },
    });
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("pending")] }),
      setFunnel: () => ({ status: 401, json: { detail: "ig-token-invalid" } }),
    });

    await runTick(plugin, anyPlugin);
    await new Promise((r) => setTimeout(r, 0));

    expect(plugin.settings.pendingFunnel[IGSID]).toBe("done");
  });

  it("persists the drop, so a reload does not resurrect the loop", async () => {
    // The tick only saves when cacheChanged is set, and that comes from the
    // count of accepted drains. A rejection contributes nothing, so without an
    // explicit save the entry is back after a reload and loops again.
    const app = new App();
    seedConversation(app, "Done");
    const { plugin, anyPlugin } = makePlugin(app, "pending", {
      pendingFunnel: { [IGSID]: "nonexistent" },
    });
    installRoutes({
      contacts: () => ({ status: 200, json: [contactRow("pending")] }),
      setFunnel: () => ({ status: 400, json: { detail: "unknown status" } }),
    });

    // Seed the stored copy, or the assertion is vacuous: with nothing ever
    // saved, loadData() returns null and the lookup is undefined regardless.
    await plugin.saveData(plugin.settings);
    const seeded = (await plugin.loadData()) as { pendingFunnel?: Record<string, string> };
    expect(seeded.pendingFunnel?.[IGSID]).toBe("nonexistent");

    await runTick(plugin, anyPlugin);
    await new Promise((r) => setTimeout(r, 0));

    const persisted = (await plugin.loadData()) as { pendingFunnel?: Record<string, string> };
    expect(persisted.pendingFunnel?.[IGSID]).toBeUndefined();
  });
});
