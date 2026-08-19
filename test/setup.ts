/**
 * Minimal globals Obsidian provides but a node test environment does not.
 *
 * Without these, any code path reaching `saveSettings()` throws
 * `ReferenceError: window is not defined` deep inside `restartPollTimer`. That
 * is worse than a plain failure: several call sites wrap their work in a
 * try/catch, so the throw is swallowed and the test passes having silently
 * skipped the save it was meant to exercise.
 *
 * The interval is deliberately inert. Nothing here is testing the poll loop,
 * and a real one would keep firing ticks between tests. Tests that need to let
 * microtasks drain use the global setTimeout, not this object.
 */
const timers = {
  setInterval: () => 0,
  clearInterval: () => undefined,
};

const g = globalThis as unknown as Record<string, unknown>;
if (g.window === undefined) {
  g.window = {
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  };
}
if (g.document === undefined) {
  // applyExplorerCss appends a <style> element. Enough shape to accept it.
  const el = () => ({
    textContent: "",
    remove: () => undefined,
    appendChild: () => undefined,
  });
  g.document = { createElement: el, head: el() };
}
