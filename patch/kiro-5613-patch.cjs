#!/usr/bin/env node
// kiro-5613-patch.cjs: hotfix for an installed 9router 0.5.116 or 0.5.119 (macOS, Linux, Windows).
// https://github.com/decolua/9router/issues/5613 and https://github.com/decolua/9router/issues/5652
//
// Fixes two Kiro problems in the published 0.5.116 and 0.5.119 builds:
//  1. Every Kiro request fails with "This version of Kiro is no longer supported".
//     9router identifies as `kiro-ide/1.0.0` / `KiroIDE-0.10.32`, below Kiro's
//     client-version floor. The patch sends the Kiro IDE 1.4.154 identity on
//     inference, model list, usage, profile lookup and API-key validation.
//  2. Adding a Kiro IdC / Builder ID account fails with "fetch failed". 9router
//     offers only X25519 in the TLS handshake and AWS OIDC resets it. The patch
//     changes the default curve list to X25519:prime256v1:secp384r1 (X25519 stays
//     first; NINEROUTER_TLS_ECDH_CURVE still overrides it).
//
// Stop 9router first, run one of these, then start 9router again:
//   node kiro-5613-patch.cjs apply   [installDir]    patch (backs up every file it changes)
//   node kiro-5613-patch.cjs revert  [installDir]    restore the original files
//   node kiro-5613-patch.cjs status  [installDir]    show what is patched
//   node kiro-5613-patch.cjs verify  [installDir]    offline check of headers and TLS default
//   node kiro-5613-patch.cjs verify --online [dir]   one TLS handshake to AWS OIDC, no credentials
//
// installDir is found automatically for npm, bun and vite-plus global installs.
// Otherwise pass the folder that contains 9router's package.json.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync, execFileSync } = require("child_process");
const { createRequire } = require("module");

// The compiled snippets are identical across these releases; only the chunk
// files that hold the model catalog and one proxyFetch copy were renumbered.
const BUILDS = {
  "0.5.116": { catalog: 2365, tls: [7525, 9102, 9609] },
  "0.5.119": { catalog: 1866, tls: [7525, 9198, 9609] },
};
const SUPPORTED_VERSIONS = Object.keys(BUILDS);
const KIRO_IDE_VERSION = "1.4.154";
const TLS_ECDH_CURVE_DEFAULT = "X25519:prime256v1:secp384r1";
const MARK = "/*kiro-5613*/";
const SERVER_REL = "app/.next-cli-build/server";
const HELPER_REL = `${SERVER_REL}/kiro-identity-5613.cjs`;
const BACKUP_REL = "app/.kiro-5613-backup";

const HELPER_SOURCE = `"use strict";
// Added by kiro-5613-patch.cjs (decolua/9router#5613). Removed by "revert".
// Builds the User-Agent pair the Kiro IDE sends. The machine id is a sha256 of
// the account's most stable identifier, so no raw credential reaches a header.
const { createHash } = require("crypto");

const KIRO_IDE_VERSION = "${KIRO_IDE_VERSION}";
const SDK_VERSION = "1.0.0";
const CLIENTS = {
  streaming: { api: "codewhispererstreaming", metrics: "E" },
  runtime: { api: "codewhispererruntime", metrics: "N,E" },
};

function buildKiroIdentityHeaders(credentials, client = "runtime") {
  const seed =
    credentials?.providerSpecificData?.clientId
    || credentials?.refreshToken
    || credentials?.providerSpecificData?.profileArn
    || credentials?.apiKey
    || credentials?.accessToken
    || "kiro-anonymous";
  const machineId = createHash("sha256").update(String(seed)).digest("hex");
  const { api, metrics } = CLIENTS[client] || CLIENTS.runtime;
  const identity = \`KiroIDE-\${KIRO_IDE_VERSION}-\${machineId}\`;
  return {
    "User-Agent":
      \`aws-sdk-js/\${SDK_VERSION} ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 \` +
      \`api/\${api}#\${SDK_VERSION} m/\${metrics} \${identity}\`,
    "X-Amz-User-Agent": \`aws-sdk-js/\${SDK_VERSION} \${identity}\`,
  };
}

module.exports = { KIRO_IDE_VERSION, buildKiroIdentityHeaders };
`;

