/**
 * The contact display name on a profile note.
 *
 * Two properties matter more than the happy path. It runs for every contact on
 * every five-second tick, so it must not write when there is nothing to change.
 * And it edits a line of the note body, so it must not touch a heading the user
 * has rewritten.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { applyContactName } from "../src/vault";

const PATH = "Instagram DMs/New/@alice/@alice.md";

/** A profile note in the shape the plugin writes: keys in canonical order, so a
 *  fixture asserting "nothing was written" is not really asserting "the order
 *  needed fixing". */
function note(heading = "# @alice", extra = "", name?: string): string {
  const nameLine = name === undefined ? "" : `name: ${name}\n`;
  return (
    `---\n${nameLine}username: "alice"\nfunnel: New\ncreated: 2026-08-01 10:00\nigsid: "IG_1"\n---\n\n` +
    `${heading}\n\n[Open on Instagram](https://instagram.com/alice)\n\n` +
    `<!-- igcrm:recent-start -->\n## Recent messages\n\n<!-- igcrm:recent-end -->\n\n` +
    `## Notes\n\n${extra}`
  );
}

/** Counts real writes, since identical content does not prove none happened. */
function countWrites(app: App) {
  const counter = { frontmatter: 0, body: 0 };
  const fm = app.fileManager.processFrontMatter.bind(app.fileManager);
  const proc = app.vault.process.bind(app.vault);
  app.fileManager.processFrontMatter = vi.fn(async (...args: never[]) => {
    counter.frontmatter += 1;
    return fm(...(args as Parameters<typeof fm>));
  }) as never;
  app.vault.process = vi.fn(async (...args: never[]) => {
    counter.body += 1;
    return proc(...(args as Parameters<typeof proc>));
  }) as never;
  return counter;
}

