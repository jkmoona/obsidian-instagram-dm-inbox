import { App, TFile, TFolder, normalizePath } from "obsidian";
import { colorCssHexForIndex } from "./palette";
import { Canvas, CanvasNode, Funnel, funnelFolderName } from "./types";

const NODE_W = 320;
const NODE_H_PROFILE = 100;
const COL_GAP = 60;
const ROW_GAP = 40;
const GRID_COLS = 4;

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * A profile note, by the shape of its path: `.../@user/@user.md`.
 *
 * This is what separates the cards the plugin owns from the ones the user put
 * on the canvas themselves. Only owned cards are removed when a contact goes
 * away and recoloured when a stage changes; anything else on the canvas is the
 * user's own arrangement and is left exactly as it is.
 */
const PROFILE_NOTE_PATH = /\/@([^/]+)\/@\1\.md$/;

/** The funnel stage folder a profile note lives in. Profile paths are always
 *  `<crmFolder>/<Stage>/@user/@user.md`, and reading the stage from the path
 *  rather than from server data is what keeps card colours agreeing with the
 *  file explorer and the graph, which are both keyed on the same paths. */
function funnelFromProfilePath(profilePath: string): string {
  const parts = profilePath.split("/");
  return parts[parts.length - 3] ?? "";
}

/** Colour for a card, by its stage's position in the configured list. Falls
 *  back to the first colour for a stage this device doesn't know about, which
 *  happens when the server reports one that was renamed elsewhere. */
function colorForFunnel(funnel: string, funnels: Funnel[]): string {
  const key = funnelFolderName(funnel).toLowerCase();
  const i = funnels.findIndex((s) => funnelFolderName(s.name).toLowerCase() === key);
  return colorCssHexForIndex(i < 0 ? 0 : i);
}

export async function loadCanvas(app: App, path: string): Promise<Canvas> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) {
    return { nodes: [], edges: [] };
  }
  // read, not cachedRead: the result is compared and written straight back, so
  // a stale snapshot here would silently revert whatever it missed.
  const text = await app.vault.read(file);
  if (!text.trim()) {
    return { nodes: [], edges: [] };
  }
  let data: Partial<Canvas>;
  try {
    data = JSON.parse(text) as Partial<Canvas>;
  } catch {
    return { nodes: [], edges: [] };
  }
  return {
    nodes: data.nodes ?? [],
    edges: data.edges ?? [],
  };
}

export async function saveCanvas(app: App, path: string, canvas: Canvas): Promise<void> {
  const normalized = normalizePath(path);
  const folder = normalized.split("/").slice(0, -1).join("/");
  if (folder && !(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
    try {
      await app.vault.createFolder(folder);
    } catch {
      // Already there under a different case, or created by an overlapping
      // tick. Either way the write below can proceed.
    }
  }
  const body = JSON.stringify(canvas, null, 2) + "\n";
  const file = app.vault.getAbstractFileByPath(normalized);
  if (file instanceof TFile) {
    // process() rather than modify(): it holds the file lock across the write.
    // An open Canvas view still wins, because it keeps its own model and saves
    // it back, so close the canvas if a sync seems not to land.
    await app.vault.process(file, () => body);
  } else {
    await app.vault.create(normalized, body);
  }
}

export interface CanvasProfile {
  profilePath: string;
  username: string;
}

/**
 * Reconcile the canvas with the contact roster, leaving the user's layout alone.
 *
 * Existing cards keep their geometry, text cards and the edges the user drew
 * between surviving cards are preserved, a contact who has gone loses their
 * card, and new contacts are grid-placed below the current bounding box.
 * Anything that is not a contact card is the user's, and is left as it is
 * unless `resetToRoster` says otherwise.
 *
 * Colour is the one exception. It encodes the stage rather than decorating, so
 * it is recomputed for every contact card and a hand-recoloured one gets
 * painted back.
 */
export function syncCanvasFromContacts(
  canvas: Canvas,
  profiles: CanvasProfile[],
  funnels: Funnel[],
  /**
   * Also drop file cards that are not contacts.
   *
   * Only the v0.2.0 migration passes this. It is converting a pre-0.2.0 thread
   * canvas, which had a card per message, into a roster; the user agreed to
   * that in the consent modal and a backup is written first. An ordinary sync
   * must never prune, or a note the user pinned here themselves vanishes on
   * the next tick.
   */
  resetToRoster = false,
): Canvas {
  const wanted = new Set(profiles.map((p) => p.profilePath));
  const isContactCard = (n: CanvasNode) =>
    n.type === "file" && n.file !== undefined && PROFILE_NOTE_PATH.test(n.file);
  const keep = (n: CanvasNode) => {
    if (n.type !== "file" || n.file === undefined) return true;
    return isContactCard(n) ? wanted.has(n.file) : !resetToRoster;
  };
  // Copied, not mutated in place: `filter` hands back the caller's own node
  // objects, so recolouring them would also change the canvas the caller is
  // about to diff against, and the write would be skipped as a no-op.
  const kept = canvas.nodes
    .filter(keep)
    .map((n) =>
      isContactCard(n)
        ? { ...n, color: colorForFunnel(funnelFromProfilePath(n.file!), funnels) }
        : { ...n },
    );
  const keptIds = new Set(kept.map((n) => n.id));
  const keptFiles = new Set(kept.map((n) => n.file).filter(Boolean));
  const edges = canvas.edges.filter((e) => keptIds.has(e.fromNode) && keptIds.has(e.toNode));

  const fresh = profiles
    .filter((p) => !keptFiles.has(p.profilePath))
    .sort((a, b) => a.username.localeCompare(b.username));
  let baseY = 0;
  for (const n of kept) {
    const bottom = (n.y ?? 0) + (n.height ?? NODE_H_PROFILE);
    if (bottom > baseY) baseY = bottom;
  }
  if (kept.length > 0) baseY += ROW_GAP;

  const added: CanvasNode[] = fresh.map((p, i) => ({
    id: newId(),
    type: "file",
    file: p.profilePath,
    x: (i % GRID_COLS) * (NODE_W + COL_GAP),
    y: baseY + Math.floor(i / GRID_COLS) * (NODE_H_PROFILE + ROW_GAP),
    width: NODE_W,
    height: NODE_H_PROFILE,
    color: colorForFunnel(funnelFromProfilePath(p.profilePath), funnels),
  }));

  return { nodes: [...kept, ...added], edges };
}

/** Whether two canvases would serialise identically, so a caller can skip a
 *  write that changes nothing. Compares the JSON, so key order counts; both
 *  sides here are built by the same code, so that is not a problem in
 *  practice, and a false "different" only costs one redundant write. */
export function canvasEquals(a: Canvas, b: Canvas): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Rewrite canvas node file paths that live under `oldPrefix` to sit under
 *  `newPrefix`. Used when a conversation folder moves between stage folders.
 *  Returns true if anything changed.
 */
export function rewriteCanvasPaths(canvas: Canvas, oldPrefix: string, newPrefix: string): boolean {
  const oldNorm = normalizePath(oldPrefix).replace(/\/$/, "") + "/";
  const newNorm = normalizePath(newPrefix).replace(/\/$/, "") + "/";
  let changed = false;
  for (const n of canvas.nodes) {
    if (n.type !== "file" || !n.file) continue;
    if (n.file.startsWith(oldNorm)) {
      n.file = newNorm + n.file.slice(oldNorm.length);
      changed = true;
    }
  }
  return changed;
}
