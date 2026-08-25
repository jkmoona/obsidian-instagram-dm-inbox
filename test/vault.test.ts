import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import {
  conversationFolder,
  findConversation,
  localStamp,
  funnelHubPath,
  syncFunnelHubs,
  migrateToV02Layout,
  moveConversation,
  needsV02Migration,
  onDiskUsername,
  profileNotePath,
  resolveConversation,
  updateProfileRecentMessages,
  writeMessageNote,
} from "../src/vault";
import type { InboxMessage } from "../src/types";

function seedProfile(app: App, path: string, igsid: string) {
  app.vault.files.set(
    path,
    `---\nplatform: Instagram\nigsid: "${igsid}"\nusername: "peer"\nfunnel: New\n---\n\n# @peer\n`,
  );
  app.vault.folders.add(path.split("/").slice(0, -1).join("/"));
}

describe("resolveConversation", () => {
  let app: App;
  beforeEach(() => {
    app = new App();
  });

  it("resolves from a profile TFile", async () => {
    seedProfile(app, "CRM/New/@peer/@peer.md", "IG_PEER");
    const file = app.vault.getAbstractFileByPath("CRM/New/@peer/@peer.md") as TFile;
    const ref = await resolveConversation(app as any, "CRM", file);
    expect(ref).not.toBeNull();
    expect(ref!.funnel).toBe("New");
    expect(ref!.username).toBe("peer");
    expect(ref!.igsid).toBe("IG_PEER");
    expect(ref!.profilePath).toBe("CRM/New/@peer/@peer.md");
  });

  it("resolves from a message TFile inside the conversation", async () => {
    seedProfile(app, "CRM/Pending/@peer/@peer.md", "IG_PEER");
    app.vault.files.set(
      "CRM/Pending/@peer/2026-07-18 - hi.md",
      "---\nmid: x\n---\n\nhi\n",
    );
    const file = app.vault.getAbstractFileByPath(
      "CRM/Pending/@peer/2026-07-18 - hi.md",
    ) as TFile;
    const ref = await resolveConversation(app as any, "CRM", file);
    expect(ref).not.toBeNull();
    expect(ref!.funnel).toBe("Pending");
    expect(ref!.username).toBe("peer");
  });

  it("resolves from a message TFile inside _history/", async () => {
    seedProfile(app, "CRM/Pending/@peer/@peer.md", "IG_PEER");
    app.vault.files.set(
      "CRM/Pending/@peer/_history/2026-07-18 - hi.md",
      "---\nmid: x\n---\n\nhi\n",
    );
    const file = app.vault.getAbstractFileByPath(
      "CRM/Pending/@peer/_history/2026-07-18 - hi.md",
    ) as TFile;
    const ref = await resolveConversation(app as any, "CRM", file);
    expect(ref).not.toBeNull();
    expect(ref!.funnel).toBe("Pending");
    expect(ref!.username).toBe("peer");
  });

  it("resolves from the _history TFolder itself", async () => {
    seedProfile(app, "CRM/New/@peer/@peer.md", "IG_PEER");
    app.vault.folders.add("CRM/New/@peer/_history");
    const folder = app.vault.getAbstractFileByPath("CRM/New/@peer/_history") as TFolder;
    const ref = await resolveConversation(app as any, "CRM", folder);
    expect(ref).not.toBeNull();
    expect(ref!.username).toBe("peer");
  });

  it("resolves from a TFolder pointing at the @user folder", async () => {
    seedProfile(app, "CRM/Done/@peer/@peer.md", "IG_PEER");
    const folder = app.vault.getAbstractFileByPath("CRM/Done/@peer") as TFolder;
    const ref = await resolveConversation(app as any, "CRM", folder);
    expect(ref).not.toBeNull();
    expect(ref!.funnel).toBe("Done");
    expect(ref!.username).toBe("peer");
  });

  it("returns null for a file outside the CRM folder", async () => {
    app.vault.files.set("OTHER/note.md", "");
    const file = app.vault.getAbstractFileByPath("OTHER/note.md") as TFile;
    const ref = await resolveConversation(app as any, "CRM", file);
    expect(ref).toBeNull();
  });

  it("returns null when profile note is missing", async () => {
    // Only a message file, no profile
    app.vault.files.set("CRM/New/@ghost/2026-07-18 - hi.md", "");
    const file = app.vault.getAbstractFileByPath(
      "CRM/New/@ghost/2026-07-18 - hi.md",
    ) as TFile;
    const ref = await resolveConversation(app as any, "CRM", file);
    expect(ref).toBeNull();
  });

  it("returns null for a folder that isn't an @user folder", async () => {
    app.vault.folders.add("CRM/New/notauser");
    const folder = app.vault.getAbstractFileByPath("CRM/New/notauser") as TFolder;
    const ref = await resolveConversation(app as any, "CRM", folder);
    expect(ref).toBeNull();
  });

  it("resolves a note the user filed into their own subfolder", async () => {
    // The folder is the conversation, so anything inside it belongs to it. A
    // tighter bound than 0.1.x had meant right-clicking a note in, say,
    // @peer/attachments/ answered "not inside one of your conversations".
    seedProfile(app, "CRM/New/@peer/@peer.md", "IG_PEER");
    app.vault.folders.add("CRM/New/@peer/attachments");
    app.vault.files.set("CRM/New/@peer/attachments/quote notes.md", "mine\n");
    const file = app.vault.getAbstractFileByPath(
      "CRM/New/@peer/attachments/quote notes.md",
    ) as TFile;

    const ref = await resolveConversation(app as any, "CRM", file);

    expect(ref).not.toBeNull();
    expect(ref!.funnel).toBe("New");
    expect(ref!.username).toBe("peer");
  });

  it("resolves a subfolder of a conversation, not just _history", async () => {
    seedProfile(app, "CRM/New/@peer/@peer.md", "IG_PEER");
    app.vault.folders.add("CRM/New/@peer/attachments");
    const folder = app.vault.getAbstractFileByPath("CRM/New/@peer/attachments") as TFolder;
    expect(await resolveConversation(app as any, "CRM", folder)).not.toBeNull();
  });

  it("still rejects the stage folder itself", async () => {
    seedProfile(app, "CRM/New/@peer/@peer.md", "IG_PEER");
    app.vault.folders.add("CRM/New");
    const folder = app.vault.getAbstractFileByPath("CRM/New") as TFolder;
    expect(await resolveConversation(app as any, "CRM", folder)).toBeNull();
  });

  it("resolves under a multi-segment CRM folder", async () => {
    // The old parse did parts.indexOf(crmFolder), which can never match a
    // folder setting that itself contains a slash.
    seedProfile(app, "Work/CRM/New/@peer/@peer.md", "IG_PEER");
    const file = app.vault.getAbstractFileByPath("Work/CRM/New/@peer/@peer.md") as TFile;
    const ref = await resolveConversation(app as any, "Work/CRM", file);
    expect(ref).not.toBeNull();
    expect(ref!.funnel).toBe("New");
    expect(ref!.igsid).toBe("IG_PEER");
  });

  it("matches the folder as a path prefix, not a substring", async () => {
    seedProfile(app, "Work/CRMx/New/@peer/@peer.md", "IG_PEER");
    const file = app.vault.getAbstractFileByPath("Work/CRMx/New/@peer/@peer.md") as TFile;
    expect(await resolveConversation(app as any, "Work/CRM", file)).toBeNull();
  });

  it("ignores a same-named folder that isn't at the configured root", async () => {
    // indexOf found the first "CRM" segment anywhere, so a vault with its own
    // Projects/CRM tree had those files resolve as conversations.
    seedProfile(app, "Projects/CRM/New/@peer/@peer.md", "IG_PEER");
    const file = app.vault.getAbstractFileByPath("Projects/CRM/New/@peer/@peer.md") as TFile;
    expect(await resolveConversation(app as any, "CRM", file)).toBeNull();
  });
});

