import { App, Notice, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { InboxMessage, funnelFolderName } from "./types";
import { debugLog, logWarn } from "./log";

/** Subfolder inside each `@user/` conversation holding one note per DM. */
export const HISTORY_FOLDER = "_history";
/** Folder at the top of the CRM tree for plugin-managed files (canvas, logs). */
export const META_FOLDER = "_meta";

export interface ConversationRef {
  funnel: string;   // folder-cased, e.g. "Pending"
  username: string; // e.g. "alice" (without @)
  igsid: string;    // from the profile note YAML
  profilePath: string;
}

/**
 * A file's cached frontmatter, as a record of unknowns.
 *
 * Obsidian types `CachedMetadata.frontmatter` as `any`, so reading a key off it
 * spreads `any` through whatever it touches, and the 0.2.0 community review
 * flagged eleven such sites under no-unsafe-assignment, no-unsafe-argument and
 * no-unsafe-member-access. Narrowing once here means every caller gets `unknown`
 * and has to check the type it wants, which those callers already did.
 */
function frontmatterOf(app: App, file: TFile): Record<string, unknown> | undefined {
  return app.metadataCache.getFileCache(file)?.frontmatter;
}

/**
 * Read `funnel:` from the file itself, or null when it has no such key.
 *
 * The metadata cache is debounced, so just after a write it still serves the
 * previous frontmatter. A caller that would act destructively on a divergence
 * has to confirm against the file. `read`, not `cachedRead`: the cache is the
 * same stale source.
 *
 * Bounded to the leading `---` block on purpose. An unbounded match is what
 * once rewrote a `funnel:` line in a note's body, described on setProfileFunnel.
 */
export async function funnelOnDisk(app: App, file: TFile): Promise<string | null> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await app.vault.read(file));
  if (!block) return null;
  for (const line of block[1].split(/\r?\n/)) {
    const match = /^funnel:\s*(.*)$/.exec(line);
    if (!match) continue;
    return match[1].trim().replace(/^["']|["']$/g, "").trim() || null;
  }
  return null;
}

/**
 * Given an arbitrary file or folder inside a conversation, return
 * the conversation's current funnel + username + igsid. Accepts a TFile
 * (the profile, a legacy flat message note, or a note inside `_history/`)
 * or a TFolder (the `@user/` folder or its `_history/` subfolder).
 * Returns null when the target isn't inside a
 * `${crmFolder}/<Funnel>/@user/` structure.
 */
export async function resolveConversation(
  app: App,
  crmFolder: string,
  target: TFile | TFolder,
): Promise<ConversationRef | null> {
  // Prefix match, not a segment search: the folder setting may itself contain
  // slashes ("Work/CRM"), and a same-named folder elsewhere in the vault
  // ("Projects/CRM/...") must not resolve.
  const crm = normalizePath(crmFolder);
  if (!target.path.startsWith(crm + "/")) return null;
  const rel = target.path.slice(crm.length + 1).split("/");
  const [funnel, userDir] = rel;
  if (!funnel || !userDir || !userDir.startsWith("@")) return null;
  // Anything at or below the `@user` folder belongs to that conversation, at
  // any depth. Bounding it to the profile and `_history/` was tighter than the
  // 0.1.x parse and stopped the pickers recognising a note the user had filed
  // into their own subfolder, say `@alice/attachments/`. Being inside `@user`
  // is the whole test; the folder is the conversation.
  const depth = rel.length - 1;
  if (depth < (target instanceof TFolder ? 1 : 2)) return null;
  const username = userDir.slice(1);
  const profilePath = normalizePath(`${crmFolder}/${funnel}/${userDir}/${userDir}.md`);
  const profileFile = app.vault.getAbstractFileByPath(profilePath);
  if (!(profileFile instanceof TFile)) return null;
  // Cache first, file second. The cache is an in-memory hit and already
  // parsed; the read is the fallback for the window right after a create or
  // rename when the cache hasn't caught up. Falling through matters:
  // applyManualFunnel skips the server POST when igsid is empty, so a silent
  // miss would drop the funnel change on the floor.
  const cached: unknown = frontmatterOf(app, profileFile)?.igsid;
  let igsid =
    typeof cached === "string" ? cached.trim() : typeof cached === "number" ? String(cached) : "";
  if (!igsid) {
    igsid = frontmatterScalar(await app.vault.cachedRead(profileFile), "igsid");
  }
  return { funnel, username, igsid, profilePath };
}

/**
 * Read one scalar out of a note's frontmatter.
 *
 * Bounded to the `---` block, so a line in the body can't impersonate a key,
 * and quote-agnostic on purpose. `processFrontMatter` reserialises the whole
 * block through Obsidian's YAML dumper, which quotes any value that would
 * otherwise reparse as something else: an all-digits igsid comes back
 * `igsid: '3157963194593114'` so it stays a string. A reader that only strips
 * double quotes captures the single quotes as part of the id, and every
 * request keyed on it then targets a contact that does not exist.
 */
function frontmatterScalar(text: string, key: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return "";
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block);
  if (!m) return "";
  return m[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
}

/**
 * A user-typed vault path, cleaned, or the fallback when nothing usable
 * remains. `normalizePath` returns "/" for an empty path, so a plain
 * truthiness check would let the vault root through and every
 * `startsWith(folder + "/")` test downstream would go quietly dead.
 */
export function cleanPath(value: unknown, fallback: string): string {
  const p = normalizePath(String(value ?? "").trim());
  return p && p !== "/" ? p : fallback;
}

const FILENAME_SAFE = /[^A-Za-z0-9._@-]+/g;

/**
 * Folder-safe form of an Instagram handle. Lossless for every legal handle:
 * Instagram allows only [A-Za-z0-9._], so nothing a real username contains is
 * substituted, and underscores stay where they are. That last part matters:
 * "_alice_" and "alice" are different accounts, and an edge-trim would file
 * them into the same conversation folder. Only illegal junk is trimmed from
 * the edges, then substituted inside.
 */
function safe(name: string): string {
  const stripped = name
    .replace(/^[^A-Za-z0-9._@-]+|[^A-Za-z0-9._@-]+$/g, "")
    .replace(FILENAME_SAFE, "_");
  return stripped || "unknown";
}

/**
 * The sanitizer every release up to 0.2.0 shipped, byte for byte: it also
 * trimmed edge underscores, so it names the folders existing vaults actually
 * have. Kept only so those folders stay findable; never used for new names.
 */
function legacySafe(name: string): string {
  const stripped = name.replace(FILENAME_SAFE, "_").replace(/^_+|_+$/g, "");
  return stripped || "unknown";
}

/** Human-readable local-time stamp: "2026-07-18 14:03". Used everywhere a
 *  timestamp is user-visible (note YAML, filenames, recent-messages block). */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function localYmd(ms: number): string {
  return localStamp(ms).slice(0, 10);
}

/**
 * Escape a value for a double-quoted YAML scalar.
 *
 * Newlines and control characters matter more than they used to. Both the
 * igsid and the username come from the server, the username is interpolated
 * unsanitised, and a raw newline here splits the frontmatter into something
 * unparseable. That used to be survivable because the plugin only ever
 * regex-patched the block; now `processFrontMatter` parses it, and it throws on
 * that note every single time, so the conversation can never be moved again.
 */
function escapeYaml(s: string): string {
  return (
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      // Whatever control characters remain have no escape worth emitting; drop
      // them rather than write a block that cannot be parsed back. The three
      // that do have escapes are handled just above, so this cannot eat them.
      //
      // `\p{Cc}` rather than a literal range: spelling the range out puts
      // control escapes in the source, which `no-control-regex` flags and which
      // then needs suppressing, and the obvious range stops at U+001F while DEL
      // and the C1 block (U+007F-U+009F) are just as unprintable in YAML.
      .replace(/\p{Cc}/gu, "")
  );
}

function filenamePreview(text: string, maxLen: number): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLen).trim() || "message";
}