// ---------------------------------------------------------------------------
// Edits: exact compiled snippets from the 0.5.116 / 0.5.119 builds. Each `find` must occur
// exactly once in its file, or nothing is written. `replace(h)` gets the require
// expression for the helper, relative to the edited file.

const chunk = (n) => `${SERVER_REL}/chunks/${n}.js`;
const PROFILE_FETCH =
  'fetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles",{method:"POST",' +
  'headers:{"Content-Type":"application/json",Accept:"application/json",Authorization:`Bearer ${a}`}';
const ids = (h, args, client) => `...${h}.buildKiroIdentityHeaders(${args}${client ? `,"${client}"` : ""})`;

// The build ships three copies of proxyFetch; patch all of them.
const tlsDefault = (n) => ({
  file: chunk(n), what: `TLS curve default (proxyFetch, chunk ${n})`,
  find: 'process.env.NINEROUTER_TLS_ECDH_CURVE||"X25519"',
  replace: () => `process.env.NINEROUTER_TLS_ECDH_CURVE||${MARK}"${TLS_ECDH_CURVE_DEFAULT}"`,
});

const editsFor = (version) => [
  ...BUILDS[version].tls.map(tlsDefault),
  {
    file: chunk(5330), what: "inference headers (KiroExecutor.buildHeaders)",
    find: 'let d={...this.config.headers,"Amz-Sdk-Request":"attempt=1; max=3"',
    replace: (h) => `let d={...this.config.headers,${ids(h, "a", "streaming")},"Amz-Sdk-Request":"attempt=1; max=3"`,
  },
  {
    file: chunk(BUILDS[version].catalog), what: "live model catalog IDE version",
    find: 'let g="1.0.0",h="0.10.32",i="us-east-1"',
    replace: () => `let g="1.0.0",h=${MARK}"${KIRO_IDE_VERSION}",i="us-east-1"`,
  },
  {
    file: chunk(2409), what: "API-key validation (listAvailableApiKeyModels)",
    find: 'TokenType:"API_KEY",Accept:"application/json","User-Agent":"AWS-SDK-JS/3.0.0 kiro-ide/1.0.0","X-Amz-User-Agent":"aws-sdk-js/3.0.0 kiro-ide/1.0.0"}',
    replace: (h) => `TokenType:"API_KEY",Accept:"application/json",${ids(h, "{apiKey:a}")}}`,
  },
  {
    file: chunk(2409), what: "profile lookup (listAvailableProfiles)",
    find: '"x-amz-target":"AmazonCodeWhispererService.ListAvailableProfiles",Authorization:`Bearer ${a}`,Accept:"application/json"}',
    replace: (h) => `"x-amz-target":"AmazonCodeWhispererService.ListAvailableProfiles",Authorization:\`Bearer \${a}\`,Accept:"application/json",${ids(h, "{accessToken:a}")}}`,
  },
  {
    file: chunk(2409), what: "model list (listAvailableModels)",
    find: '"x-amz-target":"AmazonCodeWhispererService.ListAvailableModels",Authorization:`Bearer ${a}`,Accept:"application/json"}',
    replace: (h) => `"x-amz-target":"AmazonCodeWhispererService.ListAvailableModels",Authorization:\`Bearer \${a}\`,Accept:"application/json",${ids(h, "{accessToken:a,providerSpecificData:{profileArn:b}}")}}`,
  },
  {
    file: chunk(4279), what: "profile ARN lookup after sign-in (fetchKiroProfileArn)",
    find: PROFILE_FETCH,
    replace: (h) => `${PROFILE_FETCH.slice(0, -1)},${ids(h, "{accessToken:a}")}}`,
  },
  {
    file: `${SERVER_REL}/app/api/oauth/grok-cli/bulk-import/route.js`,
    what: "inlined copy of fetchKiroProfileArn",
    find: PROFILE_FETCH,
    replace: (h) => `${PROFILE_FETCH.slice(0, -1)},${ids(h, "{accessToken:a}")}}`,
  },
  {
    // Computed once at the top: inside the attempt closures `b` is shadowed.
    file: chunk(8271), what: "usage: shared identity",
    find: 'async function n(a,b,c=null){let e=b?.authMethod||"builder-id",',
    replace: (h) => `async function n(a,b,c=null){let _k5613=${h}.buildKiroIdentityHeaders({accessToken:a,providerSpecificData:b}),e=b?.authMethod||"builder-id",`,
  },
  {
    file: chunk(8271), what: "usage: codewhisperer-get",
    find: '"x-amz-user-agent":"aws-sdk-js/1.0.0 KiroIDE","user-agent":"aws-sdk-js/1.0.0 KiroIDE",...h,...i}',
    replace: () => `...${MARK}_k5613,...h,...i}`,
  },
  {
    file: chunk(8271), what: "usage: codewhisperer-post",
    find: '"x-amz-target":"AmazonCodeWhispererService.GetUsageLimits",Accept:"application/json",...h,...i}',
    replace: () => `"x-amz-target":"AmazonCodeWhispererService.GetUsageLimits",Accept:"application/json",...${MARK}_k5613,...h,...i}`,
  },
  {
    file: chunk(8271), what: "usage: q-get",
    find: '(0,f.U)("kiro").limitsPath}?${b}`,{method:"GET",headers:{Authorization:`Bearer ${a}`,Accept:"application/json",...h,...i}',
    replace: () => `(0,f.U)("kiro").limitsPath}?\${b}\`,{method:"GET",headers:{Authorization:\`Bearer \${a}\`,Accept:"application/json",...${MARK}_k5613,...h,...i}`,
  },
];