describe("conversationFolder / profileNotePath", () => {
  it("builds the correct paths regardless of funnel case", () => {
    expect(conversationFolder("CRM", "new", "peer")).toBe("CRM/New/@peer");
    expect(conversationFolder("CRM", "PENDING", "peer")).toBe("CRM/PENDING/@peer");
    expect(profileNotePath("CRM", "done", "peer")).toBe("CRM/Done/@peer/@peer.md");
  });

  it("sanitizes usernames with disallowed characters", () => {
    // safe() collapses characters outside [A-Za-z0-9._@-] to _
    expect(conversationFolder("CRM", "new", "bad name!"))
      .toBe("CRM/New/@bad_name");
  });

  it("keeps edge underscores, which distinguish two real accounts", () => {
    // Instagram allows leading and trailing underscores, so "_alice_" and
    // "alice" are different people. Trimming them filed both into one folder
    // and merged their conversations.
    expect(conversationFolder("CRM", "new", "_alice_")).toBe("CRM/New/@_alice_");
    expect(conversationFolder("CRM", "new", "alice")).toBe("CRM/New/@alice");
    expect(profileNotePath("CRM", "new", "_alice_")).toBe("CRM/New/@_alice_/@_alice_.md");
  });
});

describe("finding a conversation named by an older version", () => {
  // Vaults built before 0.2.0 trimmed edge underscores, so "_alice_" lives in
  // @alice. The fallback has to reach those folders without ever merging two
  // accounts that happen to trim to the same name.
  const OWNED_BY_UNDERSCORED =
    `---\nigsid: "IG1"\nusername: "_alice_"\nfunnel: New\n---\n\n# @alice\n`;
  const OWNED_BY_PLAIN = `---\nigsid: "IG2"\nusername: "alice"\nfunnel: New\n---\n\n# @alice\n`;

  function seedLegacyFolder(app: App, body: string) {
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/New");
    app.vault.folders.add("CRM/New/@alice");
    app.vault.files.set("CRM/New/@alice/@alice.md", body);
  }

  it("adopts the legacy folder when its profile says it is that contact", async () => {
    const app = new App();
    seedLegacyFolder(app, OWNED_BY_UNDERSCORED);
    expect(findConversation(app as any, "CRM", "_alice_")).toBe("New");
    expect(await onDiskUsername(app as any, "CRM", "_alice_")).toBe("alice");
  });

  it("refuses the legacy folder when it belongs to a different account", async () => {
    // The whole point: @alice here is genuinely "alice", so "_alice_" must get
    // its own folder rather than having its DMs merged into someone else's.
    const app = new App();
    seedLegacyFolder(app, OWNED_BY_PLAIN);
    expect(findConversation(app as any, "CRM", "_alice_")).toBeNull();
    expect(await onDiskUsername(app as any, "CRM", "_alice_")).toBe("_alice_");
  });

  it("still resolves a contact whose name needs no fallback", async () => {
    const app = new App();
    seedLegacyFolder(app, OWNED_BY_PLAIN);
    expect(findConversation(app as any, "CRM", "alice")).toBe("New");
    expect(await onDiskUsername(app as any, "CRM", "alice")).toBe("alice");
  });

  it("reads the note when the metadata cache has not caught up", async () => {
    // The cache is not built at startup. Answering "not found" there sent the
    // contact to a brand-new folder under the corrected spelling, so they ended
    // up with two folders and neither ever merged back.
    const app = new App();
    seedLegacyFolder(app, OWNED_BY_UNDERSCORED);
    app.metadataCache.coldPaths.add("CRM/New/@alice/@alice.md");

    expect(await onDiskUsername(app as any, "CRM", "_alice_")).toBe("alice");
  });

  it("still refuses someone else's folder on a cold cache", async () => {
    const app = new App();
    seedLegacyFolder(app, OWNED_BY_PLAIN);
    app.metadataCache.coldPaths.add("CRM/New/@alice/@alice.md");

    expect(await onDiskUsername(app as any, "CRM", "_alice_")).toBe("_alice_");
  });

  it("prefers a correctly named folder over the legacy one", async () => {
    const app = new App();
    seedLegacyFolder(app, OWNED_BY_UNDERSCORED);
    app.vault.folders.add("CRM/Done/@_alice_");
    app.vault.folders.add("CRM/Done");
    app.vault.files.set("CRM/Done/@_alice_/@_alice_.md", OWNED_BY_UNDERSCORED);
    expect(findConversation(app as any, "CRM", "_alice_")).toBe("Done");
    expect(await onDiskUsername(app as any, "CRM", "_alice_")).toBe("_alice_");
  });
});