/**
 * Existence per the file index, which is what the Vault API answers from.
 *
 * Not identical to asking the filesystem: `getAbstractFileByPath` is
 * case-sensitive while the disk on macOS and Windows is not, so a path that
 * differs only in case reads as absent here and present to a `create`. Every
 * caller that follows this with a create has to tolerate the create throwing.
 */
function existsInVault(app: App, path: string): boolean {
  return app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
  const path = normalizePath(folder);
  if (app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
  try {
    await app.vault.createFolder(path);
  } catch (e) {
    // Already there under a different case, or created by a tick that
    // overlapped this one. Either way the folder exists, which is all the
    // caller needs.
    if (!(app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw e;
  }
}

export function conversationFolder(crmFolder: string, funnel: string, username: string): string {
  return conversationFolderIn(crmFolder, funnelFolderName(funnel), username);
}

/**
 * The same path, from a stage FOLDER name rather than a stage name.
 *
 * Anything already resolved against disk by `stageFolderSpelling` has to come
 * through here: `conversationFolder` runs its argument through
 * `funnelFolderName`, which would re-capitalise the very spelling that was just
 * read off the folder.
 */
export function conversationFolderIn(
  crmFolder: string,
  stageFolder: string,
  username: string,
): string {
  return normalizePath(`${crmFolder}/${stageFolder}/@${safe(username)}`);
}

export function profileNotePathIn(
  crmFolder: string,
  stageFolder: string,
  username: string,
): string {
  const dir = conversationFolderIn(crmFolder, stageFolder, username);
  return normalizePath(`${dir}/@${safe(username)}.md`);
}

/**
 * The stage name as the folder on disk actually spells it, or the derived
 * spelling when no such folder exists yet.
 *
 * `funnelFolderName` upper-cases the first letter, and `getAbstractFileByPath` is
 * exact-case, so a path rebuilt from a stage name misses a folder cased any other
 * way. That happens routinely rather than exotically: stage folders are created
 * lazily, the shipped stage names are lowercase, and the docs tell people to drag
 * conversations between stage folders, so a hand-made `Instagram DMs/shipped` is
 * ordinary. `funnelByFolderName` then accepts it case-insensitively while every
 * path built from it pointed at `Shipped`, and a move became a no-op that
 * reported success: the folder said one thing, the note kept saying another, and
 * it never converged.
 */
export function stageFolderSpelling(app: App, crmFolder: string, funnel: string): string {
  const derived = funnelFolderName(funnel);
  const root = app.vault.getAbstractFileByPath(normalizePath(crmFolder));
  if (!(root instanceof TFolder)) return derived;
  const want = derived.toLowerCase();
  for (const child of root.children) {
    if (child instanceof TFolder && child.name.toLowerCase() === want) return child.name;
  }
  return derived;
}

/**
 * Find which funnel folder a conversation actually sits in by scanning
 * `${crmFolder}/<Funnel>/@username`, or null when it isn't in the vault at
 * all. Reconciliation needs the real location, since a funnel recorded
 * elsewhere can be out of date.
 */
/** Scan the funnel folders for `@<dirName>/@<dirName>.md`, returning the
 *  funnel folder name and the profile TFile. */
function scanForProfile(
  app: App,
  crmFolder: string,
  dirName: string,
): { funnel: string; profile: TFile } | null {
  const root = app.vault.getAbstractFileByPath(normalizePath(crmFolder));
  if (!(root instanceof TFolder)) return null;
  const userDir = `@${dirName}`;
  for (const funnel of root.children) {
    if (!(funnel instanceof TFolder) || funnel.name.startsWith("_")) continue;
    const profile = app.vault.getAbstractFileByPath(
      normalizePath(`${funnel.path}/${userDir}/${userDir}.md`),
    );
    if (profile instanceof TFile) return { funnel: funnel.name, profile };
  }
  return null;
}

function locateConversation(
  app: App,
  crmFolder: string,
  username: string,
): { funnel: string; diskUsername: string } | null {
  const primary = safe(username);
  const hit = scanForProfile(app, crmFolder, primary);
  if (hit) return { funnel: hit.funnel, diskUsername: primary };
  // Vaults built before 0.2.0 named this folder with the edge underscores
  // trimmed. The frontmatter check is what makes the fallback safe to take:
  // the trimmed name may genuinely belong to a DIFFERENT account ("alice"),
  // and continuing there would merge two people's conversations, the very
  // bug the sanitizer change fixed.
  //
  // Cache-only here on purpose, because this is the synchronous read path and a
  // miss is harmless: it reports "not in the vault", the caller treats the
  // contact as new, and `onDiskUsername` resolves it properly, reading the note
  // if it has to. Anything that builds a path must go through that instead.
  const legacy = legacySafe(username);
  if (legacy !== primary) {
    const old = scanForProfile(app, crmFolder, legacy);
    if (old && frontmatterOf(app, old.profile)?.username === username) {
      return { funnel: old.funnel, diskUsername: legacy };
    }
  }
  return null;
}

export function findConversation(app: App, crmFolder: string, username: string): string | null {
  return locateConversation(app, crmFolder, username)?.funnel ?? null;
}

/**
 * The username spelling this contact's folder actually uses on disk, which for
 * a pre-0.2.0 vault may be the edge-trimmed legacy form. Path builders must be
 * fed this spelling or they fork a second folder for the contact.
 *
 * Async because the ownership check has to survive a cold metadata cache. The
 * cache is not built at startup, and answering "not found" there forks a
 * duplicate folder that never heals, so a cache miss falls back to reading the
 * note, the same order `resolveConversation` uses for the igsid.
 */
export async function onDiskUsername(
  app: App,
  crmFolder: string,
  username: string,
): Promise<string> {
  const primary = safe(username);
  if (scanForProfile(app, crmFolder, primary)) return primary;

  const legacy = legacySafe(username);
  if (legacy === primary) return username;
  const old = scanForProfile(app, crmFolder, legacy);
  if (!old) return username;

  // Whose folder is it? The trimmed name may genuinely belong to a different
  // account, and continuing there would merge two people's conversations.
  const cached = old.profile ? frontmatterOf(app, old.profile) : undefined;
  const owner =
    typeof cached?.username === "string"
      ? cached.username
      : frontmatterScalar(await app.vault.cachedRead(old.profile), "username");
  return owner === username ? legacy : username;
}

export function historyFolder(crmFolder: string, funnel: string, username: string): string {
  return normalizePath(`${conversationFolder(crmFolder, funnel, username)}/${HISTORY_FOLDER}`);
}

export function profileNotePath(crmFolder: string, funnel: string, username: string): string {
  return normalizePath(`${conversationFolder(crmFolder, funnel, username)}/@${safe(username)}.md`);
}

const RECENT_START = "<!-- igcrm:recent-start -->";
const RECENT_END = "<!-- igcrm:recent-end -->";
export const RECENT_LIMIT = 10;

export interface RecentEntry {
  timestampMs: number;
  notePath: string; // full vault path to the message note, without .md
  label: string;    // display alias (the note's basename)
}

/**
 * Drop the date a message note's filename starts with, since the line it goes on
 * already carries a full timestamp. Without this every entry read
 * "2026-08-11 17:32 [[...|2026-08-11 - hey]]", showing the date twice.
 *
 * Done here rather than where the label is built, so a profile that already has
 * dated labels is corrected the next time its block is rewritten: the labels are
 * parsed back out of the note, so they pass through this on the way in.
 */
function labelWithoutDate(label: string): string {
  return label.replace(/^\d{4}-\d{2}-\d{2} - /, "");
}

function renderRecentBlock(entries: RecentEntry[]): string {
  // Links are path-qualified: bare basenames collide across contacts.
  const lines = entries.map(
    (e) => `- ${localStamp(e.timestampMs)} [[${e.notePath}|${labelWithoutDate(e.label)}]]`,
  );
  return `${RECENT_START}\n## Recent messages\n\n${lines.join("\n")}\n${RECENT_END}`;
}

function parseRecentEntries(block: string): RecentEntry[] {
  const out: RecentEntry[] = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \[\[([^\]|]+)\|([^\]]+)\]\]$/);
    if (!m) continue;
    const ts = Date.parse(m[1].replace(" ", "T") + ":00"); // local time, no Z
    if (Number.isNaN(ts)) continue;
    out.push({ timestampMs: ts, notePath: m[2], label: m[3] });
  }
  return out;
}

