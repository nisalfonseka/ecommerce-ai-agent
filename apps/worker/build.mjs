// Bundles the worker for production (same scheme as apps/engine/build.mjs). Workspace packages (@ace/*) ship
// TypeScript source, so they are bundled; npm packages stay external. The worker runs from the engine image,
// on the engine's production node_modules, so every external must be a dependency of the worker AND the engine.
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const deps = (path) =>
  new Set(Object.keys(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).dependencies ?? {}));
const declared = deps("./package.json");
const engine = deps("../engine/package.json");
const builtins = new Set(builtinModules);
const missing = new Set();
const notInEngine = new Set();

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

await build({
  entryPoints: { worker: "src/main.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  plugins: [
    {
      name: "externalize-npm",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@ace/")) return undefined;
          const name = packageName(args.path.replace(/^node:/, ""));
          if (!args.path.startsWith("node:") && !builtins.has(name)) {
            if (!declared.has(name)) missing.add(name);
            if (!engine.has(name)) notInEngine.add(name);
          }
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
if (missing.size > 0) {
  console.error(
    `Add these to apps/worker dependencies (imported by bundled code): ${[...missing].sort().join(", ")}`,
  );
  process.exit(1);
}
if (notInEngine.size > 0) {
  console.error(
    `Add these to apps/engine dependencies (the worker ships in its image): ${[...notInEngine].sort().join(", ")}`,
  );
  process.exit(1);
}
console.log("built dist/worker.js");
