/**
 * Funnel stage colors, shared so the canvas and the graph view agree. Indexed by
 * stage position and cycled beyond the end.
 *
 * A parallel list of theme variables used to live here for the file explorer,
 * whose colours were applied through a generated stylesheet. The 0.2.0 community
 * review rejects building a stylesheet at runtime, so the explorer no longer
 * colours stages and the variables went with it. Both remaining surfaces need
 * concrete numbers rather than theme variables: a canvas node stores a colour in
 * the `.canvas` file and a graph group stores one in `graph.json`, so neither can
 * hold a `var()`.
 */

// Graph color groups need concrete RGB integers.
export const FUNNEL_COLOR_HEX = [
  0x4c8dff, // blue
  0xe3b341, // yellow
  0x3fb950, // green
  0xf85149, // red
  0xa371f7, // purple
  0x39c5cf, // cyan
  0xdb6d28, // orange
  0xdb61a2, // pink
];

/** Wrap into range for any integer. A plain `%` keeps the sign in JS, so a
 *  negative index would read past the start of the array and yield undefined. */
function wrap(i: number, length: number): number {
  if (!Number.isFinite(i)) return 0;
  return ((Math.trunc(i) % length) + length) % length;
}

export function colorHexForIndex(i: number): number {
  return FUNNEL_COLOR_HEX[wrap(i, FUNNEL_COLOR_HEX.length)];
}

/** `#rrggbb` for canvas nodes, which take a hex string or a preset digit.
 *  Padded, or any colour below 0x100000 would emit five digits. */
export function colorCssHexForIndex(i: number): string {
  return `#${colorHexForIndex(i).toString(16).padStart(6, "0")}`;
}