/**
 * Merge new entries into the profile note's delimited Recent-messages block,
 * newest first, capped at `limit`. Content outside the delimiters is never
 * touched. A profile without the block gets it inserted above `## Notes`
 * (or appended at the end when no Notes heading exists).
 */
export async function updateProfileRecentMessages(
  app: App,
  profilePath: string,
  newEntries: RecentEntry[],
  limit: number = RECENT_LIMIT,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(profilePath);
  if (!(file instanceof TFile)) return;
  // Cheap pre-check only, to avoid a no-op write. It reads the cache, so it can
  // be stale; the authoritative merge happens inside process() against fresh
  // text. Worst case a stale hit costs one skipped write that the next message
  // redoes, or one redundant write.
  const snapshot = await app.vault.cachedRead(file);
  if (mergeRecentBlock(snapshot, newEntries, limit) === snapshot) return;
  await app.vault.process(file, (text) => mergeRecentBlock(text, newEntries, limit));
}

/**
 * Splice `newEntries` into the delimited recent-messages block of `text`.
 *
 * Pure, and separate from the write, for two reasons: `vault.process` takes a
 * synchronous callback, and this is the part worth unit-testing without a vault.
 */
export function mergeRecentBlock(
  text: string,
  newEntries: RecentEntry[],
  limit: number = RECENT_LIMIT,
): string {
  const startIdx = text.indexOf(RECENT_START);
  const endIdx = text.indexOf(RECENT_END);
  let existing: RecentEntry[] = [];
  if (startIdx >= 0 && endIdx > startIdx) {
    existing = parseRecentEntries(text.slice(startIdx, endIdx));
  }

  const byNote = new Map<string, RecentEntry>();
  for (const e of [...existing, ...newEntries]) byNote.set(e.notePath, e);
  const merged = [...byNote.values()]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, limit);
  const block = renderRecentBlock(merged);

  if (startIdx >= 0 && endIdx > startIdx) {
    return text.slice(0, startIdx) + block + text.slice(endIdx + RECENT_END.length);
  }
  const notesIdx = text.indexOf("## Notes");
  return notesIdx >= 0
    ? text.slice(0, notesIdx) + block + "\n\n" + text.slice(notesIdx)
    : text.replace(/\n*$/, "\n\n") + block + "\n";
}

const CONTACTS_START = "<!-- igcrm:contacts-start -->";
const CONTACTS_END = "<!-- igcrm:contacts-end -->";

/** The funnel index note, e.g. `CRM/New/@New.md`. `@`-prefixed like every
 *  other note the plugin creates, so it can't collide with a note the user
 *  already keeps called `New` or `Done`.
 *
 *  Takes the stage folder as it is on disk. Both callers read it from a real
 *  folder, so re-deriving the name here would rebuild `shipped` as `Shipped`:
 *  on a case-insensitive disk ensureFolder then throws and stops hub upkeep for
 *  every later stage, and on a case-sensitive one two folders share one hub. */
export function funnelHubPath(crmFolder: string, stageFolder: string): string {
  return normalizePath(`${crmFolder}/${stageFolder}/@${stageFolder}.md`);
}

/**
 * Maintain one note per funnel listing the contacts in it, so profile notes
 * are linked to something that survives the graph filter instead of sitting
 * there as orphans.
 *
 * `byFunnel` must be built from what's on disk. Server funnel and vault
 * layout disagree in several ordinary situations, and a hub listing a contact
 * who isn't in that folder produces an unresolved link, which is worse than
 * no link at all.
 */
