import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { InboxMessage, statusFolderName } from "./types";

export interface ConversationRef {
  status: string;   // folder-cased, e.g. "Pending"
  username: string; // e.g. "ysffkaya" (without @)
  igsid: string;    // from the profile note YAML
  profilePath: string;
}

/**
 * Given an arbitrary file or folder inside a CRM conversation, return
 * the conversation's current status + username + igsid. Accepts either a
 * TFile (any file inside the conversation folder) or a TFolder (the
 * `@user/` folder itself). Returns null when the target isn't inside a
 * `${crmFolder}/<Status>/@user/` structure.
 */
export async function resolveConversation(
  app: App,
  crmFolder: string,
  target: TFile | TFolder,
): Promise<ConversationRef | null> {
  const parts = target.path.split("/");
  const crmIdx = parts.indexOf(crmFolder);
  if (crmIdx < 0) return null;
  // Locate the `@user` segment: parts[crmIdx+2] for a file inside it,
  // parts[crmIdx+2] for the folder itself, or parts[crmIdx+1] if the
  // caller passed the status folder (rejected below).
  let status: string;
  let userDir: string;
  if (target instanceof TFolder) {
    if (parts.length < crmIdx + 3) return null;
    status = parts[crmIdx + 1];
    userDir = parts[crmIdx + 2];
  } else {
    if (parts.length < crmIdx + 4) return null;
    status = parts[crmIdx + 1];
    userDir = parts[crmIdx + 2];
  }
  if (!userDir.startsWith("@")) return null;
  const username = userDir.slice(1);
  const profilePath = normalizePath(`${crmFolder}/${status}/${userDir}/${userDir}.md`);
  const profileFile = app.vault.getAbstractFileByPath(profilePath);
  if (!(profileFile instanceof TFile)) return null;
  const text = await app.vault.read(profileFile);
  const igsidMatch = text.match(/^igsid:\s*"?([^"\n]+)"?\s*$/m);
  const igsid = igsidMatch ? igsidMatch[1].trim() : "";
  return { status, username, igsid, profilePath };
}

const FILENAME_SAFE = /[^A-Za-z0-9._@-]+/g;

function safe(name: string): string {
  const stripped = name.replace(FILENAME_SAFE, "_").replace(/^_+|_+$/g, "");
  return stripped || "unknown";
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function filenamePreview(text: string, maxLen: number): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|#^\[\]]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLen).trim() || "message";
}

function ymdUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const path = normalizePath(folder);
  if (!(await app.vault.adapter.exists(path))) {
    await app.vault.createFolder(path);
  }
}

export function conversationFolder(crmFolder: string, status: string, username: string): string {
  return normalizePath(`${crmFolder}/${statusFolderName(status)}/@${safe(username)}`);
}

export function profileNotePath(crmFolder: string, status: string, username: string): string {
  return normalizePath(`${conversationFolder(crmFolder, status, username)}/@${safe(username)}.md`);
}