const TS = Date.UTC(2026, 6, 18, 12, 3); // 2026-07-18 12:03Z

function makeMsg(text: string, mid = "MID1"): InboxMessage {
  return {
    id: "row1",
    mid,
    sender_igsid: "IG_PEER",
    sender_username: "peer",
    timestamp_ms: TS,
    text,
  };
}

describe("writeMessageNote filename collisions", () => {
  it("gives every repeat of the same text on one day its own file", async () => {
    // Found by the load test: the old scheme fell back to the first 10
    // characters of the mid, which real Instagram ids share, so the third
    // repeat had no free name, vault.create threw, and the message was
    // eventually dropped as unwritable.
    const app = new App();
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      paths.push(await writeMessageNote(app as any, "CRM", "new", makeMsg("hey", `MID${i}`)));
    }
    expect(new Set(paths).size).toBe(6);
    for (const p of paths) expect(app.vault.files.has(p)).toBe(true);
  });

  it("keeps the first note's name clean", async () => {
    const app = new App();
    const first = await writeMessageNote(app as any, "CRM", "new", makeMsg("hey", "M1"));
    await writeMessageNote(app as any, "CRM", "new", makeMsg("hey", "M2"));
    expect(first).toMatch(/ - hey\.md$/);
  });
});

describe("writeMessageNote (v0.2.0 layout)", () => {
  it("writes message notes into _history/ with only a readable date property", async () => {
    const app = new App();
    const path = await writeMessageNote(app as any, "CRM", "new", makeMsg("hey there"));
    const localDate = localStamp(TS).slice(0, 10);
    expect(path).toBe(`CRM/New/@peer/_history/${localDate} - hey there.md`);
    const body = app.vault.files.get(path)!;
    expect(body).toContain(`date: ${localStamp(TS)}`);
    expect(body).toContain("From [[@peer]]");
    expect(body).toContain("hey there");
    expect(body).not.toContain("mid:");
    expect(body).not.toContain("platform:");
    expect(body).not.toContain("timestamp:");
    expect(body).not.toContain("preview:");
  });
});

const PROFILE_WITH_BLOCK =
  `---\nplatform: Instagram\nigsid: "IG_PEER"\nusername: "peer"\nfunnel: New\ntags: []\n---\n\n` +
  `# @peer\n\n` +
  `<!-- igcrm:recent-start -->\n## Recent messages\n\n<!-- igcrm:recent-end -->\n\n` +
  `## Notes\n\nmy precious human-written note\n`;

