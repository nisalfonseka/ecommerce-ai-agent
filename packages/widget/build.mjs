// Bundles the widget into one script (dist/ace.js) and enforces the size budget (Phase 4 exit: < 60 kB gzipped).
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const BUDGET_BYTES = 60 * 1024;

await build({
  entryPoints: ["src/main.tsx"],
  outfile: "dist/ace.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  sourcemap: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  legalComments: "none",
});

const gzipped = gzipSync(readFileSync("dist/ace.js")).length;
console.log(`dist/ace.js: ${(gzipped / 1024).toFixed(1)} kB gzipped (budget ${BUDGET_BYTES / 1024} kB)`);
if (gzipped > BUDGET_BYTES) {
  console.error("Widget bundle is over budget.");
  process.exit(1);
}