export async function syncFunnelHubs(
  app: App,
  crmFolder: string,
  byFunnel: Map<string, string[]>,
): Promise<void> {
  for (const [funnel, usernames] of byFunnel) {
    const path = funnelHubPath(crmFolder, funnel);
    // The name as it sits on disk. See funnelHubPath.
    const folder = funnel;
    const existing = app.vault.getAbstractFileByPath(path);

    // Two different things, previously collapsed into one length check. A
    // funnel that has never held a contact gets no hub at all. But a hub that
    // already exists has to be able to go empty: leaving the last contact
    // listed after they moved away is an unresolved link in the note and a
    // stale node in the graph, which is the thing hubs exist to prevent.
    if (usernames.length === 0 && !(existing instanceof TFile)) continue;

    // Sorted, because the server orders contacts by recency and an
    // iteration-ordered list would rewrite itself on every incoming message.
    const links = [...new Set(usernames)]
      .sort((a, b) => a.localeCompare(b))
      // Bare links: profile basenames are unique, and a path-qualified link
      // would get silently repointed by Obsidian when the folder is renamed,
      // leaving this hub pointing at a contact that has moved away.
      .map((u) => `- [[@${safe(u)}]]`);
    // Joined as lines so an empty roster is exactly the two markers with
    // nothing between them. For a non-empty roster this is byte-identical to
    // the template string it replaces, so no existing hub is rewritten.
    const block = [CONTACTS_START, ...links, CONTACTS_END].join("\n");

    if (!(existing instanceof TFile)) {
      await ensureFolder(app, normalizePath(`${crmFolder}/${folder}`));
      await app.vault.create(path, `# ${folder}\n\n${block}\n\n## Notes\n\n`);
      continue;
    }

    // The pre-check is load-bearing, not an optimisation. This runs on every
    // tick, so writing unconditionally would bump mtime every few seconds,
    // which fires the vault modify event, which fires metadataCache "changed",
    // which wakes the profile watcher. Forever.
    const snapshot = await app.vault.cachedRead(existing);
    if (spliceContactsBlock(snapshot, block) === snapshot) continue;
    await app.vault.process(existing, (text) => spliceContactsBlock(text, block));
  }
}

/** Replace a hub's delimited roster block, wholesale rather than merged: a hub
 *  has to be able to drop a contact that moved to another funnel. */
export function spliceContactsBlock(text: string, block: string): string {
  const startIdx = text.indexOf(CONTACTS_START);
  const endIdx = text.indexOf(CONTACTS_END);
  return startIdx >= 0 && endIdx > startIdx
    ? text.slice(0, startIdx) + block + text.slice(endIdx + CONTACTS_END.length)
    : text.replace(/\n*$/, "\n\n") + block + "\n";
}

/** Extract a RecentEntry from a message note's body (frontmatter timestamp). */
function entryFromMessageBody(notePath: string, body: string): RecentEntry | null {
  // Bounded to the frontmatter block: this runs during a bulk migration over
  // notes the user has written in, and an unbounded match would happily pick up
  // a "timestamp: 1700000000" line typed in the body.
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? "";
  const m = block.match(/^timestamp:\s*(\d+)\s*$/m);
  if (!m) return null;
  const label = notePath.split("/").pop() ?? notePath;
  return { timestampMs: parseInt(m[1], 10), notePath, label };
}

/**
 * The order a profile note's frontmatter reads in, most useful first.
 *
 * `name` and `status` are not in the creation template, because neither exists
 * when the note is created, and `processFrontMatter` appends an unknown key. Left
 * alone they landed under `created`, which put the two fields a person most wants
 * to see at the very bottom.
 *
 * `igsid` is last on purpose. It is the join key the plugin reads and it is never
 * hand-edited, so it is the one line here that means nothing to a human.
 */
const FRONTMATTER_ORDER = [
  "name",
  "username",
  "funnel",
  "status",
  "tags",
  "created",
  "igsid",
];

/**
 * `processFrontMatter`, with the keys left in a deliberate order.
 *
 * Every frontmatter write in the plugin goes through this, so an existing note
 * picks the order up the next time anything touches it rather than needing a
 * sweep over every contact.
 *
 * Keys we do not know about are kept, in their existing relative order, after
 * ours. Someone who added `phone:` or `deal_size:` by hand keeps it: dropping a
 * field because it was not on our list would be much worse than a stale order.
 */
export async function writeFrontmatter(
  app: App,
  file: TFile,
  mutate: (fm: Record<string, unknown>) => void,
): Promise<void> {
  // Annotated because Obsidian types this parameter `any`, which made every
  // line below an unsafe-any finding in the 0.2.0 review.
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    mutate(fm);
    const copy = { ...fm };
    const known = FRONTMATTER_ORDER.filter((k) => k in copy);
    const rest = Object.keys(copy).filter((k) => !FRONTMATTER_ORDER.includes(k));
    // Obsidian serialises in key order, so the order has to be rebuilt on the
    // object itself: delete every key, then reinsert.
    for (const k of Object.keys(fm)) delete fm[k];
    for (const k of [...known, ...rest]) fm[k] = copy[k];
  });
}

/**
 * Put a contact's Instagram profile name on their note.
 *
 * Runs for every contact on every tick, so the first thing it does is decide
 * whether there is anything to do. Without that, `processFrontMatter` would
 * rewrite every profile note every five seconds.
 *
 * The heading is replaced only when it is one of the two forms this code could
 * have written: `# @username` from `ensureProfileNote`, or the name that is in
 * frontmatter now, which is what this function last wrote. Anything else is the
 * user's prose and stays. Matching the second form is what makes a changed name
 * reach the heading; without it the frontmatter updated and the heading kept the
 * old name forever.
 *
 * Never clears anything: a contact whose name we do not have is left as it is,
 * rather than having an existing `name` blanked by a server that is older than
 * the field or a profile that has since removed it.
 */
export async function applyContactName(
  app: App,
  profilePath: string,
  username: string,
  name: string | null | undefined,
): Promise<void> {
  const clean = (name ?? "").trim();
  if (!clean) return;
  const file = app.vault.getAbstractFileByPath(profilePath);
  if (!(file instanceof TFile)) return;

  // The name is the only thing that decides whether to write. A stale key order
  // is deliberately not enough: including it here meant every note created before
  // the order existed got rewritten on the first tick after an upgrade, across the
  // whole vault, for a cosmetic change nobody asked for. The reorder rides along
  // with writes that were happening anyway.
  const cached = frontmatterOf(app, file);
  if (cached?.name === clean) return;

  // Read before the write: the heading this function last wrote was built from
  // it, and it is how a renamed contact's heading is recognised below.
  const previous = typeof cached?.name === "string" ? cached.name.trim() : "";

  await writeFrontmatter(app, file, (fm) => {
    fm.name = clean;
  });

  // Both forms this code could have produced. Nothing else is touched.
  const ours = [`# @${username}`];
  if (previous) ours.push(`# ${previous}`);
  await app.vault.process(file, (text) => {
    const lines = text.split("\n");
    const at = lines.findIndex((l) => ours.includes(l));
    if (at === -1) return text;
    if (lines[at] === `# ${clean}`) return text;
    lines[at] = `# ${clean}`;
    return lines.join("\n");
  });
}

