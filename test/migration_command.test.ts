/**
 * The manual "Run layout migration" escape hatch.
 *
 * The automatic check runs once and then persists `migratedToV02`, so anything
 * pre-0.2.0 that turns up afterwards -- a restored backup, Obsidian Sync from
 * a device still on 0.1.6, a reused vault -- is past the only gate that would
 * have converted it. This command is the way back, so it has to work on a
 * vault whose flag is already set. It used to be gated on `migrationPending`,
 * which is false in exactly that situation, so it did not even appear.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, __openedModals, __resetOpenedModals, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { PluginSettings } from "../src/types";
import { newPlugin } from "./harness";

const TS = Date.UTC(2026, 6, 18, 9, 30);
const FLAT = "CRM/New/@peer/2026-07-18 - hey there.md";
const MOVED = "CRM/New/@peer/_history/2026-07-18 - hey there.md";

function seedLegacyVault(app: App) {
  app.vault.folders.add("CRM");
  app.vault.folders.add("CRM/New");
  app.vault.folders.add("CRM/New/@peer");
  app.vault.files.set(
    "CRM/New/@peer/@peer.md",
    `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\n# @peer\n\n## Notes\n\nhuman note\n`,
  );
  app.vault.files.set(FLAT, `---\nmid: "M1"\ntimestamp: ${TS}\n---\n\nFrom [[@peer]]\n\nhey there\n`);
  app.vault.files.set("CRM/Inbox.canvas", `{"nodes":[],"edges":[]}`);
}

function makePlugin(app: App, overrides: Partial<PluginSettings> = {}) {
  const plugin = newPlugin(app, { canvasFile: "Inbox.canvas", ...overrides });
  return {
    plugin,
    run: () =>
      (plugin as unknown as Record<string, () => Promise<void>>).runLayoutMigrationCommand.call(
        plugin,
      ),
  };
}

/** The oldest shape the plugin ever wrote: everything flat under Profiles/
 *  and Messages/, no per-conversation folders at all. */
function seedOldestVault(app: App) {
  app.vault.folders.add("CRM");
  app.vault.folders.add("CRM/Profiles");
  app.vault.folders.add("CRM/Messages");
  app.vault.files.set(
    "CRM/Profiles/@peer.md",
    `---\nigsid: "IG_PEER"\nusername: "peer"\n---\n\n# @peer\n\n## Notes\n\nhuman note\n`,
  );
  app.vault.files.set(
    "CRM/Messages/2026-07-18 @peer - hey there.md",
    `---\nmid: "M1"\ntimestamp: ${TS}\n---\n\nFrom [[@peer]]\n\nhey there\n`,
  );
}

const notices = (): string[] => ((globalThis as never as Record<string, string[]>).__notices ?? []);

beforeEach(() => {
  (globalThis as never as Record<string, unknown>).__notices = [];
  __resetOpenedModals();
  __setRequestUrl(() => ({ status: 200, json: [] }));
});