describe("updateProfileRecentMessages", () => {
  let app: App;
  const profilePath = "CRM/New/@peer/@peer.md";
  beforeEach(() => {
    app = new App();
  });

  const HIST = "CRM/New/@peer/_history";
  const entryFor = (basename: string, ts = TS) => ({
    timestampMs: ts,
    notePath: `${HIST}/${basename}`,
    label: basename,
  });

  it("adds entries inside the delimited block without touching user content", async () => {
    app.vault.files.set(profilePath, PROFILE_WITH_BLOCK);
    await updateProfileRecentMessages(app as any, profilePath, [entryFor("2026-07-18 - hey there")]);
    const text = app.vault.files.get(profilePath)!;
    // Label without the date: the line already carries the timestamp.
    expect(text).toContain(`- ${localStamp(TS)} [[${HIST}/2026-07-18 - hey there|hey there]]`);
    expect(text).toContain("my precious human-written note");
    expect(text).toContain("## Notes");
  });

  it("is idempotent and deterministic for repeated updates", async () => {
    app.vault.files.set(profilePath, PROFILE_WITH_BLOCK);
    const entry = entryFor("2026-07-18 - hey there");
    await updateProfileRecentMessages(app as any, profilePath, [entry]);
    const once = app.vault.files.get(profilePath)!;
    await updateProfileRecentMessages(app as any, profilePath, [entry]);
    const twice = app.vault.files.get(profilePath)!;
    expect(twice).toBe(once);
  });

  it("caps the list at the limit, newest first", async () => {
    app.vault.files.set(profilePath, PROFILE_WITH_BLOCK);
    const entries = Array.from({ length: 5 }, (_, i) => entryFor(`note-${i}`, TS + i * 60000));
    await updateProfileRecentMessages(app as any, profilePath, entries, 3);
    const text = app.vault.files.get(profilePath)!;
    expect(text).toContain("note-4]]");
    expect(text).toContain("note-2]]");
    expect(text).not.toContain("note-1]]");
    expect(text.indexOf("note-4]]")).toBeLessThan(text.indexOf("note-2]]"));
  });

  it("inserts the block above ## Notes when a pre-v0.2.0 profile lacks it", async () => {
    const legacyProfile =
      `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\n# @peer\n\n## Notes\n\nkeep me\n`;
    app.vault.files.set(profilePath, legacyProfile);
    await updateProfileRecentMessages(app as any, profilePath, [entryFor("2026-07-18 - hey there")]);
    const text = app.vault.files.get(profilePath)!;
    expect(text).toContain("<!-- igcrm:recent-start -->");
    expect(text).toContain("keep me");
    expect(text.indexOf("Recent messages")).toBeLessThan(text.indexOf("## Notes"));
  });

  it("preserves existing entries in a CRLF-converted profile", async () => {
    app.vault.files.set(profilePath, PROFILE_WITH_BLOCK);
    await updateProfileRecentMessages(app as any, profilePath, [entryFor("first")]);
    // Simulate an external tool (git autocrlf, Windows editor) converting to CRLF.
    app.vault.files.set(profilePath, app.vault.files.get(profilePath)!.replace(/\n/g, "\r\n"));
    await updateProfileRecentMessages(app as any, profilePath, [
      entryFor("second", TS + 60000),
    ]);
    const text = app.vault.files.get(profilePath)!;
    expect(text).toContain("first]]");
    expect(text).toContain("second]]");
  });
});

