import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const out = resolve(root, "dist/unpacked");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
};

await build({ ...common, entryPoints: [resolve(root, "src/background.ts")], outfile: resolve(out, "background.js") });
await build({ ...common, entryPoints: [resolve(root, "src/ui/app.ts")], outfile: resolve(out, "app.js") });
await build({ ...common, entryPoints: [resolve(root, "src/ui/popup.ts")], outfile: resolve(out, "popup.js") });

await cp(resolve(root, "src/manifest.json"), resolve(out, "manifest.json"));
await cp(resolve(root, "src/ui/app.html"), resolve(out, "app.html"));
await cp(resolve(root, "src/ui/app.css"), resolve(out, "app.css"));
await cp(resolve(root, "src/ui/popup.html"), resolve(out, "popup.html"));
await cp(resolve(root, "src/ui/popup.css"), resolve(out, "popup.css"));
await cp(resolve(root, "src/ui/icon.png"), resolve(out, "icon.png"));

console.log("dist/unpacked");
