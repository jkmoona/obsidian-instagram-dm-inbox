import { colorHexForIndex } from "./palette";
import { Funnel, funnelFolderName } from "./types";

/** A single entry in Obsidian's graph-view `colorGroups` config. */
export interface GraphColorGroup {
  query: string;
  color: { a: number; rgb: number };
}

export function funnelQuery(crmFolder: string, funnelName: string): string {
  return `path:"${crmFolder}/${funnelFolderName(funnelName)}"`;
}

/** Graph filter terms that hide message notes and the canvas, leaving the rest
 *  of the vault visible. Anchored with slashes because `path:` matches any
 *  substring: a bare `-path:_history` would also hide a contact called
 *  `@art_history`, and `-path:_meta` would hide `@custom_metalworks`. */
export const GRAPH_FILTER_TERMS = ['-path:"/_history/"', '-path:"/_meta/"'];

/** Terms written before the anchoring fix, replaced in place when seen. */
const LEGACY_FILTER_TERMS = ["-path:_history", "-path:_meta"];

/** Append whichever filter terms are missing, keeping anything the user
 *  already typed. Returns `existing` untouched when nothing needs changing. */
export function buildGraphFilter(existing: string): string {
  const terms = existing.trim().split(/\s+/).filter(Boolean);
  const upgraded = terms.map((t) => {
    const legacy = LEGACY_FILTER_TERMS.indexOf(t);
    return legacy >= 0 ? GRAPH_FILTER_TERMS[legacy] : t;
  });
  for (const term of GRAPH_FILTER_TERMS) {
    if (!upgraded.includes(term)) upgraded.push(term);
  }
  const next = upgraded.join(" ");
  return next === existing.trim() ? existing : next;
}

/**
 * Merge one color group per funnel stage into the user's existing groups.
 * Purely additive: existing groups keep their order and colors, and a stage whose
 * query is already present is skipped, so running this repeatedly is a no-op.
 */
export function buildGraphColorGroups(
  crmFolder: string,
  funnels: Funnel[],
  existing: GraphColorGroup[],
): GraphColorGroup[] {
  const present = new Set(existing.map((g) => g.query));
  const added = funnels
    .map((s, i) => ({
      query: funnelQuery(crmFolder, s.name),
      color: { a: 1, rgb: colorHexForIndex(i) },
    }))
    .filter((g) => !present.has(g.query));
  return [...existing, ...added];
}

export interface GraphUpdate {
  /** The user's config with our groups and filter merged in. */
  config: Record<string, unknown>;
  addedGroups: number;
  filterChanged: boolean;
}

/**
 * Merge our colour groups and filter terms into a parsed `graph.json`.
 *
 * Kept apart from the file handling so the merge, which is the part that has
 * to leave the user's own groups and filter text intact, can be tested without
 * a vault. Returns a new object; the input is not modified.
 */
export function applyGraphSettings(
  config: Record<string, unknown>,
  crmFolder: string,
  funnels: Funnel[],
): GraphUpdate {
  const existingGroups = Array.isArray(config.colorGroups)
    ? (config.colorGroups as GraphColorGroup[])
    : [];
  const groups = buildGraphColorGroups(crmFolder, funnels, existingGroups);
  const existingFilter = typeof config.search === "string" ? config.search : "";
  const filter = buildGraphFilter(existingFilter);
  return {
    config: { ...config, colorGroups: groups, search: filter },
    addedGroups: groups.length - existingGroups.length,
    filterChanged: filter !== existingFilter,
  };
}