describe("moveConversation (folder-aware)", () => {
  it("converges profile YAML when the source folder is already gone", async () => {
    // Conversation already sits at the destination (manual drag or a prior
    // partial move); the profile YAML must still be updated or the watcher
    // would later read the stale funnel as user intent and move it back.
    const app = new App();
    app.vault.files.set(
      "CRM/Pending/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\n# @peer\n`,
    );
    app.vault.folders.add("CRM/Pending/@peer");

    await moveConversation(app as any, "CRM", "peer", "New", "Pending");

    expect(app.vault.files.get("CRM/Pending/@peer/@peer.md")).toContain("funnel: Pending");
  });

  it("uses the stage folder's own casing at both ends", async () => {
    // Stage folders are created lazily, the shipped stage names are lowercase,
    // and the docs tell people to drag conversations between stage folders, so a
    // hand-made lowercase folder is ordinary rather than exotic.
    //
    // funnelFolderName upper-cases the first letter and getAbstractFileByPath is
    // exact-case, so every path rebuilt from a stage name missed these folders.
    // The source lookup decided there was nothing to move and the destination
    // stamp landed on a note that did not exist — a move that reported success,
    // left the folder and the note disagreeing, and never converged.
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/pending");
    app.vault.folders.add("CRM/shipped");
    app.vault.folders.add("CRM/pending/@peer");
    app.vault.folders.add("CRM/pending/@peer/_history");
    app.vault.files.set(
      "CRM/pending/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: pending\n---\n\n# @peer\n`,
    );
    app.vault.files.set("CRM/pending/@peer/_history/2026-07-18 - hi.md", "---\nmid: x\n---\n\nhi\n");

    const newProfile = await moveConversation(app as any, "CRM", "peer", "pending", "shipped");

    // Lands in the folder that exists, not in a title-cased sibling.
    expect(newProfile).toBe("CRM/shipped/@peer/@peer.md");
    expect(app.vault.files.has("CRM/shipped/@peer/@peer.md")).toBe(true);
    expect(app.vault.files.has("CRM/shipped/@peer/_history/2026-07-18 - hi.md")).toBe(true);
    expect(app.vault.files.has("CRM/pending/@peer/@peer.md")).toBe(false);
    expect(app.vault.folders.has("CRM/Shipped")).toBe(false);
    // And the note actually got stamped, which is what silently did not happen.
    expect(app.vault.files.get("CRM/shipped/@peer/@peer.md")).toMatch(/funnel:\s*['"]?shipped/i);
  });

  it("moves the whole conversation including _history/ to the new funnel", async () => {
    const app = new App();
    app.vault.files.set(
      "CRM/New/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\n# @peer\n`,
    );
    app.vault.files.set("CRM/New/@peer/_history/2026-07-18 - hi.md", "---\nmid: x\n---\n\nhi\n");
    app.vault.folders.add("CRM/New/@peer");
    app.vault.folders.add("CRM/New/@peer/_history");

    const newProfile = await moveConversation(app as any, "CRM", "peer", "New", "Pending");

    expect(newProfile).toBe("CRM/Pending/@peer/@peer.md");
    expect(app.vault.files.has("CRM/Pending/@peer/@peer.md")).toBe(true);
    expect(app.vault.files.has("CRM/Pending/@peer/_history/2026-07-18 - hi.md")).toBe(true);
    expect(app.vault.files.has("CRM/New/@peer/@peer.md")).toBe(false);
    expect(app.vault.files.has("CRM/New/@peer/_history/2026-07-18 - hi.md")).toBe(false);
    expect(app.vault.files.get("CRM/Pending/@peer/@peer.md")).toContain("funnel: Pending");
  });

  it("carries the user's own files and sections along with the conversation", async () => {
    // Whatever they keep in a conversation folder is theirs. A stage move must
    // relocate all of it and must not disturb anything outside the plugin's
    // own marker-fenced block.
    const app = new App();
    app.vault.files.set(
      "CRM/New/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: New\nclient: acme\n---\n\n# @peer\n\n` +
        `<!-- igcrm:recent-start -->\n## Recent messages\n\n<!-- igcrm:recent-end -->\n\n` +
        `## Notes\n\ndeal closes friday\n`,
    );
    app.vault.files.set("CRM/New/@peer/call notes.md", "agreed on Thursday\n");
    app.vault.files.set("CRM/New/@peer/quote.pdf", "binary-ish\n");
    app.vault.folders.add("CRM/New/@peer");

    await moveConversation(app as any, "CRM", "peer", "New", "Pending");

    expect(app.vault.files.get("CRM/Pending/@peer/call notes.md")).toBe("agreed on Thursday\n");
    expect(app.vault.files.has("CRM/Pending/@peer/quote.pdf")).toBe(true);
    const moved = app.vault.files.get("CRM/Pending/@peer/@peer.md")!;
    expect(moved).toContain("deal closes friday");
    // A frontmatter key they added, or one Dataview reads. processFrontMatter
    // reserialises the whole block, so this is the assertion that catches it
    // dropping keys it does not recognise.
    expect(moved).toMatch(/client:\s*acme/);
  });

  it("rewrites only inside its own markers when the recent block updates", async () => {
    const app = new App();
    const path = "CRM/New/@peer/@peer.md";
    app.vault.files.set(
      path,
      `---\nigsid: "IG_PEER"\nfunnel: New\ntheirField: keep me\n---\n\n# @peer\n\n` +
        `## My plan\n\ncall on monday\n\n` +
        `<!-- igcrm:recent-start -->\n## Recent messages\n\n<!-- igcrm:recent-end -->\n\n` +
        `## Notes\n\nhand written\n`,
    );
    app.vault.folders.add("CRM/New/@peer");

    await updateProfileRecentMessages(app as any, path, [
      { timestampMs: TS, notePath: "CRM/New/@peer/_history/2026-07-18 - hi", label: "hi" },
    ]);

    const body = app.vault.files.get(path)!;
    expect(body).toContain("theirField: keep me");
    expect(body).toContain("## My plan\n\ncall on monday");
    expect(body).toContain("hand written");
    expect(body).toContain("2026-07-18 - hi");
  });

  it("falls back to moving file by file when the folder rename throws", async () => {
    // The per-file fallback is what runs precisely when the vault is already
    // messy: after Obsidian Sync delivers a move from another device, or when a
    // folder-level rename fails. Every structural behaviour of it was unmeasured
    // — mutation testing showed the _history recursion, the trash-the-source
    // block, the per-file catch and the folder-rename catch could each be deleted
    // with the whole suite still green.
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/New");
    app.vault.folders.add("CRM/Pending");
    app.vault.folders.add("CRM/New/@peer");
    app.vault.folders.add("CRM/New/@peer/_history");
    app.vault.files.set(
      "CRM/New/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\n# @peer\n`,
    );
    app.vault.files.set("CRM/New/@peer/_history/2026-07-18 - hi.md", "---\nmid: a\n---\n\nhi\n");
    app.vault.files.set("CRM/New/@peer/_history/2026-07-19 - again.md", "---\nmid: b\n---\n\nagain\n");
    // Something the user put there themselves, which must travel too.
    app.vault.files.set("CRM/New/@peer/plan.md", "call on monday\n");

    // Fail only the folder-level rename, exactly as a locked directory would.
    const realRename = app.fileManager.renameFile.bind(app.fileManager);
    app.fileManager.renameFile = async (f: never, p: string) => {
      if ((f as unknown as { children?: unknown[] }).children !== undefined) {
        throw new Error("locked");
      }
      return realRename(f, p);
    };

    const newProfile = await moveConversation(app as any, "CRM", "peer", "New", "Pending");

    expect(newProfile).toBe("CRM/Pending/@peer/@peer.md");
    // Every file landed, once, including the nested history and the user's note.
    for (const p of [
      "CRM/Pending/@peer/@peer.md",
      "CRM/Pending/@peer/plan.md",
      "CRM/Pending/@peer/_history/2026-07-18 - hi.md",
      "CRM/Pending/@peer/_history/2026-07-19 - again.md",
    ]) {
      expect(app.vault.files.has(p), `missing ${p}`).toBe(true);
    }
    expect([...app.vault.files.keys()].filter((p) => p.startsWith("CRM/New/@peer"))).toEqual([]);
    // The emptied source folder is cleared away rather than left as a husk.
    expect(app.vault.folders.has("CRM/New/@peer")).toBe(false);
    // And the destination note carries the new stage.
    expect(app.vault.files.get(newProfile)).toMatch(/funnel:\s*['"]?Pending/i);
  });

  it("never overwrites a note already at the destination, and says what it left", async () => {
    // The other half of the fallback: a destination that already holds content.
    // Skipping a colliding child is deliberate — clobbering a note Sync or the
    // user put there is the one outcome worse than a leftover — so this asserts
    // skip-plus-signal rather than "the source is empty".
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/New/@peer");
    app.vault.folders.add("CRM/Pending/@peer");
    app.vault.files.set(
      "CRM/New/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\nsource copy\n`,
    );
    app.vault.files.set("CRM/New/@peer/only-here.md", "moves across\n");
    app.vault.files.set(
      "CRM/Pending/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: Pending\n---\n\nDESTINATION COPY\n`,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await moveConversation(app as any, "CRM", "peer", "New", "Pending");
    warn.mockRestore();

    // The destination body is untouched.
    expect(app.vault.files.get("CRM/Pending/@peer/@peer.md")).toContain("DESTINATION COPY");
    // A non-colliding child still moves.
    expect(app.vault.files.has("CRM/Pending/@peer/only-here.md")).toBe(true);
    // The collision is left behind rather than destroyed.
    expect(app.vault.files.has("CRM/New/@peer/@peer.md")).toBe(true);
    expect(app.vault.files.get("CRM/New/@peer/@peer.md")).toContain("source copy");
  });

  it("stamps the new funnel on the destination note, not the one left behind", async () => {
    // The ordinary shape after Obsidian Sync delivers a move made on another
    // device, or after a half-finished move: the conversation exists in BOTH
    // folders. moveChildrenInto skips any child whose destination is already
    // there, so the profile handle captured before the move never leaves the
    // source folder.
    const app = new App();
    for (const funnel of ["Pending", "Done"]) {
      app.vault.files.set(
        `CRM/${funnel}/@peer/@peer.md`,
        `---\nigsid: "IG_PEER"\nfunnel: Pending\n---\n\n# @peer\n`,
      );
      app.vault.folders.add(`CRM/${funnel}/@peer`);
    }

    await moveConversation(app as any, "CRM", "peer", "Pending", "Done");

    // Writing Done into the Pending note leaves the Done note contradicting its
    // own folder, and the watcher reads that as a hand edit and moves the whole
    // conversation back. That is the self-reverting-funnel bug.
    expect(app.vault.files.get("CRM/Done/@peer/@peer.md")).toMatch(/^funnel:\s*Done\s*$/m);
    expect(app.vault.files.get("CRM/Pending/@peer/@peer.md")).not.toMatch(/^funnel:\s*Done\s*$/m);
  });

  it("reads the igsid back after Obsidian reserialises the frontmatter", async () => {
    // processFrontMatter rewrites the whole block through Obsidian's YAML
    // dumper, which quotes an all-digits igsid so it cannot reparse as a
    // number. A reader that only strips double quotes captures the quote
    // characters as part of the id, and every request keyed on it then targets
    // a contact that does not exist.
    const app = new App();
    app.vault.files.set(
      "CRM/New/@peer/@peer.md",
      `---\nigsid: "3157963194593114"\nfunnel: New\n---\n\n# @peer\n`,
    );
    app.vault.folders.add("CRM/New/@peer");

    await moveConversation(app as any, "CRM", "peer", "New", "Pending");

    const moved = "CRM/Pending/@peer/@peer.md";
    expect(app.vault.files.get(moved)).toMatch(/^igsid: '3157963194593114'$/m);

    // Force the exact window the file-reading fallback exists for: straight
    // after a rename the metadata cache has nothing for the new path.
    app.metadataCache.coldPaths.add(moved);
    const ref = await resolveConversation(
      app as any,
      "CRM",
      app.vault.getAbstractFileByPath(moved) as never,
    );
    expect(ref?.igsid).toBe("3157963194593114");
  });
});

describe("v0.2.0 migration", () => {
  function seedLegacyVault(app: App) {
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/New");
    app.vault.folders.add("CRM/New/@peer");
    app.vault.files.set(
      "CRM/New/@peer/@peer.md",
      `---\nigsid: "IG_PEER"\nfunnel: New\n---\n\n# @peer\n\n## Notes\n\nhuman note\n`,
    );
    app.vault.files.set(
      "CRM/New/@peer/2026-07-18 - hey there.md",
      `---\nmid: "M1"\ntimestamp: ${TS}\n---\n\nFrom [[@peer]]\n\nhey there\n`,
    );
    app.vault.files.set("CRM/Inbox.canvas", `{"nodes":[],"edges":[]}`);
  }

  it("leaves the user's own notes where they put them", async () => {
    // A note the user keeps beside a conversation is theirs, not a DM the
    // plugin filed. Only notes carrying a `mid:` are the plugin's, and only
    // those move into _history/.
    const app = new App();
    seedLegacyVault(app);
    const mine = "CRM/New/@peer/call notes.md";
    app.vault.files.set(mine, "# Call notes\n\nagreed on Thursday\n");

    await migrateToV02Layout(app as any, {
      crmFolder: "CRM",
      canvasFile: "Inbox.canvas",
      canvasIsLegacyDefault: true,
    });

    expect(app.vault.files.has(mine)).toBe(true);
    expect(app.vault.files.has("CRM/New/@peer/_history/call notes.md")).toBe(false);
    // The real message note still moved.
    expect(app.vault.files.has("CRM/New/@peer/_history/2026-07-18 - hey there.md")).toBe(true);
  });

  it("does not ask to migrate a vault whose only flat note is the user's", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/New");
    app.vault.folders.add("CRM/New/@peer");
    app.vault.files.set("CRM/New/@peer/@peer.md", `---\nigsid: "IG"\nfunnel: New\n---\n`);
    app.vault.files.set("CRM/New/@peer/reminder.md", "ring them back\n");

    expect(await needsV02Migration(app as any, "CRM", false)).toBe(false);
  });

  it("still detects a 0.1.x vault when the metadata cache is cold", async () => {
    // The migration check runs at layout-ready, before the metadata cache is
    // necessarily built. Reading the `mid:` discriminator off the cache alone
    // answered "nothing to migrate" for a real 0.1.x vault, and the caller
    // latched that answer, so it was never converted and never asked again.
    const app = new App();
    seedLegacyVault(app);
    for (const path of app.vault.files.keys()) app.metadataCache.coldPaths.add(path);

    expect(await needsV02Migration(app as any, "CRM", false)).toBe(true);
  });

  it("needsV02Migration detects flat notes and legacy canvas", async () => {
    const app = new App();
    seedLegacyVault(app);
    expect(await needsV02Migration(app as any, "CRM", true)).toBe(true);

    const fresh = new App();
    fresh.vault.folders.add("CRM");
    expect(await needsV02Migration(fresh as any, "CRM", true)).toBe(false);
  });

  it("migrates flat notes into _history/, relocates canvas, seeds recent block", async () => {
    const app = new App();
    seedLegacyVault(app);

    const result = await migrateToV02Layout(app as any, {
      crmFolder: "CRM",
      canvasFile: "Inbox.canvas",
      canvasIsLegacyDefault: true,
    });

    expect(result.conversationsMigrated).toBe(1);
    expect(result.newCanvasFile).toBe("_meta/Inbox.canvas");
    expect(result.profiles).toEqual([
      { profilePath: "CRM/New/@peer/@peer.md", username: "peer" },
    ]);
    expect(app.vault.files.has("CRM/New/@peer/_history/2026-07-18 - hey there.md")).toBe(true);
    expect(app.vault.files.has("CRM/New/@peer/2026-07-18 - hey there.md")).toBe(false);
    expect(app.vault.files.has("CRM/_meta/Inbox.canvas")).toBe(true);
    expect(app.vault.files.has("CRM/Inbox.canvas")).toBe(false);
    expect(app.vault.files.has("CRM/_meta/Inbox.canvas.pre-v020.bak")).toBe(true);
    expect(app.vault.files.has("CRM/_meta/migration-v020.log")).toBe(true);

    const profile = app.vault.files.get("CRM/New/@peer/@peer.md")!;
    expect(profile).toContain("[[CRM/New/@peer/_history/2026-07-18 - hey there|hey there]]");
    expect(profile).toContain("human note");

    expect(await needsV02Migration(app as any, "CRM", false)).toBe(false);
  });

  it("is idempotent on a second run", async () => {
    const app = new App();
    seedLegacyVault(app);
    const opts = { crmFolder: "CRM", canvasFile: "Inbox.canvas", canvasIsLegacyDefault: true };
    await migrateToV02Layout(app as any, opts);
    const journalAfterFirst = app.vault.files.get("CRM/_meta/migration-v020.log")!;
    const profileAfterFirst = app.vault.files.get("CRM/New/@peer/@peer.md")!;

    const second = await migrateToV02Layout(app as any, {
      ...opts,
      canvasFile: "_meta/Inbox.canvas",
      canvasIsLegacyDefault: false,
    });

    expect(second.conversationsMigrated).toBe(0);
    expect(app.vault.files.get("CRM/_meta/migration-v020.log")).toBe(journalAfterFirst);
    expect(app.vault.files.get("CRM/New/@peer/@peer.md")).toBe(profileAfterFirst);
  });
});

describe("syncFunnelHubs", () => {
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

  it("writes one hub per funnel listing its contacts, sorted", async () => {
    const app = new App();
    seedContact(app, "New", "zoe");
    seedContact(app, "New", "alice");
    seedContact(app, "Done", "bob");

    await syncFunnelHubs(
      app as any,
      "CRM",
      new Map([
        ["New", ["zoe", "alice"]],
        ["Done", ["bob"]],
      ]),
    );

    const newHub = app.vault.files.get(funnelHubPath("CRM", "New"))!;
    expect(funnelHubPath("CRM", "New")).toBe("CRM/New/@New.md");
    expect(newHub.indexOf("[[@alice]]")).toBeLessThan(newHub.indexOf("[[@zoe]]"));
    expect(app.vault.files.get(funnelHubPath("CRM", "Done"))).toContain("[[@bob]]");
    expect(app.vault.files.get(funnelHubPath("CRM", "Done"))).not.toContain("[[@alice]]");
  });

  it("keeps a hand-made lowercase stage folder as it is on disk", async () => {
    // Re-deriving the name rebuilt "shipped" as "Shipped". On a case-insensitive
    // disk ensureFolder then throws, and the throw leaves the byFunnel loop, so
    // hub upkeep stopped for every stage after it.
    const app = new App();
    seedContact(app, "shipped", "alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["shipped", ["alice"]]]));

    expect(funnelHubPath("CRM", "shipped")).toBe("CRM/shipped/@shipped.md");
    expect(app.vault.files.get("CRM/shipped/@shipped.md")).toContain("[[@alice]]");
    expect(app.vault.files.has("CRM/Shipped/@Shipped.md")).toBe(false);
  });

  it("emits links that resolve to real profile notes", async () => {
    const app = new App();
    seedContact(app, "New", "alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice"]]]));

    const hub = app.vault.files.get(funnelHubPath("CRM", "New"))!;
    const targets = [...hub.matchAll(/\[\[([^\]|]+)\]\]/g)].map((m) => m[1]);
    expect(targets).toHaveLength(1);
    for (const t of targets) {
      // Bare basename links resolve via the conversation folder.
      const funnel = findConversation(app as any, "CRM", t.replace(/^@/, ""));
      expect(funnel).toBe("New");
    }
  });

  it("keeps text the user wrote outside the managed block", async () => {
    const app = new App();
    seedContact(app, "New", "alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice"]]]));
    const path = funnelHubPath("CRM", "New");
    app.vault.files.set(path, app.vault.files.get(path)! + "\nmy own thoughts\n");

    seedContact(app, "New", "bob");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice", "bob"]]]));

    const hub = app.vault.files.get(path)!;
    expect(hub).toContain("my own thoughts");
    expect(hub).toContain("[[@bob]]");
  });

  it("does not write again when nothing changed, even with a shuffled roster", async () => {
    const app = new App();
    seedContact(app, "New", "alice");
    seedContact(app, "New", "bob");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice", "bob"]]]));

    // Counts process() as well as modify(): syncFunnelHubs writes through
    // process() now, so a modify-only spy would count zero and pass while
    // testing nothing.
    let writes = 0;
    const realModify = app.vault.modify;
    const realProcess = app.vault.process;
    app.vault.modify = async (f: any, body: string) => {
      writes += 1;
      return realModify(f, body);
    };
    app.vault.process = async (f: any, fn: (d: string) => string) => {
      writes += 1;
      return realProcess(f, fn);
    };
    // Server order flips whenever someone messages; that must not cause a write.
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["bob", "alice"]]]));
    expect(writes).toBe(0);
  });

  it("drops a contact that moved and adds it to the new funnel", async () => {
    const app = new App();
    seedContact(app, "New", "alice");
    seedContact(app, "Done", "bob");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice"]], ["Done", ["bob"]]]));

    // alice moves to Done.
    app.vault.files.delete("CRM/New/@alice/@alice.md");
    app.vault.folders.delete("CRM/New/@alice");
    seedContact(app, "Done", "alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", []], ["Done", ["alice", "bob"]]]));

    expect(app.vault.files.get(funnelHubPath("CRM", "Done"))).toContain("[[@alice]]");
    // The New hub survives as a file, since the user may have written in it,
    // but it must stop linking a contact who is no longer in that folder. A
    // link to a note that isn't there renders unresolved and puts a phantom
    // node in the graph, which is the thing hubs exist to prevent.
    const newHub = app.vault.files.get(funnelHubPath("CRM", "New"));
    expect(newHub).toBeDefined();
    expect(newHub).not.toContain("[[@alice]]");
    expect(newHub).toContain("# New");
    expect(newHub).toContain("<!-- igcrm:contacts-start -->");
    expect(newHub).toContain("<!-- igcrm:contacts-end -->");
  });

  it("empties an existing hub without touching the user's own text", async () => {
    const app = new App();
    seedContact(app, "New", "alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice"]]]));
    const path = funnelHubPath("CRM", "New");
    app.vault.files.set(path, app.vault.files.get(path)! + "\nmy own thoughts\n");

    app.vault.files.delete("CRM/New/@alice/@alice.md");
    app.vault.folders.delete("CRM/New/@alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", []]]));

    const hub = app.vault.files.get(path)!;
    expect(hub).toContain("my own thoughts");
    expect(hub).toContain("## Notes");
    expect(hub).not.toContain("[[@");
  });

  it("does not rewrite a hub that is already empty", async () => {
    const app = new App();
    seedContact(app, "New", "alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice"]]]));
    await syncFunnelHubs(app as any, "CRM", new Map([["New", []]]));

    let writes = 0;
    const realModify = app.vault.modify;
    const realProcess = app.vault.process;
    app.vault.modify = async (f: any, body: string) => {
      writes += 1;
      return realModify(f, body);
    };
    app.vault.process = async (f: any, fn: (d: string) => string) => {
      writes += 1;
      return realProcess(f, fn);
    };
    // Pins one canonical spelling of the empty block. Two spellings would make
    // every tick rewrite the hub, which bumps mtime and re-fires the watcher.
    await syncFunnelHubs(app as any, "CRM", new Map([["New", []]]));
    expect(writes).toBe(0);
  });

  it("lists a duplicated username only once", async () => {
    const app = new App();
    seedContact(app, "New", "alice");
    await syncFunnelHubs(app as any, "CRM", new Map([["New", ["alice", "alice"]]]));
    const hub = app.vault.files.get(funnelHubPath("CRM", "New"))!;
    expect(hub.match(/\[\[@alice\]\]/g)).toHaveLength(1);
  });

  it("creates no hub for a funnel with no contacts", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    app.vault.folders.add("CRM/Pending");
    await syncFunnelHubs(app as any, "CRM", new Map([["Pending", []]]));
    expect(app.vault.files.has(funnelHubPath("CRM", "Pending"))).toBe(false);
  });
});