describe("Run layout migration", () => {
  it("migrates legacy content that arrived after the flag was already set", async () => {
    const app = new App();
    seedLegacyVault(app);
    const { plugin, run } = makePlugin(app);
    expect(plugin.settings.migratedToV02).toBe(true);

    await run();

    expect(app.vault.files.has(MOVED)).toBe(true);
    expect(app.vault.files.has(FLAT)).toBe(false);
    // The user's own writing is the thing that must not be touched.
    expect(app.vault.files.get("CRM/New/@peer/@peer.md")).toContain("human note");
  });

  it("reports there is nothing to do rather than rewriting a clean vault", async () => {
    // Running it on an already-migrated vault should not rebuild the canvas,
    // because that is a write to a file an open Canvas view may own.
    const app = new App();
    app.vault.folders.add("CRM");
    const { run } = makePlugin(app, { canvasFile: "_meta/Inbox.canvas" });

    await run();

    expect(notices().join(" ")).toMatch(/nothing to migrate/i);
    expect(app.vault.files.has("CRM/_meta/Inbox.canvas")).toBe(false);
  });

  it("lifts the sync halt when it finds nothing to do", async () => {
    // The automatic check leaves migrationPending true when it cannot read the
    // folder, and its notice sends the user to this command. Reporting "nothing
    // to migrate" without clearing the halt left syncing paused for the rest of
    // the session, with the documented escape hatch being the thing that
    // refused to escape.
    const app = new App();
    app.vault.folders.add("CRM");
    const { plugin, run } = makePlugin(app, { canvasFile: "_meta/Inbox.canvas" });
    plugin.migrationPending = true;

    await run();

    expect(notices().join(" ")).toMatch(/nothing to migrate/i);
    expect(plugin.migrationPending).toBe(false);
  });

  it("leaves the automatic path one-shot", async () => {
    // Only an explicit invocation bypasses the flag. If the unforced call
    // stopped honouring it, every load would re-migrate and the consent gate
    // would mean nothing.
    const app = new App();
    seedLegacyVault(app);
    const { plugin } = makePlugin(app);

    await plugin.runV02Migration();

    expect(app.vault.files.has(FLAT)).toBe(true);
    expect(app.vault.files.has(MOVED)).toBe(false);
  });

  it("is not gated on migrationPending", () => {
    // The behaviour above cannot catch a regression in the command wiring
    // itself, because it calls the handler directly. `migrationPending` is
    // false precisely when the escape hatch is needed, so a checkCallback
    // returning false on it hides the command exactly when it matters.
    const src = readFileSync(join(__dirname, "..", "src", "main.ts"), "utf8");
    const from = src.slice(src.indexOf('id: "run-layout-migration"'));
    const block = from
      .slice(0, from.indexOf("});"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//")) // the comment says the word too
      .join("\n");
    expect(block).not.toContain("migrationPending");
    expect(block).not.toContain("checkCallback");
  });
});

describe("a migration and the poll loop cannot run at once", () => {
  it("tick does nothing while a migration is in flight", async () => {
    // Both move folders around the same subtree. `migrationPending` does not
    // cover this: it is false on a vault whose migratedToV02 is latched, and the
    // migrate command stays available for content restored from a backup, so the
    // 5s interval used to keep firing straight through the run. Reconcile could
    // then move a conversation the migration was walking, leaving its notes filed
    // under the stage it had just left, on a tree that reports itself migrated.
    const app = new App();
    app.vault.folders.add("CRM");
    const plugin = newPlugin(app, {
      serverUrl: "https://server.test",
      apiKey: "k",
      migratedToV02: true,
    });
    const anyPlugin = plugin as unknown as Record<string, unknown>;

    const urls: string[] = [];
    __setRequestUrl((p) => {
      urls.push(String(p.url));
      return { status: 200, json: [] };
    });

    anyPlugin.migrating = true;
    await (anyPlugin.tick as (m?: boolean) => Promise<void>).call(plugin, false);
    expect(urls).toEqual([]);

    // And it resumes once the migration is done, so the guard is not a latch.
    anyPlugin.migrating = false;
    await (anyPlugin.tick as (m?: boolean) => Promise<void>).call(plugin, false);
    expect(urls.length).toBeGreaterThan(0);
  });
});

describe("the oldest Profiles/ + Messages/ layout", () => {
  // This migration used to run on load with no consent at all, and recorded
  // itself as done in a `finally`, so a run that threw part-way left a
  // half-moved tree that nothing could repair. It is now the first half of the
  // same consented pass as the v0.2.0 move.

  const PROFILE = "CRM/Profiles/@peer.md";
  const MESSAGE = "CRM/Messages/2026-07-18 @peer - hey there.md";

  function freshPlugin(app: App, stored: Record<string, unknown> = {}) {
    const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(app);
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => stored;
    return plugin;
  }

  it("asks before touching anything", async () => {
    const app = new App();
    seedOldestVault(app);
    const plugin = freshPlugin(app);

    await plugin.onload();
    // onload fires the check with `void` from onLayoutReady, so it has not run
    // when onload resolves. Without this flush the assertions below describe a
    // plugin that has done nothing yet, which is why they used to pass whether
    // the consent gate existed or not.
    await new Promise((r) => setTimeout(r, 0));

    // The modal, not just the absence of damage. A check that crashed would
    // also leave the files alone with the flags unset and polling halted, so
    // without this the test cannot tell "asked" from "fell over".
    expect(__openedModals).toContain("MigrationModal");
    expect(app.vault.files.has(PROFILE)).toBe(true);
    expect(app.vault.files.has(MESSAGE)).toBe(true);
    expect(plugin.settings.migratedLegacyLayout).toBe(false);
    expect(plugin.migrationPending).toBe(true);
  });

  it("converts all the way to the v0.2.0 shape in one consented run", async () => {
    const app = new App();
    seedOldestVault(app);
    const { plugin } = makePlugin(app, { migratedToV02: false, migratedLegacyLayout: false });

    await plugin.runV02Migration();

    expect(app.vault.files.get("CRM/New/@peer/@peer.md")).toContain("human note");
    expect(app.vault.files.has("CRM/New/@peer/_history/2026-07-18 - hey there.md")).toBe(true);
    expect(app.vault.files.has(PROFILE)).toBe(false);
    expect(app.vault.files.has(MESSAGE)).toBe(false);
    expect(plugin.settings.migratedLegacyLayout).toBe(true);
    expect(plugin.settings.migratedToV02).toBe(true);
  });

  it("records nothing when it fails, and works on the retry", async () => {
    const app = new App();
    seedOldestVault(app);
    const { plugin } = makePlugin(app, { migratedToV02: false, migratedLegacyLayout: false });
    const realRename = app.fileManager.renameFile.bind(app.fileManager);
    let failed = false;
    app.fileManager.renameFile = async (f: never, p: string) => {
      if (!failed) {
        failed = true;
        throw new Error("locked");
      }
      return realRename(f, p);
    };

    await plugin.runV02Migration();

    expect(plugin.settings.migratedLegacyLayout).toBe(false);
    expect(plugin.settings.migratedToV02).toBe(false);
    expect(notices().join(" ")).toMatch(/migration failed/i);

    await plugin.runV02Migration();

    expect(plugin.settings.migratedLegacyLayout).toBe(true);
    expect(plugin.settings.migratedToV02).toBe(true);
    expect(app.vault.files.has("CRM/New/@peer/_history/2026-07-18 - hey there.md")).toBe(true);
  });

  it("does not keep asking about files it can never move", async () => {
    // A note the user dropped into Messages/ does not match the 0.1.x filename
    // and is not the plugin's to move. Counting it as outstanding work would
    // put the migration prompt on screen forever.
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/Messages");
    app.vault.files.set("CRM/Messages/shopping list.md", "milk\n");
    const { run } = makePlugin(app, { canvasFile: "_meta/Inbox.canvas" });

    await run();

    expect(notices().join(" ")).toMatch(/nothing to migrate/i);
    expect(app.vault.files.has("CRM/Messages/shopping list.md")).toBe(true);
  });
});
