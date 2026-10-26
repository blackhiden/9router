#!/usr/bin/env node
/**
 * verify-no-undef.mjs
 *
 * GUARD — DO NOT DELETE.
 *
 * Why this exists (root cause, 2026-10-24):
 *   The upstream merge (32d9fa2e) left several files with identifiers that are
 *   USED but never declared (e.g. ModelSelectModal `clineModels`/`clinepassModels`
 *   in a useMemo deps array, chatCore `tryNextPool` closures referencing removed
 *   helpers). `next build` COMPILED these fine — webpack/SWC does not check
 *   undefined identifiers — so the Docker image shipped bundles that crash at
 *   render time with ReferenceError ("This page couldn't load"). It already
 *   broke dashboard/combos (v1.0.25) and dashboard/providers/* (v1.0.24).
 *
 * Rule: after every upstream merge (or any dependency bump that brings new
 * code), run this sweep. It must print ✅ before the Docker build runs; CI
 * enforces it via the Dockerfile builder stage (step after `npm ci`).
 *
 *   Correct:  node scripts/verify-no-undef.mjs
 *   Fix:      declare/free the reported identifier, then re-run.
 *
 * Exit 1 = the build will ship a bundle that can crash at runtime.
 *
 * Usage: node scripts/verify-no-undef.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));

let Linter, globalsPkg;
try {
  ({ Linter } = require("eslint"));
  globalsPkg = require("globals");
} catch (err) {
  console.error(`❌ Dependency not installed (${err.message}). Run: npm ci`);
  process.exit(1);
}

const linter = new Linter({ configType: "flat" });
const envGlobals = {
  ...globalsPkg.browser,
  ...globalsPkg.node,
  ...globalsPkg.es2024,
};

const files = [];
for (const dir of ["src", "open-sse"]) {
  (function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(p);
      else if (/\.jsx?$/.test(entry.name)) files.push(p);
    }
  })(join(root, dir));
}

let failures = 0;
for (const file of files) {
  const messages = linter.verify(readFileSync(file, "utf8"), {
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: envGlobals,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { "no-undef": "error" },
  }, { filename: file });
  for (const m of messages) {
    if (m.ruleId !== "no-undef") continue;
    failures++;
    console.error(`❌ ${file}:${m.line}:${m.column}  ${m.message}`);
  }
}

if (failures > 0) {
  console.error(
    [
      "",
      `❌ ${failures} undefined identifier${failures === 1 ? "" : "s"} across ${files.length} files.`,
      "",
      "   webpack/SWC compiles these fine but the bundle ReferenceErrors at runtime",
      '   ("This page couldn\'t load"). Declare or remove each identifier above.',
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`✅ no-undef clean: 0 undefined identifiers across ${files.length} files (src + open-sse).`);