// ---------------------------------------------------------------------------
// Helpers

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const countOf = (text, s) => text.split(s).length - 1;
const abs = (install, rel) => path.join(install, ...rel.split("/"));

function requireExpr(fileRel) {
  let spec = path.posix.relative(path.posix.dirname(fileRel), HELPER_REL);
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return `${MARK}require(${JSON.stringify(spec)})`;
}

function writeAtomic(file, text) {
  const tmp = `${file}.kiro-5613-tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses to rename over a file another process (antivirus, indexer) holds open.
    if (!["EPERM", "EACCES", "EBUSY"].includes(err.code)) { fs.rmSync(tmp, { force: true }); throw err; }
    try { fs.copyFileSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  }
}

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { return null; }
}

function findInstalls() {
  const roots = [];
  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000, windowsHide: true }).trim();
    if (npmRoot) roots.push(npmRoot);
  } catch { /* npm not on PATH */ }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  roots.push(path.join(os.homedir(), ".bun", "install", "global", "node_modules"));
  const vitePlus = path.join(os.homedir(), ".vite-plus", "packages", "9router");
  if (fs.existsSync(vitePlus)) {
    for (const d of fs.readdirSync(vitePlus)) roots.push(path.join(vitePlus, d, "lib", "node_modules"));
  }
  // Keyed case-insensitively on Windows, where `npm root -g` and %APPDATA% can
  // spell the same folder with a different drive-letter case.
  const found = new Map();
  for (const root of roots) {
    const dir = path.join(root, "9router");
    const pkg = readPkg(dir);
    if (pkg?.name !== "9router") continue;
    const real = fs.realpathSync(dir);
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (!found.has(key)) found.set(key, { dir: real, version: pkg.version });
  }
  return [...found.values()];
}

function resolveInstall(arg) {
  if (arg) {
    const dir = path.resolve(arg);
    if (readPkg(dir)?.name !== "9router") throw new Error(`${dir} is not a 9router install (no 9router package.json)`);
    return dir;
  }
  const found = findInstalls();
  if (found.length === 1) return found[0].dir;
  const hint =
    "Pass the 9router folder explicitly, for example:\n" +
    "  npm:  node kiro-5613-patch.cjs apply \"<output of `npm root -g`>/9router\"\n" +
    "  pnpm: node kiro-5613-patch.cjs apply \"<output of `pnpm root -g`>/9router\"\n" +
    "  yarn: node kiro-5613-patch.cjs apply \"<output of `yarn global dir`>/node_modules/9router\"";
  if (found.length === 0) throw new Error(`no global 9router install found.\n${hint}`);
  const list = found.map(({ dir, version }) => `  ${dir}  (v${version})`).join("\n");
  throw new Error(`found ${found.length} 9router installs:\n${list}\n${hint}`);
}

function requireSupportedVersion(install) {
  const { version } = readPkg(install);
  if (!BUILDS[version]) {
    throw new Error(`this patch is for 9router ${SUPPORTED_VERSIONS.join(" or ")}; ${install} is ${version}. Nothing was changed.`);
  }
  return version;
}

// PID record the 9router launcher writes while it runs.
function runningPid() {
  const dataDir = process.platform === "win32"
    ? path.join(process.env.APPDATA || "", "9router")
    : path.join(os.homedir(), ".9router");
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dataDir, "launcher.pid"), "utf8"));
    for (const pid of [rec.serverPid, rec.cliPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); return pid; } catch (e) { if (e.code === "EPERM") return pid; }
    }
  } catch { /* no record */ }
  return null;
}

function warnIfRunning() {
  const pid = runningPid();
  if (pid) console.log(`Note: 9router seems to be running (pid ${pid}). Restart it after this step.\n`);
}

// ---------------------------------------------------------------------------
// Commands

function apply(install) {
  const version = requireSupportedVersion(install);
  warnIfRunning();
  const byFile = new Map();
  for (const e of editsFor(version)) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }

  // Validate every edit before writing anything.
  const planned = [];
  const errors = [];
  for (const [rel, edits] of byFile) {
    const file = abs(install, rel);
    if (!fs.existsSync(file)) { errors.push(`${rel}: file missing`); continue; }
    const original = fs.readFileSync(file, "utf8");
    if (original.includes(MARK)) { console.log(`= ${rel}: already patched`); continue; }
    let text = original;
    for (const e of edits) {
      const n = countOf(text, e.find);
      if (n !== 1) { errors.push(`${rel}: "${e.what}" matched ${n} times (expected 1)`); continue; }
      const replacement = e.replace(requireExpr(rel));
      text = text.replace(e.find, () => replacement);
    }
    planned.push({ rel, file, original, text, edits });
  }
  if (errors.length) throw new Error(`nothing was changed:\n  ${errors.join("\n  ")}`);

  const backupRoot = abs(install, BACKUP_REL);
  const manifestPath = path.join(backupRoot, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { files: {} };
  for (const p of planned) {
    const backup = abs(backupRoot, p.rel);
    if (!fs.existsSync(backup)) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, p.original);
    }
    manifest.files[p.rel] = { originalSha256: sha256(p.original) };
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version, patchedAt: new Date().toISOString() }, null, 2));

  // Write, then syntax-check what was written; roll everything back on any failure.
  const helper = abs(install, HELPER_REL);
  try {
    writeAtomic(helper, HELPER_SOURCE);
    for (const p of planned) writeAtomic(p.file, p.text);
    for (const f of [helper, ...planned.map((p) => p.file)]) {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe", windowsHide: true });
    }
  } catch (err) {
    revert(install, { quiet: true });
    throw new Error(`patch failed and was rolled back, nothing changed:\n${err.stderr?.toString() || err.message}`);
  }

  for (const p of planned) for (const e of p.edits) console.log(`+ ${p.rel}: ${e.what}`);
  console.log(`\nPatched 9router ${version} at ${install}`);
  console.log(`Backups: ${backupRoot}`);
  console.log("Start (or restart) 9router for the change to take effect.");
}

function revert(install, { quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  if (!quiet) warnIfRunning();
  const backupRoot = abs(install, BACKUP_REL);
  const manifestPath = path.join(backupRoot, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const { files } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const rel of Object.keys(files)) {
      const file = abs(install, rel);
      const backup = abs(backupRoot, rel);
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!current.includes(MARK)) { log(`= ${rel}: not patched, left as is`); continue; }
      if (!fs.existsSync(backup)) throw new Error(`backup missing for ${rel}; reinstall 9router to restore it`);
      writeAtomic(file, fs.readFileSync(backup));
      log(`- ${rel}: restored`);
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
  } else {
    log("No backup found; nothing to restore.");
  }
  fs.rmSync(abs(install, HELPER_REL), { force: true });
  log(`\nReverted ${install}. Start (or restart) 9router for the change to take effect.`);
}

function status(install) {
  const { version } = readPkg(install);
  console.log(`install: ${install}\nversion: ${version}${BUILDS[version] ? "" : `  (patch supports ${SUPPORTED_VERSIONS.join(" and ")} only)`}`);
  if (!BUILDS[version]) return;
  const EDITS = editsFor(version);
  let patched = 0;
  for (const rel of [...new Set(EDITS.map((e) => e.file))]) {
    const file = abs(install, rel);
    const n = fs.existsSync(file) ? countOf(fs.readFileSync(file, "utf8"), MARK) : 0;
    patched += n;
    console.log(`  ${rel}: ${n} patch marker(s)`);
  }
  console.log(`  helper: ${fs.existsSync(abs(install, HELPER_REL)) ? "present" : "absent"}`);
  console.log(`  backup: ${fs.existsSync(path.join(abs(install, BACKUP_REL), "manifest.json")) ? "present" : "absent"}`);
  console.log(patched === EDITS.length ? "\nPatched." : patched === 0 ? "\nNot patched." : `\nPartially patched (${patched}/${EDITS.length} markers).`);
}

// Loads the compiled server into one webpack runtime: every shared chunk plus the
// externals (Node built-ins, undici, next/*) the build declares only in route files.
function loadBuild(serverDir) {
  const rt = require(path.join(serverDir, "webpack-runtime.js"));
  for (const f of fs.readdirSync(path.join(serverDir, "chunks"))) {
    if (/^\d+\.js$/.test(f)) rt.C(require(path.join(serverDir, "chunks", f)));
  }
  const serverRequire = createRequire(path.join(serverDir, "webpack-runtime.js"));
  const externalRe = /[,{](\d+):a=>\{"use strict";a\.exports=require\("([^"]+)"\)\}/g;
  const walk = function* (dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(p);
      else if (e.name.endsWith(".js")) yield p;
    }
  };
  for (const file of walk(path.join(serverDir, "app"))) {
    for (const [, id, name] of fs.readFileSync(file, "utf8").matchAll(externalRe)) {
      if (!rt.m[id]) rt.m[id] = (module) => { module.exports = serverRequire(name); };
    }
  }
  return rt;
}

async function verifyOnline(rt) {
  delete process.env.NINEROUTER_TLS_ECDH_CURVE; // test the build's default
  const modules = Object.keys(rt.m).filter((id) => rt.m[id].toString().includes("NINEROUTER_TLS_ECDH_CURVE"));
  let failed = modules.length === 0 ? 1 : 0;
  if (failed) console.log("FAIL  no proxyFetch module found in the build");
  for (const id of modules) {
    const label = `AWS OIDC TLS handshake via proxyFetch module ${id} (node ${process.version})`;
    try {
      const res = await rt(id).proxyAwareFetch("https://oidc.us-east-1.amazonaws.com/client/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await res.text();
      const ok = res.status === 400; // an empty body is rejected after a successful handshake
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}: HTTP ${res.status}${ok ? " (400 is expected for the empty test body)" : ""}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${label}: ${err.cause?.code || err.name}: ${err.cause?.message || err.message}`);
    }
  }
  return failed;
}

