import { beforeEach, describe, expect, it } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import { conversationFolder, profileNotePath, resolveConversation } from "../src/vault";

function seedProfile(app: App, path: string, igsid: string) {
  app.vault.files.set(
    path,
    `---\nplatform: Instagram\nigsid: "${igsid}"\nusername: "peer"\nstatus: New\n---\n\n# @peer\n`,
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
    expect(ref!.status).toBe("New");
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
    expect(ref!.status).toBe("Pending");
    expect(ref!.username).toBe("peer");
  });

  it("resolves from a TFolder pointing at the @user folder", async () => {
    seedProfile(app, "CRM/Done/@peer/@peer.md", "IG_PEER");
    const folder = app.vault.getAbstractFileByPath("CRM/Done/@peer") as TFolder;
    const ref = await resolveConversation(app as any, "CRM", folder);
    expect(ref).not.toBeNull();
    expect(ref!.status).toBe("Done");
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
});

describe("conversationFolder / profileNotePath", () => {
  it("builds the correct paths regardless of status case", () => {
    expect(conversationFolder("CRM", "new", "peer")).toBe("CRM/New/@peer");
    expect(conversationFolder("CRM", "PENDING", "peer")).toBe("CRM/PENDING/@peer");
    expect(profileNotePath("CRM", "done", "peer")).toBe("CRM/Done/@peer/@peer.md");
  });

  it("sanitizes usernames with disallowed characters", () => {
    // safe() collapses characters outside [A-Za-z0-9._@-] to _
    expect(conversationFolder("CRM", "new", "bad name!"))
      .toBe("CRM/New/@bad_name");
  });
});
