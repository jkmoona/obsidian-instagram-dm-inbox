/**
 * The poll loop runs every few seconds, so any warning on it has to assume its
 * condition is persistent. These lock in that a stuck endpoint produces one
 * line rather than one line per tick, which is what buried the console before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, __setRequestUrl } from "obsidian";
import IgCrmPlugin from "../src/main";
import { DEFAULT_SETTINGS, PluginSettings } from "../src/types";
import { makeSettings } from "./harness";
import { __resetWarnings, setDebugLogging } from "../src/log";

const IGSID = "IG_PEER";
const USER = "peer";

function makePlugin(app: App, overrides: Partial<PluginSettings> = {}) {
  const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(app);
  plugin.settings = {
    ...makeSettings({ serverUrl: "https://server.test", apiKey: "k", ...overrides }),
  };
  const anyPlugin = plugin as unknown as Record<string, unknown>;
  return {
    plugin,
    tick: () => (anyPlugin.tick as (m?: boolean) => Promise<void>).call(plugin, false),
  };
}

beforeEach(() => {
  __resetWarnings();
  setDebugLogging(false);
  (globalThis as never as Record<string, unknown>).__notices = [];
});

afterEach(() => {
  __setRequestUrl(null);
  vi.restoreAllMocks();
});

describe("log volume on the poll loop", () => {
  it("logs a persistently failing getContacts once, not once per tick", async () => {
    // getContacts failing deliberately does NOT increment consecutiveFailures,
    // so nothing backs it off. Before the change this was one line every poll
    // interval, forever.
    const app = new App();
    app.vault.folders.add("CRM");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setRequestUrl((p) => {
      const url = String(p.url);
      if (url.includes("/api/contacts")) return { status: 500, json: { detail: "down" } };
      return { status: 200, json: [] };
    });

    const { tick } = makePlugin(app);
    for (let i = 0; i < 10; i++) await tick();

    const contactWarns = warn.mock.calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("getContacts")),
    );
    expect(contactWarns).toHaveLength(1);
  });

  it("warns again after the endpoint recovers and fails a second time", async () => {
    // Suppression that never resets would be worse than the noise: a second,
    // genuinely new outage would go unreported.
    const app = new App();
    app.vault.folders.add("CRM");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let healthy = false;
    __setRequestUrl((p) => {
      const url = String(p.url);
      if (url.includes("/api/contacts")) {
        return healthy ? { status: 200, json: [] } : { status: 500, json: {} };
      }
      return { status: 200, json: [] };
    });

    const { tick } = makePlugin(app);
    await tick();
    healthy = true;
    await tick();
    healthy = false;
    await tick();

    const contactWarns = warn.mock.calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("getContacts")),
    );
    expect(contactWarns).toHaveLength(2);
  });

  it("does not log once per contact when profile notes are missing", async () => {
    // A second device before its sync lands: the server knows 20 contacts and
    // the vault has none of them. That used to be 20 warnings every tick.
    const app = new App();
    app.vault.folders.add("CRM");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const rows = Array.from({ length: 20 }, (_, i) => ({
      sender_igsid: `${IGSID}${i}`,
      sender_username: `${USER}${i}`,
      funnel: "new",
      updated_at: 1,
    }));
    __setRequestUrl((p) => {
      const url = String(p.url);
      if (url.includes("/api/contacts")) return { status: 200, json: rows };
      return { status: 200, json: [] };
    });

    const { tick } = makePlugin(app);
    await tick();
    await tick();

    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled(); // debug logging is off by default
  });

  it("surfaces the skipped count when debug logging is on", async () => {
    const app = new App();
    app.vault.folders.add("CRM");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    __setRequestUrl((p) => {
      const url = String(p.url);
      if (url.includes("/api/contacts")) {
        return {
          status: 200,
          json: [{ sender_igsid: IGSID, sender_username: USER, funnel: "new", updated_at: 1 }],
        };
      }
      return { status: 200, json: [] };
    });

    const { tick } = makePlugin(app, { debugLogging: true });
    setDebugLogging(true);
    await tick();

    expect(
      debug.mock.calls.some((c) => c.some((a) => typeof a === "string" && a.includes("skipped 1"))),
    ).toBe(true);
  });

  it("keeps debug logging off by default", () => {
    expect(DEFAULT_SETTINGS.debugLogging).toBe(false);
  });
});