async function verifyOffline(rt, serverDir) {
  const SECRETS = ["test-access-token", "test-refresh-token", "test-client-id", "test-api-key"];
  const calls = [];
  let failResponses = false;
  const fakeFetch = (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const body = {
      models: [{ modelId: "auto", modelName: "Auto" }],
      profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC" }],
      usageBreakdownList: [],
    };
    const ok = !failResponses;
    return Promise.resolve({
      ok, status: ok ? 200 : 500, statusText: ok ? "OK" : "stub", headers: new Headers(),
      json: async () => body, text: async () => (ok ? JSON.stringify(body) : ""),
    });
  };
  globalThis.fetch = fakeFetch;
  // Stub every proxyFetch module so no request leaves the machine.
  for (const id of Object.keys(rt.m)) {
    if (!rt.m[id].toString().includes("NINEROUTER_TLS_ECDH_CURVE")) continue;
    rt.m[id] = (module, exports, req) => {
      req.r(exports);
      req.d(exports, {
        default: () => fakeFetch,
        proxyAwareFetch: () => fakeFetch,
        getDirectDispatcher: () => () => undefined,
        getFreshRetryDispatcher: () => () => undefined,
        isStaleSocketError: () => () => false,
        resetDirectDispatchersForTests: () => () => {},
      });
    };
  }
  const load = (needle) => {
    const id = Object.keys(rt.m).find((m) => rt.m[m].toString().includes(needle));
    if (!id) throw new Error(`no compiled module contains ${JSON.stringify(needle)}`);
    return rt(id);
  };
  const pick = (exp, test) => Object.values(exp).find((v) => typeof v === "function" && test(v.toString()));

  const results = [];
  const header = (headers, name) => {
    const hits = Object.entries(headers).filter(([k]) => k.toLowerCase() === name);
    return { count: hits.length, value: hits.length ? String(hits[0][1]) : "" };
  };
  const version = KIRO_IDE_VERSION.replace(/\./g, "\\.");
  const check = (label, headers) => {
    const ua = header(headers, "user-agent");
    const amz = header(headers, "x-amz-user-agent");
    const problems = [];
    if (ua.count !== 1) problems.push(`${ua.count} User-Agent headers`);
    if (amz.count !== 1) problems.push(`${amz.count} X-Amz-User-Agent headers`);
    if (!new RegExp(`KiroIDE-${version}-[0-9a-f]{64}$`).test(ua.value)) problems.push(`User-Agent="${ua.value || "(none)"}"`);
    if (!new RegExp(`^aws-sdk-js/1\\.0\\.0 KiroIDE-${version}-[0-9a-f]{64}$`).test(amz.value)) problems.push(`X-Amz-User-Agent="${amz.value || "(none)"}"`);
    if (SECRETS.some((s) => ua.value.includes(s) || amz.value.includes(s))) problems.push("a credential appears in a header");
    results.push({ label, problems });
  };
  const capture = async (label, fn) => {
    const start = calls.length;
    try { await fn(); } catch (err) { results.push({ label, problems: [`threw: ${err.message}`] }); return; }
    const made = calls.slice(start);
    if (!made.length) { results.push({ label, problems: ["no request was made"] }); return; }
    made.forEach((c, i) => check(made.length > 1 ? `${label} #${i + 1} (${new URL(c.url).host})` : label, c.headers));
  };

  const credentials = {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    providerSpecificData: { clientId: "test-client-id", authMethod: "idc", region: "us-east-1" },
  };
  const Executor = pick(load('super("kiro"'), (s) => s.startsWith("class"));
  check("inference (generateAssistantResponse)",
    new Executor().buildHeaders(credentials, true, "https://q.us-east-1.amazonaws.com/generateAssistantResponse"));
  const catalog = pick(load("kiro-anonymous"), (s) => s.includes("accessToken"));
  await capture("model catalog (ListAvailableModels)", () => catalog(credentials, { forceRefresh: true }));
  const Service = pick(load("Failed to list API-key models"), (s) => s.startsWith("class"));
  const svc = new Service();
  await capture("API-key validation", () => svc.listAvailableApiKeyModels("test-api-key"));
  await capture("profile lookup (listAvailableProfiles)", () => svc.listAvailableProfiles("test-access-token"));
  await capture("model list (listAvailableModels)", () => svc.listAvailableModels("test-access-token", "arn:aws:codewhisperer:us-east-1:1:profile/A"));
  const profileArn = pick(load("codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles"), (s) => s.includes("ListAvailableProfiles"));
  await capture("profile ARN lookup (fetchKiroProfileArn)", () => profileArn("test-access-token"));
  const usage = pick(load("codewhisperer-get"), (s) => s.includes("Usage API not implemented"));
  failResponses = true; // make all three usage endpoints get tried
  await capture("usage", () => usage({ provider: "kiro", accessToken: "test-access-token", providerSpecificData: credentials.providerSpecificData }));

  const tlsRe = /process\.env\.NINEROUTER_TLS_ECDH_CURVE\|\|(?:\/\*kiro-5613\*\/)?"([^"]*)"/g;
  const chunksDir = path.join(serverDir, "chunks");
  const defaults = fs.readdirSync(chunksDir).filter((f) => f.endsWith(".js"))
    .flatMap((f) => [...fs.readFileSync(path.join(chunksDir, f), "utf8").matchAll(tlsRe)].map((m) => ({ f, value: m[1] })));
  if (!defaults.length) results.push({ label: "TLS curve default", problems: ["not found in the build"] });
  for (const { f, value } of defaults) {
    results.push({ label: `TLS curve default (chunks/${f})`, problems: value === TLS_ECDH_CURVE_DEFAULT ? [] : [`is "${value}" (expected "${TLS_ECDH_CURVE_DEFAULT}")`] });
  }

  for (const r of results) {
    console.log(`${r.problems.length ? "FAIL" : "PASS"}  ${r.label}${r.problems.length ? `\n      ${r.problems.join("\n      ")}` : ""}`);
  }
  const failed = results.filter((r) => r.problems.length).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed;
}