describe("applyContactName", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    app.vault.folders.add("Instagram DMs/New/@alice");
  });

  it("writes the name and composes the heading", async () => {
    app.vault.files.set(PATH, note());

    await applyContactName(app, PATH, "alice", "Alice Smith");

    const out = app.vault.files.get(PATH)!;
    expect(out).toContain("Alice Smith");
    expect(out).toContain("# Alice Smith");
    expect(out).not.toMatch(/^# @alice$/m);
  });

  it("leaves everything else in the note alone", async () => {
    app.vault.files.set(PATH, note("# @alice", "agreed on Thursday, call back\n"));

    await applyContactName(app, PATH, "alice", "Alice Smith");

    const out = app.vault.files.get(PATH)!;
    expect(out).toContain("agreed on Thursday, call back");
    expect(out).toContain("[Open on Instagram](https://instagram.com/alice)");
    expect(out).toContain("<!-- igcrm:recent-start -->");
    // Asserted by value, not by bytes: Obsidian's YAML dumper quotes on its
    // own schedule, so a frontmatter write may change the quoting style.
    expect(out).toMatch(/igsid: ['"]?IG_1['"]?/);
    expect(out).toMatch(/funnel: ['"]?New['"]?/);
  });

  it("does not touch a heading the user has rewritten", async () => {
    // The heading is body prose. A display name is not worth editing someone's
    // writing over, so the rule is an exact match or nothing.
    app.vault.files.set(PATH, note("# Alice, the one from the conference"));

    await applyContactName(app, PATH, "alice", "Alice Smith");

    const out = app.vault.files.get(PATH)!;
    expect(out).toContain("# Alice, the one from the conference");
    expect(out).not.toContain("# Alice Smith");
    // Frontmatter still gets it, since that field is ours.
    expect(out).toContain("Alice Smith");
  });

  it("writes nothing when the name is already on the note", async () => {
    // The guard that stops a five-second tick from rewriting every profile note
    // in the vault, forever.
    app.vault.files.set(PATH, note("# Alice Smith", "", "Alice Smith"));
    const before = app.vault.files.get(PATH)!;
    const writes = countWrites(app);

    await applyContactName(app, PATH, "alice", "Alice Smith");

    expect(writes).toEqual({ frontmatter: 0, body: 0 });
    expect(app.vault.files.get(PATH)).toBe(before);
  });

  it.each([undefined, null, "", "   "])(
    "leaves the note untouched when the name is %p",
    async (name) => {
      // Never clears an existing name: a server older than this field, or a
      // profile that has since removed its name, must not blank what we have.
      app.vault.files.set(PATH, note("# Alice Smith", "", "Alice Smith"));
      const before = app.vault.files.get(PATH)!;
      const writes = countWrites(app);

      await applyContactName(app, PATH, "alice", name as string | null | undefined);

      expect(writes).toEqual({ frontmatter: 0, body: 0 });
      expect(app.vault.files.get(PATH)).toBe(before);
    },
  );

  it("is a no-op when the note is not there", async () => {
    await expect(
      applyContactName(app, "Instagram DMs/New/@ghost/@ghost.md", "ghost", "Ghost"),
    ).resolves.toBeUndefined();
  });

  it("upgrades a note created moments earlier", async () => {
    // How a brand-new contact gets its name: ensureProfileNote writes
    // "# @alice", and the next contact poll finds that exact line and replaces
    // it. That is why the name is not threaded through the message path.
    app.vault.files.set(PATH, note("# @alice"));

    await applyContactName(app, PATH, "alice", "Alice Smith");

    expect(app.vault.files.get(PATH)).toContain("# Alice Smith");
  });

  it("does not rename the folder or the note", async () => {
    // Folders stay @username: names are neither unique nor stable, and renaming
    // on every profile edit would move files under the user.
    app.vault.files.set(PATH, note());

    await applyContactName(app, PATH, "alice", "Alice Smith");

    expect(app.vault.files.has(PATH)).toBe(true);
    expect([...app.vault.files.keys()]).toEqual([PATH]);
  });

  it("survives a name holding characters that would break hand-written YAML", async () => {
    // Written through processFrontMatter rather than string concatenation, so a
    // colon or a quote in a profile name cannot corrupt the note.
    app.vault.files.set(PATH, note());

    await applyContactName(app, PATH, "alice", 'Alice: "Ally" Smith');

    const out = app.vault.files.get(PATH)!;
    expect(out).toContain('# Alice: "Ally" Smith');
    // The body below the frontmatter is intact, which is the thing corruption
    // would eat.
    expect(out).toContain("<!-- igcrm:recent-start -->");
    expect(out).toContain("## Notes");
  });

  it("keeps an all-digit igsid a string through the frontmatter rewrite", async () => {
    // This now runs for every contact rather than only ones being moved, so the
    // round trip matters more than it did. A real IGSID is 17 digits, which is
    // past what a JS number holds exactly: emitted unquoted, it would come back
    // as 17841400000000000 rounded, and every message would file under the
    // wrong contact.
    const igsid = "17841400000000123";
    app.vault.files.set(
      PATH,
      `---\nigsid: "${igsid}"\nusername: "alice"\nfunnel: New\n---\n\n# @alice\n`,
    );

    await applyContactName(app, PATH, "alice", "Alice Smith");

    const out = app.vault.files.get(PATH)!;
    expect(out).toContain(igsid);
    expect(out).not.toContain("17841400000000120");
    // And it still reads back as a string, not a rounded number.
    const fm = app.metadataCache.getFileCache(app.vault.fileObj(PATH))!.frontmatter!;
    expect(String(fm.igsid)).toBe(igsid);
  });

  it("trims surrounding whitespace off the name", async () => {
    app.vault.files.set(PATH, note());

    await applyContactName(app, PATH, "alice", "  Alice Smith  ");

    expect(app.vault.files.get(PATH)).toContain("# Alice Smith");
  });

  // --- a changed name, which used to leave the heading behind ----------------

  it("updates the heading when the name changes", async () => {
    // The bug this covers: the heading only matched "# @alice", so once it read
    // "# Alice Rivera" a rename updated the frontmatter and the heading kept the
    // old name for good.
    app.vault.files.set(PATH, note("# Alice Rivera", "", "Alice Rivera"));

    await applyContactName(app, PATH, "alice", "Alice Smith");

    const out = app.vault.files.get(PATH)!;
    expect(out).toContain("# Alice Smith");
    expect(out).not.toContain("# Alice Rivera");
    expect(out).toContain("Alice Smith");
  });

  it("still refuses to touch a heading the user rewrote, even on a rename", async () => {
    app.vault.files.set(PATH, note("# my best lead", "", "Alice Rivera"));

    await applyContactName(app, PATH, "alice", "Alice Smith");

    const out = app.vault.files.get(PATH)!;
    expect(out).toContain("# my best lead");
    expect(out).not.toContain("# Alice Smith");
    // The frontmatter is ours, so it still updates.
    expect(out).toMatch(/name: ['"]?Alice Smith/);
  });

  // --- frontmatter order ------------------------------------------------------

  function keys(text: string): string[] {
    const block = text.slice(4, text.indexOf("\n---", 3));
    return block
      .split("\n")
      .map((l) => l.match(/^([A-Za-z0-9_-]+):/)?.[1])
      .filter((k): k is string => Boolean(k));
  }

  it("puts the name at the top rather than appending it under created", async () => {
    // What prompted this: processFrontMatter appends an unknown key, so `name`
    // landed below `created` and `igsid`.
    app.vault.files.set(
      PATH,
      `---\nigsid: "IG_1"\nusername: "alice"\nfunnel: New\ntags: []\ncreated: 2026-08-01 10:00\n---\n\n# @alice\n`,
    );

    await applyContactName(app, PATH, "alice", "Alice Smith");

    expect(keys(app.vault.files.get(PATH)!)).toEqual([
      "name",
      "username",
      "funnel",
      "tags",
      "created",
      "igsid",
    ]);
  });

  it("keeps a key the user added, after ours", async () => {
    // Dropping someone's own field to satisfy an ordering rule would be far
    // worse than a stale order.
    app.vault.files.set(
      PATH,
      `---\nigsid: "IG_1"\nusername: "alice"\nfunnel: New\ndeal_size: 4200\nphone: "+90 555"\n---\n\n# @alice\n`,
    );

    await applyContactName(app, PATH, "alice", "Alice Smith");

    const out = app.vault.files.get(PATH)!;
    const k = keys(out);
    expect(k).toEqual(["name", "username", "funnel", "igsid", "deal_size", "phone"]);
    expect(out).toContain("4200");
    expect(out).toContain("+90 555");
  });

  it("does not rewrite an out-of-order note just to reorder it", async () => {
    // The regression this replaces: including the key order in the early return
    // meant every note created before the order existed was rewritten on the
    // first tick after an upgrade, across the whole vault, for a cosmetic change.
    // The order rides along with writes that were happening anyway.
    const before =
      `---\nigsid: "IG_1"\nusername: "alice"\ncreated: 2026-08-01 10:00\nname: Alice Smith\n---\n\n# Alice Smith\n`;
    app.vault.files.set(PATH, before);
    const writes = countWrites(app);

    await applyContactName(app, PATH, "alice", "Alice Smith");

    expect(writes).toEqual({ frontmatter: 0, body: 0 });
    expect(app.vault.files.get(PATH)).toBe(before);
  });
});
