import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import builtins from "builtin-modules";

// Load plugin/.env.local (gitignored) if present. Minimal parser — no
// dependency needed. Existing process.env values win over file values.
const envLocal = path.resolve("./.env.local");
if (fs.existsSync(envLocal)) {
  for (const raw of fs.readFileSync(envLocal, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

const prod = process.argv[2] === "production";

// If OBSIDIAN_VAULT_PATH is set, write outputs straight into the vault so
// there's no manual copy/unzip step. Falls back to `plugin/main.js` in the
// repo when unset — CI + packaging builds keep working unchanged.
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
const installDir = vaultPath
  ? path.join(vaultPath, ".obsidian", "plugins", "instagram-dm-inbox")
  : null;
const outfile = installDir ? path.join(installDir, "main.js") : "main.js";

if (installDir) {
  fs.mkdirSync(installDir, { recursive: true });
  console.log(`installing to ${installDir}`);
}

const copyAssetsPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => {
      if (!installDir) return;
      for (const asset of ["manifest.json", "styles.css"]) {
        try {
          fs.copyFileSync(asset, path.join(installDir, asset));
        } catch (e) {
          console.warn(`copy ${asset} failed:`, e.message);
        }
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile,
  minify: prod,
  plugins: [copyAssetsPlugin],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
