/**
 * Concurrency and escaping behaviour that only became reachable once the
 * plugin moved onto `vault.process` and `fileManager.processFrontMatter`.
 *
 * The `beforeProcess` hook in the stub fires between the snapshot read and the
 * callback, which is exactly the window a read-modify-write loses a user's
 * keystrokes in. Without it these tests would pass against either
 * implementation and prove nothing.
 */
import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import {
  ensureProfileNote,
  mergeRecentBlock,
  funnelHubPath,
  syncFunnelHubs,
  updateProfileRecentMessages,
} from "../src/vault";

function seedContact(app: App, funnel: string, username: string) {
  const dir = `CRM/${funnel}/@${username}`;
  app.vault.folders.add("CRM");
  app.vault.folders.add(`CRM/${funnel}`);
  app.vault.folders.add(dir);
  app.vault.files.set(
    `${dir}/@${username}.md`,
    `---\nigsid: "IG_${username}"\nusername: "${username}"\nfunnel: ${funnel.toLowerCase()}\n---\n\n# @${username}\n`,
  );
}

const PROFILE = "CRM/New/@peer/@peer.md";

function seedProfileWithBlocks(app: App) {
  app.vault.files.set(
    PROFILE,
    `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\n# @peer\n\n` +
      `<!-- igcrm:recent-start -->\n## Recent messages\n\n<!-- igcrm:recent-end -->\n\n` +
      `## Notes\n\n`,
  );
  app.vault.folders.add("CRM/New/@peer");
}

describe("concurrent edits", () => {
  it("keeps a line typed into a profile between the read and the write", async () => {
    const app = new App();
    seedProfileWithBlocks(app);

    app.vault.beforeProcess = (p) => {
      if (p !== PROFILE) return;
      app.vault.files.set(p, app.vault.files.get(p)! + "typed while syncing\n");
      app.vault.beforeProcess = null; // fire once
    };

    await updateProfileRecentMessages(app as never, PROFILE, [
      { timestampMs: Date.parse("2026-07-30T10:00:00Z"), notePath: "CRM/New/@peer/_history/x", label: "x" },
    ]);

    const body = app.vault.files.get(PROFILE)!;
    expect(body).toContain("typed while syncing");
    expect(body).toContain("[[CRM/New/@peer/_history/x|x]]");
  });

  it("keeps a line typed into a hub between the read and the write", async () => {
    // This one matters most: hubs are rewritten on every tick, so the window is
    // open every few seconds while the user may be writing in the Notes section.
    const app = new App();
    seedContact(app, "New", "alice");
    await syncFunnelHubs(app as never, "CRM", new Map([["New", ["alice"]]]));
    const path = funnelHubPath("CRM", "New");

    seedContact(app, "New", "bob");
    app.vault.beforeProcess = (p) => {
      if (p !== path) return;
      app.vault.files.set(p, app.vault.files.get(p)! + "my own thoughts\n");
      app.vault.beforeProcess = null;
    };
    await syncFunnelHubs(app as never, "CRM", new Map([["New", ["alice", "bob"]]]));

    const hub = app.vault.files.get(path)!;
    expect(hub).toContain("my own thoughts");
    expect(hub).toContain("[[@bob]]");
  });

  it("writes through a stale cachedRead rather than from it", async () => {
    // The pre-check reads the cache and may be stale. The merge that actually
    // lands has to come from the real text, or the write silently reverts
    // whatever the cache had not caught up with.
    const app = new App();
    seedProfileWithBlocks(app);
    app.vault.files.set(PROFILE, app.vault.files.get(PROFILE)! + "fresh body\n");
    app.vault.staleCache.set(PROFILE, `---\nigsid: "IG_PEER"\n---\n\n# @peer\n\nSTALE\n`);

    await updateProfileRecentMessages(app as never, PROFILE, [
      { timestampMs: 1, notePath: "CRM/New/@peer/_history/y", label: "y" },
    ]);

    const body = app.vault.files.get(PROFILE)!;
    expect(body).toContain("fresh body");
    expect(body).not.toContain("STALE");
  });

  it("mergeRecentBlock is pure and needs no vault", () => {
    const before = `# @peer\n\n## Notes\n\nhi\n`;
    const after = mergeRecentBlock(before, [{ timestampMs: 1, notePath: "a/b", label: "b" }], 10);
    expect(before).toBe(`# @peer\n\n## Notes\n\nhi\n`);
    expect(after).toContain("[[a/b|b]]");
    expect(after).toContain("## Notes");
  });
});

