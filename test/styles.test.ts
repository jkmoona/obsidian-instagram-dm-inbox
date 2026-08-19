/**
 * Source-level guardrails for things a community reviewer greps for.
 *
 * These assert on the text of `src/` rather than on behaviour, which is
 * unusual, but each one encodes a mistake this plugin has actually shipped:
 * 0.1.1 was reviewed for styling via CSS classes and 0.2.0 reintroduced
 * setCssStyles anyway. A grep test turns "a reviewer might notice" into
 * "CI fails".
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExplorerCss } from "../src/explorer_css";

const SRC = join(__dirname, "..", "src");
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, text: readFileSync(join(SRC, f), "utf8") }));
const styles = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

describe("styling", () => {
  it("assigns no styles imperatively", () => {
    // setCssStyles, el.style.foo = ..., and inline style attributes.
    const banned = /setCssStyles\(|\.style\.[a-zA-Z]+\s*=|\bstyle:\s*["'`]/;
    const offenders = sources.filter((s) => banned.test(s.text)).map((s) => s.name);
    expect(offenders).toEqual([]);
  });

  it("defines every igcrm- class the source references", () => {
    const referenced = new Set<string>();
    for (const s of sources) {
      for (const m of s.text.matchAll(/["'`](igcrm-[a-z0-9-]+)["'`]/g)) referenced.add(m[1]);
    }
    // Sanity: if this set is empty the assertion below is vacuous.
    expect(referenced.size).toBeGreaterThan(0);
    for (const cls of referenced) {
      expect(styles, `styles.css is missing .${cls}`).toContain(`.${cls}`);
    }
  });
});

describe("vault API usage", () => {
  it("reaches for the adapter only where the Vault API cannot", () => {
    // graph.json lives in the config directory, which is outside the file
    // index, so the adapter is the only API that reaches it. Everywhere else
    // the Vault API applies and a reviewer will say so.
    // Asserted as "nowhere but inside setupGraphView" rather than as an exact
    // count in an exact file, so moving or renaming code cannot make this fail
    // for a reason that has nothing to do with adapter use.
    const elsewhere = sources.filter((s) => s.name !== "main.ts" && /vault\.adapter\./.test(s.text));
    expect(elsewhere.map((s) => s.name)).toEqual([]);

    const main = sources.find((s) => s.name === "main.ts")!.text;
    const start = main.search(/^ {2}(?:private )?async setupGraphView\(/m);
    expect(start).toBeGreaterThan(-1);
    const rest = main.slice(start);
    const end = rest.search(/\n {2}(?:private |async |\/\*\*)/);
    const body = end > 0 ? rest.slice(0, end) : rest;

    const inFunction = (body.match(/vault\.adapter\./g) ?? []).length;
    const inFile = (main.match(/vault\.adapter\./g) ?? []).length;
    expect(inFunction).toBeGreaterThan(0);
    expect(inFunction).toBe(inFile);
  });
});

describe("settings tab", () => {
  const settings = sources.find((s) => s.name === "settings.ts")!.text;

  it("keeps both the declarative and the imperative rendering paths", () => {
    // 0.1.4 added getSettingDefinitions and it silently suppressed a richer
    // display(); 0.1.6 removed it and lost settings-search indexing. One
    // assertion catches either mistake coming back.
    expect(settings).toContain("getSettingDefinitions(");
    expect(settings).toContain("display(");
  });

  it("overrides both control accessors", () => {
    // PluginSettingTab's own versions write straight to plugin data and never
    // call saveSettings(), which is the 0.1.4 bug in one line.
    expect(settings).toContain("getControlValue(");
    expect(settings).toContain("setControlValue(");
  });
});

describe("user stylesheets stay in charge", () => {
  it("never uses !important, so a snippet or theme can override anything", () => {
    // The generated sheet is injected into <head> at runtime, which already
    // gives it late-cascade position. Adding !important on top of that would
    // put the folder colours out of reach of the user's own CSS entirely.
    const generated = buildExplorerCss("CRM", [
      { name: "new", code: null },
      { name: "pending", code: "!pending" },
    ]);
    expect(generated).not.toContain("!important");
    expect(readFileSync(join(__dirname, "..", "styles.css"), "utf8")).not.toContain("!important");
  });
});
