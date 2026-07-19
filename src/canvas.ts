import { App, TFile, normalizePath } from "obsidian";
import { Canvas, CanvasEdge, CanvasNode } from "./types";

const NODE_W = 320;
const NODE_H_PROFILE = 100;
const NODE_H_MESSAGE = 160;
const COL_GAP = 120;
const ROW_GAP = 40;
const PROFILE_GAP = 60;

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Assign a deterministic Obsidian-canvas-palette color (1-6) per sender.
 *  Keyed by a stable identifier (typically the sender's username) so the
 *  color survives a status-driven folder move that changes the profile path.
 */
function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return String((Math.abs(hash) % 6) + 1);
}

export async function loadCanvas(app: App, path: string): Promise<Canvas> {
  const normalized = normalizePath(path);
  if (!(await app.vault.adapter.exists(normalized))) {
    return { nodes: [], edges: [] };
  }
  const text = await app.vault.adapter.read(normalized);
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
  if (folder && !(await app.vault.adapter.exists(folder))) {
    await app.vault.createFolder(folder);
  }
  const body = JSON.stringify(canvas, null, 2) + "\n";
  const file = app.vault.getAbstractFileByPath(normalized);
  if (file instanceof TFile) {
    await app.vault.modify(file, body);
  } else {
    await app.vault.adapter.write(normalized, body);
  }
}

function findFileNode(canvas: Canvas, file: string): CanvasNode | null {
  for (const n of canvas.nodes) {
    if (n.type === "file" && n.file === file) return n;
  }
  return null;
}

function nextColumnX(canvas: Canvas): number {
  if (canvas.nodes.length === 0) return 0;
  let maxRight = -Infinity;
  for (const n of canvas.nodes) {
    const right = (n.x ?? 0) + (n.width ?? NODE_W);
    if (right > maxRight) maxRight = right;
  }
  return maxRight + COL_GAP;
}

function ensureProfileNode(canvas: Canvas, profilePath: string, colorKey: string): CanvasNode {
  const existing = findFileNode(canvas, profilePath);
  if (existing) return existing;
  const node: CanvasNode = {
    id: newId(),
    type: "file",
    file: profilePath,
    x: nextColumnX(canvas),
    y: 0,
    width: NODE_W,
    height: NODE_H_PROFILE,
    color: colorForKey(colorKey),
  };
  canvas.nodes.push(node);
  return node;
}

function findThreadTail(canvas: Canvas, profile: CanvasNode): CanvasNode {
  const byId = new Map<string, CanvasNode>(canvas.nodes.map((n) => [n.id, n]));
  const edgesFrom = new Map<string, CanvasEdge[]>();
  for (const e of canvas.edges) {
    if (e.fromSide === "bottom" && e.toSide === "top") {
      const list = edgesFrom.get(e.fromNode) ?? [];
      list.push(e);
      edgesFrom.set(e.fromNode, list);
    }
  }
  const seen = new Set<string>([profile.id]);
  let deepest = profile;
  const stack: CanvasNode[] = [profile];
  while (stack.length) {
    const cur = stack.pop() as CanvasNode;
    for (const edge of edgesFrom.get(cur.id) ?? []) {
      const nxt = byId.get(edge.toNode);
      if (!nxt || seen.has(nxt.id)) continue;
      seen.add(nxt.id);
      stack.push(nxt);
      if ((nxt.y ?? 0) > (deepest.y ?? 0)) deepest = nxt;
    }
  }
  return deepest;
}

export function addMessageToCanvas(
  canvas: Canvas,
  profilePath: string,
  msgPath: string,
  colorKey: string,
): Canvas {
  if (findFileNode(canvas, msgPath)) return canvas;
  const profile = ensureProfileNode(canvas, profilePath, colorKey);
  const tail = findThreadTail(canvas, profile);
  const isProfileTail = tail.id === profile.id;
  const gap = isProfileTail ? PROFILE_GAP : ROW_GAP;
  const newNode: CanvasNode = {
    id: newId(),
    type: "file",
    file: msgPath,
    x: tail.x,
    y: tail.y + (tail.height ?? NODE_H_MESSAGE) + gap,
    width: NODE_W,
    height: NODE_H_MESSAGE,
    color: profile.color,
  };
  canvas.nodes.push(newNode);
  canvas.edges.push({
    id: newId(),
    fromNode: tail.id,
    toNode: newNode.id,
    fromSide: "bottom",
    toSide: "top",
  });
  return canvas;
}

/** Rewrite canvas node file paths that live under `oldPrefix` to sit under
 *  `newPrefix`. Used when a conversation folder moves between status folders.
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
