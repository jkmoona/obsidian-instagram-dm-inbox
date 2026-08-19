/**
 * The settings object every test file needs, built the one safe way.
 *
 * `{ ...DEFAULT_SETTINGS }` is a shallow copy, so it hands out DEFAULT_SETTINGS'
 * own array and objects for `funnels`, the two caches and `writtenMids`. A test
 * that writes through any of them mutates the module-level default and the next
 * file inherits it. Six fixtures each re-implemented the copying by hand; this
 * is that defence in one place, so no file can forget a field.
 *
 * `crmFolder` is pinned to "CRM" because the fixtures seed paths under CRM/,
 * while the shipped default is "Instagram DMs" for a fresh install. Tests state
 * the folder they build rather than tracking whatever the default becomes.
 */
import { App } from "obsidian";
import IgCrmPlugin from "../src/main";
import { DEFAULT_SETTINGS, PluginSettings } from "../src/types";

export function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    crmFolder: "CRM",
    funnels: DEFAULT_SETTINGS.funnels.map((f) => ({ ...f })),
    contactFunnelCache: {},
    pendingFunnel: {},
    writtenMids: [],
    // Tests that care about the migration gate set this false explicitly.
    migratedToV02: true,
    ...overrides,
  };
}

/** A plugin instance with those settings, without running onload(). */
export function newPlugin(app: App, overrides: Partial<PluginSettings> = {}): IgCrmPlugin {
  const plugin = new (IgCrmPlugin as unknown as new (a: App) => IgCrmPlugin)(app);
  plugin.settings = makeSettings(overrides);
  return plugin;
}
