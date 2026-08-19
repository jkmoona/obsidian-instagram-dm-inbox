/**
 * The status -> funnel rename, and the two compatibility paths it needs.
 *
 * "Status" now means a second, unrelated thing (a free-text detail within a
 * stage), so a straggling identifier is not just untidy, it is ambiguous.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App, TFile, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { DEFAULT_SETTINGS, contactFunnel } from "../src/types";
import { newPlugin } from "./harness";

const SRC = join(__dirname, "..", "src");
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, text: readFileSync(join(SRC, f), "utf8") }));

// scripts/ is NOT covered by `tsc --noEmit`, whose tsconfig include is
// src/**/*.ts only. The loadtest harness imports renamed symbols from src, so
// nothing but this catches a straggler there until someone runs it by hand.
//
// Absent in the published mirror, which excludes scripts/ deliberately: a
// load-test harness is not something users installing the plugin need. Guard
// the read rather than assume the directory. Not guarding it made the whole
// file throw at import inside the payload, which failed `npm test` in the
// release workflow and would have produced a tag with no release attached.
const SCRIPTS = join(__dirname, "..", "scripts");
const scripts = existsSync(SCRIPTS)
  ? readdirSync(SCRIPTS)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => ({ name: `scripts/${f}`, text: readFileSync(join(SCRIPTS, f), "utf8") }))
  : [];

