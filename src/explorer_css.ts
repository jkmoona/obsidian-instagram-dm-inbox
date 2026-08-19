import { colorVarForIndex } from "./palette";
import { Funnel, funnelFolderName } from "./types";
import { META_FOLDER } from "./vault";

function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * CSS injected into the app to make the file explorer read as a CRM board:
 * the plugin-managed `_meta/` folder is hidden, and each funnel stage folder
 * gets a colored title plus a matching left rail over its conversations.
 *
 * Generated rather than kept in styles.css because CSS cannot interpolate a
 * user-defined folder name into a `[data-path=...]` selector.
 *
 * Moving the declarations into styles.css and leaving only custom properties
 * here was tried and reverted. Custom properties inherit, so a colour set on a
 * stage folder cascades onto every conversation folder nested inside it, and
 * the rail shows up on all of them. Registering them `inherits: false` swaps
 * that for a worse problem, since a registered property resolves to its initial
 * value instead of the `var()` fallback and restyles every folder in the vault.
 */
export function buildExplorerCss(crmFolder: string, funnels: Funnel[]): string {
  const crm = escapeAttr(crmFolder);
  const rules: string[] = [
    `.nav-folder:has(> .nav-folder-title[data-path="${crm}/${META_FOLDER}"]) { display: none; }`,
  ];
  funnels.forEach((s, i) => {
    const path = `${crm}/${escapeAttr(funnelFolderName(s.name))}`;
    const color = `var(${colorVarForIndex(i)})`;
    rules.push(
      `.nav-folder-title[data-path="${path}"] { color: ${color}; font-weight: 600; }`,
      `.nav-folder:has(> .nav-folder-title[data-path="${path}"]) { border-left: 2px solid ${color}; border-radius: 0; }`,
    );
  });
  return rules.join("\n");
}