export async function ensureProfileNote(
  app: App,
  crmFolder: string,
  funnel: string,
  username: string,
  igsid: string,
): Promise<string> {
  const dir = conversationFolder(crmFolder, funnel, username);
  await ensureFolder(app, dir);
  const path = profileNotePath(crmFolder, funnel, username);
  if (existsInVault(app, path)) {
    return path;
  }
  // Key order matches FRONTMATTER_ORDER, so a note created here never needs
  // reordering afterwards. `name` and `status` are absent because neither is
  // known yet; both slot into place the first time they are written.
  const body =
    `---\n` +
    `username: "${escapeYaml(username)}"\n` +
    // Quoted like its neighbours. validateFunnelName permits `!hot`, `@vip`,
    // `%done`, `{x}` and `- lead`, and none of those can be a plain YAML scalar:
    // `!` opens a tag, `@` and `%` are reserved indicators, `- ` starts a block
    // sequence, `{x}` is a flow mapping. Written raw, the block stopped parsing
    // and frontmatterOf returned undefined for that note forever — no display
    // name, stage writes reporting failure while still moving the folder, status
    // writes refused, and hand-editing the YAML the only way out. `!hot` is not a
    // contrived name either: the trigger-code box beside it says `!code`.
    `funnel: "${escapeYaml(funnel)}"\n` +
    `tags: []\n` +
    `created: "${localStamp(Date.now())}"\n` +
    `igsid: "${escapeYaml(igsid)}"\n` +
    `---\n\n` +
    `# @${username}\n\n` +
    `[Open on Instagram](https://instagram.com/${safe(username)})\n\n` +
    `${RECENT_START}\n## Recent messages\n\n${RECENT_END}\n\n` +
    `## Notes\n\n`;
  await app.vault.create(path, body);
  return path;
}

/**
 * Where a DM lands when the normal write path has given up on it.
 *
 * Beside `_meta/`, not inside it. The underscore keeps it out of
 * `funnelFolders`, so nothing mistakes it for a stage, but only `_meta` itself
 * is hidden from the file explorer. A rescued message the user cannot see in
 * the tree would defeat the point of rescuing it.
 */
export const UNFILED_FOLDER = "_unfiled";

export function quarantineFolder(crmFolder: string): string {
  return normalizePath(`${crmFolder}/${UNFILED_FOLDER}`);
}

/**
 * Save a DM the normal write path could not file, so the text survives.
 *
 * The server deletes a message once it is acked, so acking an unwritten one
 * destroys it. This is the copy that makes acking safe, and it is deliberately
 * dumber than `writeMessageNote`: no profile note, no recent-messages block, no
 * collision loop, no frontmatter. Whatever broke the rich path should not have
 * a second chance to break this one.
 */
export async function quarantineMessage(
  app: App,
  crmFolder: string,
  msg: InboxMessage,
): Promise<string> {
  const dir = quarantineFolder(crmFolder);
  await ensureFolder(app, dir);
  // Keyed on the mid, so a redelivery of the same DM resolves to the same
  // file. Returning the existing path rather than letting `create` throw is
  // what keeps a lost ledger entry from wedging the queue permanently.
  const path = normalizePath(`${dir}/${localYmd(msg.timestamp_ms)} - ${safe(msg.mid)}.md`);
  if (existsInVault(app, path)) return path;
  const body =
    `Saved here because it could not be filed into a conversation after ` +
    `repeated attempts. Nothing is lost, and you can move this note wherever ` +
    `you like.\n\n` +
    `- From: @${msg.sender_username}\n` +
    `- Instagram id: ${msg.sender_igsid}\n` +
    `- Message id: ${msg.mid}\n` +
    `- Received: ${localStamp(msg.timestamp_ms)}\n\n` +
    `---\n\n` +
    `${msg.text}\n`;
  await app.vault.create(path, body);
  return path;
}

export async function writeMessageNote(
  app: App,
  crmFolder: string,
  funnel: string,
  msg: InboxMessage,
): Promise<string> {
  const dir = historyFolder(crmFolder, funnel, msg.sender_username);
  await ensureFolder(app, dir);
  const date = localYmd(msg.timestamp_ms);
  const base = `${date} - ${filenamePreview(msg.text, 40)}`;
  // Someone repeating themselves on one day produces the same name every time,
  // so count up until a free one turns up. `vault.create` throws on an existing
  // path, and a failed write eventually gets the message dropped, so this has
  // to actually terminate on a unique name. The mid is unique per message and
  // ends the search for good in the pathological case.
  let path = normalizePath(`${dir}/${base}.md`);
  for (let n = 2; existsInVault(app, path); n++) {
    if (n > 200) {
      path = normalizePath(`${dir}/${base} (${safe(msg.mid)}).md`);
      break;
    }
    path = normalizePath(`${dir}/${base} (${n}).md`);
  }
  const body =
    `---\n` +
    `date: ${localStamp(msg.timestamp_ms)}\n` +
    `---\n\n` +
    `From [[@${safe(msg.sender_username)}]]\n\n` +
    `${msg.text}\n`;
  try {
    await app.vault.create(path, body);
  } catch {
    // The index missed a collision the filesystem can see, which is what a
    // case-insensitive disk does. Failing here is expensive out of proportion
    // to the cause: writeOne throws, the retry counter reaches
    // MAX_WRITE_ATTEMPTS, and the DM is acked and dropped. The mid is unique
    // per message, so this name always terminates the search.
    path = normalizePath(`${dir}/${base} (${safe(msg.mid)}).md`);
    await app.vault.create(path, body);
  }
  return path;
}

/**
 * Write the funnel into a profile note's frontmatter.
 *
 * Takes a `TFile` rather than a path so a caller can hand over a handle it
 * captured before a folder rename. Obsidian moves the same instance and
 * mutates its `.path`, so such a handle stays valid while a fresh lookup by
 * the new path can still miss while the index catches up.
 *
 * Uses `processFrontMatter` rather than a regex. The regex this replaces was
 * not bounded to the `---` block, so on a note whose body contained a line
 * like `funnel: waiting on quote` it rewrote *that* line, and because the
 * replace then "succeeded" the real frontmatter key was never inserted. The
 * body ended up corrupted and the frontmatter permanently wrong.
 */
async function setProfileFunnel(app: App, file: TFile, newFunnel: string): Promise<void> {
  const current: unknown = frontmatterOf(app, file)?.funnel;
  if (typeof current === "string" && current.trim() === newFunnel) return;
  try {
    await writeFrontmatter(app, file, (fm: Record<string, unknown>) => {
      // A note with no `funnel` key yet is pre-0.2.0, so its `status:` is the
      // old spelling of this very field rather than the new secondary detail.
      // Clear it in the same write: the moment `funnel:` exists,
      // adoptLegacyFunnelKey stops firing for this note, so nothing else ever
      // gets the chance. Left behind, the stale value would silently become
      // the contact's secondary status.
      if (fm.funnel === undefined && typeof fm.status === "string") delete fm.status;
      fm.funnel = newFunnel;
    });
  } catch (e) {
    // Thrown on unparseable YAML, which means the user has broken their own
    // frontmatter. Say so; the regex it replaced would have mangled it further.
    logWarn(`couldn't update the funnel in ${file.path}`, e);
    new Notice(`Couldn't update the funnel stage in ${file.path}. Check its frontmatter.`);
  }
}

