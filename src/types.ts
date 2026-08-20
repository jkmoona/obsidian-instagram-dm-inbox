export interface InboxMessage {
  id: string;
  mid: string;
  sender_igsid: string;
  sender_username: string;
  timestamp_ms: number;
  text: string;
}

/**
 * A stage of the funnel: the thing that owns folder layout, colours, graph
 * clusters and hub notes, and the thing an Instagram reply's trigger code
 * moves a conversation between.
 *
 * Not to be confused with a conversation's `status`, which is a free-text
 * detail *within* a stage ("waiting on money") and lives only in frontmatter.
 */
export interface Funnel {
  name: string;
  code: string | null;
  /** Suggested statuses for conversations in this stage. A suggestion list,
   *  not a whitelist: free text is always allowed and gets promoted in here so
   *  it is offered next time. */
  statuses?: string[];
}

export interface Contact {
  sender_igsid: string;
  sender_username: string;
  /** Their Instagram profile name. Optional twice over: plenty of people have
   *  not set one, and a server older than this field never sends it. */
  sender_name?: string | null;
  /** The 0.2.0 spelling. The server emits both during the transition; read
   *  them through `contactFunnel` below and drop the fallback in 0.3.0. */
  funnel?: string;
  status?: string;
  updated_at: number;
}

/** The stage a contact is in, whichever spelling the server used.
 *  `||`, not `??`: an empty string is as useless as a missing key here, and
 *  falling through to "" lets the caller apply its own default rather than
 *  building a folder path out of nothing. */
export function contactFunnel(c: Contact): string {
  return c.funnel || c.status || "";
}

export interface PluginSettings {
  serverUrl: string;
  apiKey: string;
  crmFolder: string;
  canvasFile: string;
  pollIntervalSeconds: number;
  funnels: Funnel[];
  contactFunnelCache: { [igsid: string]: string };
  /** Stage changes the vault has applied but the server hasn't accepted yet.
   *  Reconcile leaves these alone so a failed request can't drag the folder
   *  back, and each poll retries them. */
  pendingFunnel: { [igsid: string]: string };
  /** Mids already written into the vault, oldest first. The server redelivers
   *  everything it hasn't accepted an ack for, and message notes carry no id,
   *  so this list is the only thing between a failed ack and a second copy of
   *  every note. Persisted rather than in-memory because the redelivery window
   *  lasts until an ack lands, which can span an Obsidian reload. */
  writtenMids: string[];
  /** Extra console detail for diagnosing a problem. Off by default: the poll
   *  loop runs every few seconds and this gets noisy fast. */
  debugLogging: boolean;
  migratedLegacyLayout: boolean;
  migratedToV02: boolean;
}

/** Pre-v0.2.0 default canvas location; used to decide whether migration may
 *  relocate the canvas (a customized path is honored and left alone). */
export const LEGACY_DEFAULT_CANVAS = "Inbox.canvas";

export const DEFAULT_FUNNELS: Funnel[] = [
  { name: "new", code: null },
  { name: "pending", code: "!pending" },
  { name: "done", code: "!done" },
];

/**
 * What every release up to 0.2.0 called the inbox folder.
 *
 * A data.json written by one of those has no `crmFolder` key unless the user
 * changed it, so `loadSettings` pins upgrades to this rather than letting the
 * new default below silently point them at an empty folder.
 */
export const PRE_020_INBOX_FOLDER = "CRM";

export const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "",
  apiKey: "",
  // New installs only. Named for what is in it, and unlikely to collide with a
  // folder the user already has.
  crmFolder: "Instagram DMs",
  canvasFile: "_meta/Inbox.canvas",
  pollIntervalSeconds: 5,
  funnels: DEFAULT_FUNNELS.map((s) => ({ ...s })),
  contactFunnelCache: {},
  pendingFunnel: {},
  writtenMids: [],
  debugLogging: false,
  migratedLegacyLayout: false,
  migratedToV02: false,
};

/** The stage new conversations land in: the one with no trigger code. */
export function defaultFunnelName(funnels: Funnel[]): string {
  const fallback = funnels.find((s) => s.code === null);
  return fallback?.name ?? funnels[0]?.name ?? "new";
}

/**
 * The folder a stage owns. Two behaviours here are load-bearing.
 *
 * An empty name becomes "New", so a corrupted or hand-edited settings file
 * cannot produce a path with an empty segment. And only the first letter is
 * touched: the rest of the name is left exactly as the user typed it, because
 * this has to round-trip with the folders already on disk. Lowercasing or
 * title-casing the remainder would orphan every existing conversation.
 */
export function funnelFolderName(funnel: string): string {
  if (!funnel) return "New";
  return funnel.charAt(0).toUpperCase() + funnel.slice(1);
}

export const MAX_TRIGGER_CODE_LENGTH = 120;

// Mirrors validate_funnel_name() on the server: stage names become folder
// names and are embedded in wikilinks, so they must be safe path segments.
//
// `\p{Cc}` rather than a literal `\x00-\x1f` range, which is what the control
// characters have to be matched as in order to be rejected. Two reasons: writing
// the range out puts control escapes in the source, which `no-control-regex`
// flags and which then needs suppressing, and the range misses DEL and the C1
// block (U+007F-U+009F). Those are equally illegal here. The server's copy spells
// the same set as [\x00-\x1f\x7f-\x9f], because Python's `re` has no \p{Cc}.
const FORBIDDEN_IN_FUNNEL_NAME = /[\\/:*?"<>|#^[\]]|\p{Cc}/u;

/** Return why `name` can't be used as a funnel stage, or null if it's fine. */
export function validateFunnelName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Stage names cannot be empty.";
  const found = trimmed.match(FORBIDDEN_IN_FUNNEL_NAME);
  if (found) {
    const char = found[0];
    const shown = char.charCodeAt(0) < 0x20 ? "line breaks or control characters" : `"${char}"`;
    return `Stage name "${trimmed}" cannot contain ${shown}.`;
  }
  // `_` is reserved for the plugin's own folders (_meta, _history).
  if (trimmed.startsWith("_")) {
    return `Stage name "${trimmed}" cannot start with "_" (reserved).`;
  }
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) {
    return `Stage name "${trimmed}" cannot start or end with ".".`;
  }
  return null;
}

/** Max length of a conversation's secondary status. Generous: it is a phrase
 *  the user types, not an identifier. Mirrors the server's cap. */
export const MAX_STATUS_LENGTH = 64;

/** Suggestions kept per stage. Mirrors the server's cap; beyond this the list
 *  stops being a shortlist and the picker stops being useful. */
export const MAX_STATUSES_PER_FUNNEL = 30;

export interface CanvasNode {
  id: string;
  type: string;
  file?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