export async function ensureProfileNote(
  app: App,
  crmFolder: string,
  status: string,
  username: string,
  igsid: string,
): Promise<string> {
  const dir = conversationFolder(crmFolder, status, username);
  await ensureFolder(app, dir);
  const path = profileNotePath(crmFolder, status, username);
  if (await app.vault.adapter.exists(path)) {
    return path;
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const body =
    `---\n` +
    `platform: Instagram\n` +
    `igsid: "${escapeYaml(igsid)}"\n` +
    `username: "${escapeYaml(username)}"\n` +
    `status: ${status}\n` +
    `tags: []\n` +
    `created: ${now}\n` +
    `---\n\n` +
    `# @${username}\n\n` +
    `[Open on Instagram](https://instagram.com/${safe(username)})\n\n` +
    `## Notes\n\n`;
  await app.vault.create(path, body);
  return path;
}

export async function writeMessageNote(
  app: App,
  crmFolder: string,
  status: string,
  msg: InboxMessage,
): Promise<string> {
  const dir = conversationFolder(crmFolder, status, msg.sender_username);
  await ensureFolder(app, dir);
  const date = ymdUtc(msg.timestamp_ms);
  const previewForName = filenamePreview(msg.text, 40);
  let path = normalizePath(`${dir}/${date} - ${previewForName}.md`);
  if (await app.vault.adapter.exists(path)) {
    const tag = safe(msg.mid).slice(0, 10);
    path = normalizePath(`${dir}/${date} - ${previewForName} (${tag}).md`);
  }
  const iso = isoUtc(msg.timestamp_ms);
  const preview = escapeYaml(msg.text.slice(0, 80).replace(/[\r\n\t]+/g, " "));
  const body =
    `---\n` +
    `platform: Instagram\n` +
    `mid: "${escapeYaml(msg.mid)}"\n` +
    `timestamp: ${msg.timestamp_ms}\n` +
    `received: ${iso}\n` +
    `preview: "${preview}"\n` +
    `---\n\n` +
    `From [[@${safe(msg.sender_username)}]]\n\n` +
    `${msg.text}\n`;
  await app.vault.create(path, body);
  return path;
}

async function updateProfileStatus(app: App, profilePath: string, newStatus: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(profilePath);
  if (!(file instanceof TFile)) return;
  const text = await app.vault.read(file);
  const rewrote = text.replace(/^(status:\s*).*$/m, `$1${newStatus}`);
  const withStatus =
    rewrote === text && !/^status:/m.test(text)
      ? text.replace(/^---\n/, `---\nstatus: ${newStatus}\n`)
      : rewrote;
  if (withStatus !== text) {
    await app.vault.modify(file, withStatus);
  }
}

/**
 * Moves an entire conversation folder from CRM/<oldStatus>/@user/ to
 * CRM/<newStatus>/@user/. Uses `fileManager.renameFile` on each file so
 * wikilinks pointing into the folder auto-update. Returns the new profile
 * path so callers can update canvas node file references.
 */
export async function moveConversation(
  app: App,
  crmFolder: string,
  username: string,
  fromStatus: string,
  toStatus: string,
): Promise<string> {
  const oldDir = conversationFolder(crmFolder, fromStatus, username);
  const newDir = conversationFolder(crmFolder, toStatus, username);
  const newProfilePath = profileNotePath(crmFolder, toStatus, username);

  const oldFolder = app.vault.getAbstractFileByPath(oldDir);
  if (!(oldFolder instanceof TFolder)) {
    // Nothing to move; ensure destination exists so subsequent writes succeed.
    await ensureFolder(app, newDir);
    return newProfilePath;
  }

  // Ensure the full destination folder (including the @user subfolder)
  // exists — Obsidian's renameFile doesn't reliably create nested parents.
  await ensureFolder(app, newDir);

  const children = oldFolder.children.slice();
  for (const child of children) {
    if (!(child instanceof TFile)) continue;
    const target = normalizePath(`${newDir}/${child.name}`);
    if (await app.vault.adapter.exists(target)) continue;
    try {
      await app.fileManager.renameFile(child, target);
    } catch (e) {
      console.warn(`igcrm moveConversation: rename failed ${child.path} → ${target}`, e);
    }
  }
  if (oldFolder.children.length > 0) {
    console.warn(
      `igcrm moveConversation: ${oldFolder.children.length} item(s) remain in ${oldDir}:`,
      oldFolder.children.map((c) => c.path),
    );
  }

  // Delete empty old folder (best-effort).
  const stillThere = app.vault.getAbstractFileByPath(oldDir);
  if (stillThere instanceof TFolder && stillThere.children.length === 0) {
    try {
      await app.vault.delete(stillThere);
    } catch {
      // ignore
    }
  }

  await updateProfileStatus(app, newProfilePath, toStatus);
  return newProfilePath;
}

/**
 * One-time migration from the flat CRM/Profiles + CRM/Messages layout to
 * folder-per-status/per-user. Idempotent: does nothing if the legacy folders
 * are gone or empty.
 */
export async function migrateLegacyLayout(
  app: App,
  crmFolder: string,
  defaultStatus: string,
): Promise<number> {
  const legacyProfilesDir = normalizePath(`${crmFolder}/Profiles`);
  const legacyMessagesDir = normalizePath(`${crmFolder}/Messages`);

  const profilesFolder = app.vault.getAbstractFileByPath(legacyProfilesDir);
  const messagesFolder = app.vault.getAbstractFileByPath(legacyMessagesDir);
  if (!(profilesFolder instanceof TFolder) && !(messagesFolder instanceof TFolder)) {
    return 0;
  }

  const migratedUsers = new Set<string>();

  if (profilesFolder instanceof TFolder) {
    for (const child of profilesFolder.children.slice()) {
      if (!(child instanceof TFile) || !child.name.endsWith(".md")) continue;
      const base = child.name.replace(/\.md$/, "");
      const username = base.replace(/^@/, "");
      const dir = conversationFolder(crmFolder, defaultStatus, username);
      await ensureFolder(app, dir);
      const target = profileNotePath(crmFolder, defaultStatus, username);
      if (!(await app.vault.adapter.exists(target))) {
        await app.fileManager.renameFile(child, target);
        migratedUsers.add(username);
      }
    }
  }

  if (messagesFolder instanceof TFolder) {
    const filenameParse = /^(\d{4}-\d{2}-\d{2})\s+@([A-Za-z0-9._-]+)\s+-\s+(.+)\.md$/;
    for (const child of messagesFolder.children.slice()) {
      if (!(child instanceof TFile) || !child.name.endsWith(".md")) continue;
      const match = filenameParse.exec(child.name);
      if (!match) continue;
      const [, date, username, preview] = match;
      const dir = conversationFolder(crmFolder, defaultStatus, username);
      await ensureFolder(app, dir);
      const target = normalizePath(`${dir}/${date} - ${preview}.md`);
      if (!(await app.vault.adapter.exists(target))) {
        await app.fileManager.renameFile(child, target);
        migratedUsers.add(username);
      }
    }
  }

  // Clean up now-empty legacy folders.
  for (const legacy of [profilesFolder, messagesFolder]) {
    if (legacy instanceof TFolder && legacy.children.length === 0) {
      try {
        await app.vault.delete(legacy);
      } catch {
        // ignore
      }
    }
  }

  if (migratedUsers.size > 0) {
    new Notice(`Migrated ${migratedUsers.size} conversation${migratedUsers.size === 1 ? "" : "s"} to new layout`);
  }
  return migratedUsers.size;
}