/**
 * Read a conversation's secondary status, or "" when it has none.
 *
 * Only meaningful once the note carries `funnel:`. Before that, `status:` is
 * the pre-0.2.0 spelling of the stage, so reporting it here would show the
 * stage name as the status.
 */
export function readProfileStatus(app: App, profilePath: string): string {
  const file = app.vault.getAbstractFileByPath(profilePath);
  if (!(file instanceof TFile)) return "";
  const fm = frontmatterOf(app, file);
  if (!fm || fm.funnel === undefined) return "";
  return typeof fm.status === "string" ? fm.status.trim() : "";
}

/**
 * Write, or with an empty value clear, a conversation's secondary status.
 *
 * Refuses on a note that has no `funnel:` yet, because on such a note
 * `status:` still means the stage and writing here would silently move the
 * conversation. Those notes migrate on their next stage change or YAML edit.
 */
export async function setProfileStatus(
  app: App,
  profilePath: string,
  status: string,
): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(profilePath);
  if (!(file instanceof TFile)) return false;
  if (frontmatterOf(app, file)?.funnel === undefined) return false;
  const trimmed = status.trim();
  try {
    await writeFrontmatter(app, file, (fm: Record<string, unknown>) => {
      if (trimmed) fm.status = trimmed;
      else delete fm.status;
    });
    return true;
  } catch (e) {
    logWarn(`couldn't update the status in ${file.path}`, e);
    new Notice(`Couldn't update the status in ${file.path}. Check its frontmatter.`);
    return false;
  }
}

/** Path-based wrapper for callers with no handle in hand. */
async function updateProfileFunnel(app: App, profilePath: string, newFunnel: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(profilePath);
  if (file instanceof TFile) await setProfileFunnel(app, file, newFunnel);
}

/**
 * Moves an entire conversation folder from CRM/<oldStage>/@user/ to
 * CRM/<newFunnel>/@user/. Prefers a single folder-level `renameFile` (atomic,
 * carries `_history/` and updates wikilinks); falls back to a recursive
 * per-file move when the destination already exists or the rename fails.
 * Returns the new profile path so callers can update canvas file references.
 */
export async function moveConversation(
  app: App,
  crmFolder: string,
  username: string,
  fromFunnel: string | null,
  toFunnel: string,
): Promise<string> {
  // Both ends resolved to the spelling on disk, not to funnelFolderName's. A
  // stage folder the user made by hand is commonly lower-cased, and an
  // exact-case path built from the name misses it: the destination stamp landed
  // on a note that did not exist, and the source lookup below decided there was
  // nothing to move. Both reported success.
  const toSpelling = stageFolderSpelling(app, crmFolder, toFunnel);
  const newDir = conversationFolderIn(crmFolder, toSpelling, username);
  const newProfilePath = profileNotePathIn(crmFolder, toSpelling, username);

  // `null` means the conversation is already where it belongs and only its
  // frontmatter is out of date, which is the case when the user drags a folder in
  // from outside the CRM tree. There is no source to read.
  //
  // It has to be a distinct value rather than an empty string. `""` used to be
  // passed here, and `funnelFolderName("")` returns "New" (types.ts), so the
  // source resolved to the default stage's folder: a real, unrelated, live
  // conversation whose notes were then moved into the folder the user dragged in.
  if (fromFunnel === null) {
    await updateProfileFunnel(app, newProfilePath, toFunnel);
    return newProfilePath;
  }

  const fromSpelling = stageFolderSpelling(app, crmFolder, fromFunnel);
  const oldDir = conversationFolderIn(crmFolder, fromSpelling, username);

  // Captured before anything moves. Obsidian renames the same TFile instance
  // and mutates its path, so this handle follows the note to its destination,
  // which is what lets the frontmatter write survive the index lag that the
  // old adapter fallback existed to paper over.
  const profileBefore = app.vault.getAbstractFileByPath(
    profileNotePathIn(crmFolder, fromSpelling, username),
  );

  const oldFolder = app.vault.getAbstractFileByPath(oldDir);
  if (!(oldFolder instanceof TFolder)) {
    // Nothing to move: already at the destination, or not in this vault.
    // Converge the YAML if the note is there, but never create the folder:
    // doing so litters the vault with empty conversations for contacts whose
    // notes don't exist yet.
    await updateProfileFunnel(app, newProfilePath, toFunnel);
    return newProfilePath;
  }

  // Parent funnel folder must exist, but the @user destination itself must
  // NOT for the folder-level rename to succeed.
  const parentDir = newDir.split("/").slice(0, -1).join("/");
  await ensureFolder(app, parentDir);

  if (!existsInVault(app, newDir)) {
    try {
      await app.fileManager.renameFile(oldFolder, newDir);
      await writeFunnelToDestination(app, profileBefore, newProfilePath, toFunnel);
      return newProfilePath;
    } catch (e) {
      logWarn("moveConversation: folder rename failed, falling back to per-file", e);
    }
  }

  await ensureFolder(app, newDir);
  await moveChildrenInto(app, oldFolder, newDir);

  if (oldFolder.children.length > 0) {
    logWarn(
      `moveConversation: ${oldFolder.children.length} item(s) remain in ${oldDir}:`,
      oldFolder.children.map((c) => c.path),
    );
  }

  // Trash empty old folder (best-effort, honors user's trash preference).
  const stillThere = app.vault.getAbstractFileByPath(oldDir);
  if (stillThere instanceof TFolder && stillThere.children.length === 0) {
    try {
      await app.fileManager.trashFile(stillThere);
    } catch {
      // ignore
    }
  }

  await writeFunnelToDestination(app, profileBefore, newProfilePath, toFunnel);
  return newProfilePath;
}

/**
 * Stamp the new funnel on the profile note **at the destination**, never on one
 * left behind at the source.
 *
 * The captured handle is only usable when the move actually carried it across,
 * which is what `path === newProfilePath` checks. `moveChildrenInto` skips any
 * child whose destination already exists, so when both
 * `CRM/<old>/@user/@user.md` and `CRM/<new>/@user/@user.md` are present (the
 * ordinary shape after Obsidian Sync delivers a move from another device, or
 * after a half-finished move) the profile is not moved and the handle still
 * points at the source. Writing there would leave the destination note
 * contradicting its own folder, and the watcher reads that as a hand edit and
 * moves the whole conversation back. That is the self-reverting-funnel bug.
 *
 * Falling back to a path lookup is safe in exactly that case: the destination
 * note existed before the move, so it is already indexed and there is no lag to
 * protect against.
 */