async function verify(install, { online }) {
  const serverDir = abs(install, SERVER_REL);
  if (!fs.existsSync(path.join(serverDir, "webpack-runtime.js"))) throw new Error(`no server build under ${serverDir}`);
  // Keep the real 9router data folder untouched while the build is loaded.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-kiro-5613-verify-"));
  process.env.DATA_DIR = dataDir;
  try {
    const rt = loadBuild(serverDir);
    return online ? await verifyOnline(rt) : await verifyOffline(rt, serverDir);
  } finally {
    // Best effort: on Windows a file the loaded build still holds open cannot be removed yet.
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const online = args.includes("--online");
  const dirArg = args.slice(1).find((a) => !a.startsWith("--"));
  if (!["apply", "revert", "status", "verify"].includes(cmd)) {
    console.log("usage: node kiro-5613-patch.cjs <apply|revert|status|verify [--online]> [installDir]");
    return 2;
  }
  const install = resolveInstall(dirArg);
  if (cmd === "apply") apply(install);
  else if (cmd === "revert") revert(install);
  else if (cmd === "status") status(install);
  else return (await verify(install, { online })) ? 1 : 0;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err.message}`);
    if (["EACCES", "EPERM"].includes(err.code)) {
      console.error(process.platform === "win32"
        ? "The 9router folder is not writable. Open the terminal as Administrator and run the command again."
        : "The 9router folder is not writable. Run the same command with sudo.");
    }
    process.exit(1);
  },
);