describe("no stragglers", () => {
  it("has no old funnel identifiers left in src/", () => {
    const banned = [
      "TagStatus",
      "DEFAULT_STATUSES",
      "defaultStatusName",
      "statusFolderName",
      "validateStatusName",
      "statusHubPath",
      "syncStatusHubs",
      "applyManualStatus",
      "applyStatusMove",
      "drainPendingStatus",
      "resolveWriteStatus",
      // NOT banned: StatusSuggestModal, promptSetStatusFor, setProfileStatus
      // and readProfileStatus are the *new* secondary-status feature. The old
      // funnel picker is FunnelSuggestModal, asserted separately below.
      "statusByIgsid",
      "contactStatusCache",
      "pendingStatus",
    ];
    // The 0.1.x settings keys are still *read* once, in loadSettings, to adopt
    // an old data.json. Those reads are all off a `legacy.` alias, so anything
    // outside that shape is a straggler.
    const hits: string[] = [];
    for (const s of [...sources, ...scripts]) {
      for (const b of banned) {
        const stray = s.text
          .split("\n")
          .filter((l) => l.includes(b) && !l.includes(`legacy.${b}`));
        if (stray.length) hits.push(`${s.name}: ${b}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("has a distinct picker for each of the two concepts", () => {
    // The two are easy to conflate now that both exist. FunnelSuggestModal
    // moves a conversation between folders; StatusSuggestModal edits a
    // frontmatter field and touches nothing structural.
    const main = sources.find((s) => s.name === "main.ts")!.text;
    expect(main).toContain("class FunnelSuggestModal");
    expect(main).toContain("class StatusSuggestModal");
  });

  it("keeps the HTTP-status identifiers, which are a different concept", () => {
    // The rename was done with a regex. This is the assertion that would have
    // caught it sweeping up `e.status === 401` along with everything else.
    const api = sources.find((s) => s.name === "api.ts")!.text;
    expect(api).toContain("status: number");
    const main = sources.find((s) => s.name === "main.ts")!.text;
    expect(main).toContain("e.status === 401");
    // The loadtest harness reads the HTTP status off a fetch Response. The
    // rename turned that into r.funnel once already, and tsc does not cover
    // scripts/, so nothing else would have noticed.
    //
    // Skipped rather than failed when the harness is absent, which is the
    // normal state in the published payload. Asserting on a file that was
    // deliberately excluded would fail the release for no reason.
    const loadtest = scripts.find((s) => s.name.endsWith("loadtest_build_vault.ts"));
    if (loadtest) {
      expect(loadtest.text).toContain("r.status");
      expect(loadtest.text).not.toContain("r.funnel");
    }
  });
});

describe("reading the wire", () => {
  it("accepts either spelling from /api/contacts", () => {
    expect(contactFunnel({ sender_igsid: "a", sender_username: "b", funnel: "done", updated_at: 1 }))
      .toBe("done");
    expect(contactFunnel({ sender_igsid: "a", sender_username: "b", status: "done", updated_at: 1 }))
      .toBe("done");
    // Both present, as the transition server sends: they agree, and funnel wins.
    expect(
      contactFunnel({
        sender_igsid: "a",
        sender_username: "b",
        funnel: "done",
        status: "done",
        updated_at: 1,
      }),
    ).toBe("done");
  });
});

describe("settings migration", () => {
  beforeEach(() => __setRequestUrl(() => ({ status: 200, json: [] })));

  it("adopts a 0.1.x data.json shape", async () => {
    const app = new App();
    const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(app);
    const legacy = {
      serverUrl: "https://s.test",
      statuses: [
        { name: "new", code: null },
        { name: "later", code: "!later" },
      ],
      contactStatusCache: { IG1: "later" },
      pendingStatus: { IG2: "new" },
    };
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => legacy;

    await plugin.loadSettings();

    expect(plugin.settings.funnels.map((f) => f.name)).toEqual(["new", "later"]);
    expect(plugin.settings.contactFunnelCache).toEqual({ IG1: "later" });
    expect(plugin.settings.pendingFunnel).toEqual({ IG2: "new" });
  });

  it("leaves a 0.2.0 data.json alone", async () => {
    const app = new App();
    const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(app);
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => ({
      funnels: [{ name: "only", code: null }],
      contactFunnelCache: { IG9: "only" },
    });

    await plugin.loadSettings();

    expect(plugin.settings.funnels.map((f) => f.name)).toEqual(["only"]);
    expect(plugin.settings.contactFunnelCache).toEqual({ IG9: "only" });
  });

  it("does not mutate DEFAULT_SETTINGS when adopting", async () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    const app = new App();
    const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(app);
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => ({});
    await plugin.loadSettings();
    plugin.settings.funnels.push({ name: "scribble", code: "!x" });
    plugin.settings.contactFunnelCache.X = "y";
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});

describe("legacy frontmatter key", () => {
  const IGSID = "IG_PEER";
  const USER = "peer";

  function seed(app: App, folder: string, frontmatter: string) {
    const dir = `CRM/${folder}/@${USER}`;
    app.vault.folders.add("CRM");
    app.vault.folders.add(`CRM/${folder}`);
    app.vault.folders.add(dir);
    app.vault.files.set(`${dir}/@${USER}.md`, `---\n${frontmatter}\n---\n\n# @${USER}\n`);
    return `${dir}/@${USER}.md`;
  }

  function make(app: App) {
    const plugin = newPlugin(app, { serverUrl: "https://s.test", apiKey: "k" });
    const anyPlugin = plugin as unknown as Record<string, unknown>;
    return {
      plugin,
      changed: (f: TFile) =>
        (anyPlugin.onProfileYamlChanged as (x: TFile) => Promise<void>).call(plugin, f),
    };
  }

  beforeEach(() => __setRequestUrl(() => ({ status: 200, json: [] })));

  it("rewrites status: to funnel: on a pre-0.2.0 note", async () => {
    // Self-healing rather than one-shot: this note could arrive at any time,
    // from a backup or from a device that never upgraded, long after the
    // migratedToV02 flag was set.
    const app = new App();
    const path = seed(app, "New", `igsid: "${IGSID}"\nstatus: new`);
    const { changed } = make(app);

    await changed(app.vault.getAbstractFileByPath(path) as TFile);
    await new Promise((r) => setTimeout(r, 0));

    const body = app.vault.files.get(path)!;
    expect(body).toMatch(/^funnel: new$/m);
    expect(body).not.toMatch(/^status:/m);
  });

  it("leaves status: alone once funnel: exists", async () => {
    // Post-rename, status: is the secondary detail and must survive untouched.
    const app = new App();
    const path = seed(app, "New", `igsid: "${IGSID}"\nfunnel: new\nstatus: waiting on money`);
    const { changed } = make(app);

    await changed(app.vault.getAbstractFileByPath(path) as TFile);
    await new Promise((r) => setTimeout(r, 0));

    const body = app.vault.files.get(path)!;
    expect(body).toMatch(/^funnel: new$/m);
    expect(body).toMatch(/waiting on money/);
  });

  it("clears the legacy key when a move stamps the stage, not just on a hand edit", async () => {
    // adoptLegacyFunnelKey only fires from the YAML watcher. Every other path
    // that stamps a stage goes through setProfileFunnel, and if that leaves the
    // old key behind then `funnel:` now exists, the migration never fires
    // again, and the stale value silently becomes the contact's secondary
    // status once that field ships.
    const app = new App();
    seed(app, "New", `igsid: "${IGSID}"\nstatus: new`);
    const { plugin } = make(app);
    const anyPlugin = plugin as unknown as Record<string, unknown>;

    await (anyPlugin.applyFunnelMove as (u: string, f: string, t: string) => Promise<void>).call(
      plugin,
      USER,
      "New",
      "done",
    );
    await new Promise((r) => setTimeout(r, 0));

    const moved = app.vault.files.get(`CRM/Done/@${USER}/@${USER}.md`)!;
    expect(moved).toMatch(/^funnel: done$/m);
    expect(moved).not.toMatch(/^status:/m);
  });

  it("still acts on the stage a legacy note names", async () => {
    // The fallback read has to work on the same pass as the rewrite, or the
    // conversation sits in the wrong folder until something touches it again.
    const app = new App();
    const path = seed(app, "New", `igsid: "${IGSID}"\nstatus: done`);
    const { changed } = make(app);

    await changed(app.vault.getAbstractFileByPath(path) as TFile);
    await new Promise((r) => setTimeout(r, 0));

    expect(app.vault.files.has(`CRM/Done/@${USER}/@${USER}.md`)).toBe(true);
  });
});