async function writeFunnelToDestination(
  app: App,
  profileBefore: TAbstractFile | null,
  newProfilePath: string,
  toFunnel: string,
): Promise<void> {
  if (profileBefore instanceof TFile && profileBefore.path === newProfilePath) {
    await setProfileFunnel(app, profileBefore, toFunnel);
    return;
  }
  await updateProfileFunnel(app, newProfilePath, toFunnel);
}

/** Recursively move a folder's children into `destDir`, descending into
 *  subfolders (e.g. `_history/`) so nothing is orphaned. */
async function moveChildrenInto(app: App, folder: TFolder, destDir: string): Promise<void> {
  for (const child of folder.children.slice()) {
    const target = normalizePath(`${destDir}/${child.name}`);
    if (child instanceof TFolder) {
      await ensureFolder(app, target);
      await moveChildrenInto(app, child, target);
      const emptied = app.vault.getAbstractFileByPath(child.path);
      if (emptied instanceof TFolder && emptied.children.length === 0) {
        try {
          await app.fileManager.trashFile(emptied);
        } catch {
          // ignore
        }
      }
      continue;
    }
    if (!(child instanceof TFile)) continue;
    if (existsInVault(app, target)) continue;
    try {
      await app.fileManager.renameFile(child, target);
    } catch (e) {
      logWarn(`moveConversation: rename failed ${child.path} -> ${target}`, e);
    }
  }
}

export interface V02MigrationOptions {
  crmFolder: string;
  canvasFile: string; // current setting value (vault-relative under crmFolder)
  canvasIsLegacyDefault: boolean;
  recentLimit?: number;
}

export interface V02MigrationResult {
  conversationsMigrated: number;
  newCanvasFile: string; // possibly-relocated setting value
  profiles: { profilePath: string; username: string }[];
  journalPath: string;
}

function funnelFolders(app: App, crmFolder: string): TFolder[] {
  const root = app.vault.getAbstractFileByPath(normalizePath(crmFolder));
  if (!(root instanceof TFolder)) return [];
  return root.children.filter(
    (c): c is TFolder =>
      c instanceof TFolder && !c.name.startsWith("_") && !c.name.startsWith("@"),
  );
}

function conversationFolders(funnel: TFolder): TFolder[] {
  return funnel.children.filter(
    (c): c is TFolder => c instanceof TFolder && c.name.startsWith("@"),
  );
}

/**
 * Message notes this plugin wrote that are still sitting beside the profile.
 *
 * The `mid:` key is what identifies them: every pre-0.2.0 message note carried
 * one, and 0.2.0 writes `date:` into `_history/` instead, so nothing the
 * plugin writes today is ever flat. Anything else next to a profile belongs to
 * the user, a meeting note or a Templater output, and the migration has to
 * leave it exactly where they put it.
 */
async function flatMessageNotes(app: App, conv: TFolder): Promise<TFile[]> {
  const profileName = `${conv.name}.md`;
  const candidates = conv.children.filter(
    (c): c is TFile => c instanceof TFile && c.name.endsWith(".md") && c.name !== profileName,
  );
  const mine: TFile[] = [];
  for (const file of candidates) {
    // Cache first, file second, the same order `resolveConversation` uses for
    // the igsid. The cache is not populated yet at layout-ready, and trusting
    // it alone made this answer "no plugin notes here" on a cold cache: the
    // migration then decided there was nothing to do and latched that, so a
    // real 0.1.x vault was never converted and never asked again.
    const cached: unknown = frontmatterOf(app, file)?.mid;
    if (cached !== undefined) {
      mine.push(file);
      continue;
    }
    if (frontmatterScalar(await app.vault.cachedRead(file), "mid")) mine.push(file);
  }
  return mine;
}

/**
 * True when the vault still has pre-v0.2.0 state: conversations in the oldest
 * `Profiles/` + `Messages/` layout, flat message notes inside any `@user/`
 * folder, or the canvas at the legacy default location.
 */
export async function needsV02Migration(
  app: App,
  crmFolder: string,
  canvasIsLegacyDefault: boolean,
): Promise<boolean> {
  const legacy = await legacyLayoutFiles(app, crmFolder);
  if (legacy.profiles.length > 0 || legacy.messages.length > 0) return true;
  for (const funnel of funnelFolders(app, crmFolder)) {
    for (const conv of conversationFolders(funnel)) {
      if ((await flatMessageNotes(app, conv)).length > 0) return true;
    }
  }
  if (canvasIsLegacyDefault) {
    const legacyCanvas = normalizePath(`${crmFolder}/Inbox.canvas`);
    if (existsInVault(app, legacyCanvas)) return true;
  }
  return false;
}

/**
 * Migrate a pre-v0.2.0 vault to the hybrid layout. This renames files and
 * never deletes them. Every step skips when its target already exists, so a
 * partial run can just be retried. Journals each operation to
 * `<crmFolder>/_meta/migration-v020.log`.
 */