describe("the Recent messages line", () => {
  const EMPTY =
    "---\nigsid: x\n---\n\n<!-- igcrm:recent-start -->\n## Recent messages\n\n" +
    "<!-- igcrm:recent-end -->\n";
  const AT = Date.parse("2026-08-11T17:32:00"); // local, as the plugin writes it
  const line = (text: string) => text.split("\n").find((l) => l.startsWith("- ")) ?? "";

  it("shows the date once, with the time", () => {
    // The message filename starts with the date, and the line already carries a
    // full timestamp, so printing the label verbatim read
    // "2026-08-11 17:32 [[...|2026-08-11 - hey (3)]]".
    const out = mergeRecentBlock(EMPTY, [
      {
        timestampMs: AT,
        notePath: "Instagram DMs/New/@alice/_history/2026-08-11 - hey (3)",
        label: "2026-08-11 - hey (3)",
      },
    ]);

    expect(line(out)).toBe(
      "- 2026-08-11 17:32 [[Instagram DMs/New/@alice/_history/2026-08-11 - hey (3)|hey (3)]]",
    );
    // Exactly one date on the line, and the link target keeps its own.
    expect(line(out).match(/2026-08-11/g)).toHaveLength(2); // stamp + path
    expect(line(out)).not.toContain("|2026-08-11");
  });

  it("corrects a profile that already has dated labels", () => {
    // Labels are parsed back out of the note, so an existing block written by an
    // older build is fixed the next time anything touches it, rather than
    // staying wrong until that note happens to be rebuilt.
    const stale =
      "---\nigsid: x\n---\n\n<!-- igcrm:recent-start -->\n## Recent messages\n\n" +
      "- 2026-08-10 09:00 [[Instagram DMs/New/@alice/_history/2026-08-10 - older|2026-08-10 - older]]\n" +
      "<!-- igcrm:recent-end -->\n";

    const out = mergeRecentBlock(stale, [
      { timestampMs: AT, notePath: "Instagram DMs/New/@alice/_history/2026-08-11 - hey", label: "2026-08-11 - hey" },
    ]);

    expect(out).toContain("|hey]]");
    expect(out).toContain("|older]]");
    expect(out).not.toContain("|2026-08-1");
  });

  it("leaves a label that does not start with a date alone", () => {
    const out = mergeRecentBlock(EMPTY, [
      { timestampMs: AT, notePath: "Instagram DMs/New/@alice/_history/call notes", label: "call notes" },
    ]);
    expect(line(out)).toContain("|call notes]]");
  });
});

describe("escapeYaml", () => {
  it("survives a username carrying a quote and a newline", async () => {
    // Both igsid and username are server-supplied, and the username is
    // interpolated unsanitised. A raw newline used to just look odd. Now it
    // makes processFrontMatter throw on that note every single time, so the
    // conversation could never be moved again.
    const app = new App();
    const nastyUser = 'ev"il\nname';
    const nastyIgsid = 'IG"1\n2';
    await ensureProfileNote(app as never, "CRM", "new", nastyUser, nastyIgsid);

    const path = [...app.vault.files.keys()].find((p) => p.endsWith(".md"))!;
    const file = app.vault.getAbstractFileByPath(path)!;

    // The real proof is a round trip through the frontmatter API.
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm.funnel = "Pending";
    });
    expect(app.vault.files.get(path)).toMatch(/^funnel: Pending$/m);

    // And the frontmatter block is still exactly one block.
    const body = app.vault.files.get(path)!;
    expect(body.startsWith("---\n")).toBe(true);
    expect(body.indexOf("\n---", 3)).toBeGreaterThan(0);
  });
});