export async function migrateToV02Layout(
  app: App,
  opts: V02MigrationOptions,
): Promise<V02MigrationResult> {
  const { crmFolder, canvasIsLegacyDefault } = opts;
  const limit = opts.recentLimit ?? RECENT_LIMIT;
  const metaDir = normalizePath(`${crmFolder}/${META_FOLDER}`);
  const journalPath = normalizePath(`${metaDir}/migration-v020.log`);
  const journal: string[] = [];
  await ensureFolder(app, metaDir);

  const flushJournal = async (): Promise<void> => {
    if (journal.length === 0) return;
    const stamp = new Date().toISOString();
    const text = `# migration run ${stamp}\n${journal.join("\n")}\n`;
    const existing = app.vault.getAbstractFileByPath(journalPath);
    if (existing instanceof TFile) {
      await app.vault.append(existing, text);
    } else {
      await app.vault.create(journalPath, text);
    }
    // One summary rather than a line per file: a large vault produced hundreds.
    debugLog(`migrate v0.2.0: ${journal.length} operation(s), see ${journalPath}`);
  };

  // Everything below journals its renames; the finally guarantees the journal
  // reaches disk even when a rename throws mid-run, so the audit trail always
  // reflects what actually happened.
  try {
  // Canvas: back up, then relocate if the user is on the legacy default path.
  let newCanvasFile = opts.canvasFile;
  const oldCanvasPath = normalizePath(`${crmFolder}/${opts.canvasFile}`);
  const oldCanvasFileObj = app.vault.getAbstractFileByPath(oldCanvasPath);
  if (oldCanvasFileObj instanceof TFile) {
    const baseName = opts.canvasFile.split("/").pop() || "Inbox.canvas";
    const bakPath = normalizePath(`${metaDir}/${baseName}.pre-v020.bak`);
    if (!existsInVault(app, bakPath)) {
      const body = await app.vault.read(oldCanvasFileObj);
      await app.vault.create(bakPath, body);
      journal.push(`backup ${oldCanvasPath} -> ${bakPath}`);
    }
    if (canvasIsLegacyDefault) {
      const newPath = normalizePath(`${metaDir}/Inbox.canvas`);
      if (!existsInVault(app, newPath)) {
        const canvasFileObj = app.vault.getAbstractFileByPath(oldCanvasPath);
        if (canvasFileObj instanceof TFile) {
          await app.fileManager.renameFile(canvasFileObj, newPath);
          journal.push(`move ${oldCanvasPath} -> ${newPath}`);
        }
      }
      newCanvasFile = `${META_FOLDER}/Inbox.canvas`;
    }
  } else if (canvasIsLegacyDefault) {
    // No canvas on disk yet, so just adopt the new default location.
    newCanvasFile = `${META_FOLDER}/Inbox.canvas`;
  }

  // Conversations: flat message notes -> _history/, then seed recent blocks.
  let conversationsMigrated = 0;
  const profiles: { profilePath: string; username: string }[] = [];
  for (const funnel of funnelFolders(app, crmFolder)) {
    for (const conv of conversationFolders(funnel)) {
      const profilePath = normalizePath(`${conv.path}/${conv.name}.md`);
      if (app.vault.getAbstractFileByPath(profilePath) instanceof TFile) {
        profiles.push({ profilePath, username: conv.name.slice(1) });
      }
      const flat = await flatMessageNotes(app, conv);
      if (flat.length === 0) continue;
      const histDir = normalizePath(`${conv.path}/${HISTORY_FOLDER}`);
      await ensureFolder(app, histDir);
      const entries: RecentEntry[] = [];
      for (const note of flat) {
        const target = normalizePath(`${histDir}/${note.name}`);
        if (existsInVault(app, target)) continue;
        const body = await app.vault.read(note);
        await app.fileManager.renameFile(note, target);
        journal.push(`move ${conv.path}/${note.name} -> ${target}`);
        const entry = entryFromMessageBody(target.replace(/\.md$/, ""), body);
        if (entry) entries.push(entry);
      }
      if (entries.length > 0) {
        await updateProfileRecentMessages(app, profilePath, entries, limit);
        journal.push(`seed recent-messages ${profilePath} (${entries.length} entries)`);
      }
      conversationsMigrated += 1;
    }
  }

  return { conversationsMigrated, newCanvasFile, profiles, journalPath };
  } finally {
    await flushJournal();
  }
}

/** The filename 0.1.x gave a message note: "2026-07-18 @alice - hey there.md". */
const LEGACY_MESSAGE_NAME = /^(\d{4}-\d{2}-\d{2})\s+@([A-Za-z0-9._-]+)\s+-\s+(.+)\.md$/;

/**
 * Files still sitting in the oldest `Profiles/` + `Messages/` layout that this
 * plugin can actually move.
 *
 * Identified by content, not by which folder they are in: a profile note by
 * its `igsid:` key (written by every release since the first), a message note
 * by the filename 0.1.x generated. Anything else the user put in those folders
 * is left alone, and is not counted as work outstanding either. Otherwise a
 * vault with one stray note would be asked to migrate forever.
 */
async function legacyLayoutFiles(
  app: App,
  crmFolder: string,
): Promise<{ profiles: TFile[]; messages: TFile[] }> {
  const children = (dir: string): TFile[] => {
    const folder = app.vault.getAbstractFileByPath(normalizePath(`${crmFolder}/${dir}`));
    if (!(folder instanceof TFolder)) return [];
    return folder.children.filter((c): c is TFile => c instanceof TFile && c.name.endsWith(".md"));
  };
  const profiles: TFile[] = [];
  for (const file of children("Profiles")) {
    // Cache first, file second, for the same reason as flatMessageNotes above:
    // at layout-ready the metadata cache may not be built, and reading a
    // negative off it would report an un-migrated vault as already done.
    if (frontmatterOf(app, file)?.igsid !== undefined) {
      profiles.push(file);
      continue;
    }
    if (frontmatterScalar(await app.vault.cachedRead(file), "igsid")) profiles.push(file);
  }
  return {
    profiles,
    messages: children("Messages").filter((f) => LEGACY_MESSAGE_NAME.test(f.name)),
  };
}

/**
 * Move the oldest `Profiles/` + `Messages/` layout into folder-per-stage.
 * Idempotent: every step skips a target that already exists, so re-running it
 * is free. Runs as the first half of the consented v0.2.0 migration, which is
 * what reports the result, so this stays quiet.
 */
export async function migrateLegacyLayout(
  app: App,
  crmFolder: string,
  defaultFunnel: string,
): Promise<number> {
  const legacyProfilesDir = normalizePath(`${crmFolder}/Profiles`);
  const legacyMessagesDir = normalizePath(`${crmFolder}/Messages`);

  const profilesFolder = app.vault.getAbstractFileByPath(legacyProfilesDir);
  const messagesFolder = app.vault.getAbstractFileByPath(legacyMessagesDir);
  if (!(profilesFolder instanceof TFolder) && !(messagesFolder instanceof TFolder)) {
    return 0;
  }

  const { profiles: legacyProfiles, messages: legacyMessages } = await legacyLayoutFiles(
    app,
    crmFolder,
  );
  const migratedUsers = new Set<string>();

  for (const child of legacyProfiles) {
    const username = child.name.replace(/\.md$/, "").replace(/^@/, "");
    const dir = conversationFolder(crmFolder, defaultFunnel, username);
    await ensureFolder(app, dir);
    const target = profileNotePath(crmFolder, defaultFunnel, username);
    if (!existsInVault(app, target)) {
      await app.fileManager.renameFile(child, target);
      migratedUsers.add(username);
    }
  }

  for (const child of legacyMessages) {
    const [, date, username, preview] = LEGACY_MESSAGE_NAME.exec(child.name)!;
    const dir = conversationFolder(crmFolder, defaultFunnel, username);
    await ensureFolder(app, dir);
    const target = normalizePath(`${dir}/${date} - ${preview}.md`);
    if (!existsInVault(app, target)) {
      await app.fileManager.renameFile(child, target);
      migratedUsers.add(username);
    }
  }

  // Clean up now-empty legacy folders (honors user's trash preference).
  for (const legacy of [profilesFolder, messagesFolder]) {
    if (legacy instanceof TFolder && legacy.children.length === 0) {
      try {
        await app.fileManager.trashFile(legacy);
      } catch {
        // ignore
      }
    }
  }

  return migratedUsers.size;
}
