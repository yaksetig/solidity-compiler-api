import express from "express";
import morgan from "morgan";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bodyParser from "body-parser";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import solc from "solc";

// ============================ Config ============================
const PORT = process.env.PORT || 8080;

// import graph limits
const MAX_SOURCES = Number(process.env.MAX_SOURCES ?? 64);
const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES ?? 1_500_000); // ~1.5MB

// package/CDN config
const DEFAULT_NPM_CDN = process.env.NPM_CDN ?? "https://unpkg.com";

// security: only fetch from these hosts
const ALLOWED_HOSTS = new Set([
  "unpkg.com",
  "raw.githubusercontent.com",
  "githubusercontent.com"
]);

// solc versions index
const SOLC_LIST_URL = "https://binaries.soliditylang.org/bin/list.json";

// ============================ App ============================
const app = express();
app.use(helmet());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});
app.use(morgan("tiny"));
app.use(bodyParser.json({ limit: "512kb" }));
app.use(rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

// ============================ Helpers ============================
function buildStandardJson(sourcesMap, settings = {}) {
  return {
    language: "Solidity",
    sources: sourcesMap, // { key: { content } }
    settings: {
      optimizer: { enabled: false, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      ...settings
    }
  };
}

function extractImportsWithRanges(sol) {
  // captures import "X"; or import ... from "X";
  const re = /import\s+(?:[^'"]*from\s+)?(['"])([^'"]+)\1\s*;/g;
  const out = [];
  let m;
  while ((m = re.exec(sol)) !== null) {
    out.push({ start: m.index, end: re.lastIndex, spec: m[2] });
  }
  return out;
}

function isHttp(u) {
  return /^https?:\/\//i.test(u);
}

function hostFromUrl(u) {
  try { return new URL(u).host; } catch { return ""; }
}

function assertAllowed(url) {
  const host = hostFromUrl(url);
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Disallowed host for imports: ${host}`);
  }
}

function parseGithubShorthand(s) {
  // github:owner/repo@ref/path/to/file.sol  →  https://raw.githubusercontent.com/owner/repo/ref/path/to/file.sol
  const m = /^github:([^/]+)\/([^@]+)@([^/]+)\/(.+)$/.exec(s);
  if (!m) return null;
  const [, owner, repo, ref, filePath] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

function parseNpmSpec(s, pkgVersions = {}) {
  // Accept:
  //  - npm:@scope/pkg@1.2.3/path/to/file.sol
  //  - @scope/pkg/path/to/file.sol  (version pulled from packageVersions map)
  if (s.startsWith("npm:")) {
    const body = s.slice(4);
    const m = /^(@?[^/@]+\/?[^@/]*)@([^/]+)\/(.+)$/.exec(body);
    if (!m) throw new Error(`Invalid npm import: ${s}`);
    const [, pkg, ver, rest] = m;
    return `${DEFAULT_NPM_CDN}/${pkg}@${ver}/${rest}`;
  }
  // Bare package path:
  if (/^@?[^./][^:]*\//.test(s)) {
    const parts = s.split("/");
    const pkg = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    const rest = parts[0].startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
    const ver = pkgVersions[pkg];
    if (!ver) throw new Error(`Missing version for package "${pkg}". Provide "packageVersions": { "${pkg}": "<version>" }`);
    return `${DEFAULT_NPM_CDN}/${pkg}@${ver}/${rest}`;
  }
  return null;
}

function resolveImportPath(raw, parentBase, pkgVersions) {
  if (isHttp(raw)) {
    const url = new URL(raw, parentBase || undefined).toString();
    assertAllowed(url);
    return url;
  }
  if (raw.startsWith("github:")) {
    const u = parseGithubShorthand(raw);
    if (!u) throw new Error(`Invalid GitHub shorthand: ${raw}`);
    assertAllowed(u);
    return u;
  }
  if (raw.startsWith("npm:") || /^[^./]/.test(raw)) {
    const u = parseNpmSpec(raw, pkgVersions);
    if (u) {
      assertAllowed(u);
      return u;
    }
  }
  if (raw.startsWith("./") || raw.startsWith("../")) {
    if (!parentBase) throw new Error(`Relative import "${raw}" has no base context`);
    const u = new URL(raw, parentBase).toString();
    assertAllowed(u);
    return u;
  }
  throw new Error(`Unsupported import path: ${raw}`);
}

async function fetchText(url, cache) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const txt = await res.text();
  cache.set(url, txt);
  return txt;
}

async function resolveAllSources(entryContent, entryKey, options) {
  const { packageVersions = {}, maxSources = MAX_SOURCES, maxBytes = MAX_TOTAL_BYTES } = options || {};

  // key -> { content, baseUrl, children: Map<origSpec, resolvedKey> }
  const nodes = new Map();
  const queue = [];
  const cache = new Map(); // url -> text (per request)

  let totalBytes = Buffer.byteLength(entryContent, "utf8");
  nodes.set(entryKey, { content: entryContent, baseUrl: null, children: new Map() });
  queue.push(entryKey);

  while (queue.length) {
    if (nodes.size > maxSources) throw new Error(`Too many source files (> ${maxSources})`);

    const key = queue.shift();
    const node = nodes.get(key);
    const { content, baseUrl } = node;

    const imps = extractImportsWithRanges(content);
    for (const imp of imps) {
      const resolved = resolveImportPath(imp.spec, baseUrl, packageVersions); // absolute URL
      const childKey = resolved; // canonical key for solc
      node.children.set(imp.spec, childKey);

      if (!nodes.has(childKey)) {
        const childText = await fetchText(resolved, cache);
        totalBytes += Buffer.byteLength(childText, "utf8");
        if (totalBytes > maxBytes) throw new Error(`Total import size exceeded (${maxBytes} bytes)`);
        nodes.set(childKey, { content: childText, baseUrl: resolved, children: new Map() });
        queue.push(childKey);
      }
      if (nodes.size > maxSources) throw new Error(`Too many source files (> ${maxSources})`);
    }
  }

  // Rewrite imports so specifiers match canonical child keys
  const stdSources = {};
  for (const [key, node] of nodes.entries()) {
    let text = node.content;
    const imps = extractImportsWithRanges(text).reverse(); // replace from end to start
    for (const imp of imps) {
      const resolvedKey = node.children.get(imp.spec);
      if (!resolvedKey) continue;
      const original = text.slice(imp.start, imp.end);
      const replaced = original.replace(imp.spec, resolvedKey);
      text = text.slice(0, imp.start) + replaced + text.slice(imp.end);
    }
    stdSources[key] = { content: text };
  }

  return stdSources;
}

// ----- compiler version helpers -----
async function resolveFullSolcTag(ver) {
  // Accepts "0.8.26" or "v0.8.26" and returns "v0.8.26+commit.<hash>"
  const semver = ver.replace(/^v/i, "");
  const res = await fetch(SOLC_LIST_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch solc versions list: ${res.status}`);
  const data = await res.json();
  const fname = data.releases[semver];
  if (!fname) throw new Error(`Compiler version ${semver} not found in releases`);
  const m = fname.match(/^soljson-(v\d+\.\d+\.\d+\+commit\.[0-9a-f]+)\.js$/i);
  if (!m) throw new Error(`Unexpected filename format for ${fname}`);
  return m[1];
}

async function loadCompiler(compilerVersion) {
  // No version: use bundled solc
  if (!compilerVersion) return solc;

  let tag = compilerVersion;
  if (/^\d+\.\d+\.\d+$/.test(compilerVersion) || /^v?\d+\.\d+\.\d+$/.test(compilerVersion)) {
    tag = await resolveFullSolcTag(compilerVersion);
  } else if (!/^v?\d+\.\d+\.\d+\+commit\.[0-9a-f]+$/i.test(compilerVersion)) {
    throw new Error(`Unsupported compilerVersion format: ${compilerVersion}`);
  }
  if (!tag.startsWith("v")) tag = `v${tag}`;

  return await new Promise((resolve, reject) => {
    solc.loadRemoteVersion(tag, (err, s) => (err ? reject(err) : resolve(s)));
  });
}

// ============================ API ============================
app.post("/compile", async (req, res) => {
  try {
    const {
      source,
      filename,
      compilerVersion,     // optional
      returnArtifacts,
      packageVersions,     // e.g., { "@openzeppelin/contracts": "5.0.2" }
      settings             // optional solc settings override
    } = req.body || {};

    if (typeof source !== "string" || !source.trim()) {
      return res.status(400).json({ success: false, error: "Missing 'source' string." });
    }

    // 1) write temp .sol (your constraint)
    const safeName =
      (filename && filename.replace(/[^a-zA-Z0-9_.-]/g, "")) || `Contract_${uuidv4().slice(0, 8)}.sol`;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "solc-"));
    const filePath = path.join(tmpDir, safeName);
    await fs.writeFile(filePath, source, "utf8");

    // 2) resolve + rewrite imports; entry key is the filename you provided
    const sourcesMap = await resolveAllSources(source, safeName, { packageVersions });

    // 3) build standard json
    const input = buildStandardJson(sourcesMap, settings);

    // 4) pick compiler
    const compiler = await loadCompiler(compilerVersion);

    // 5) compile (no import callback)
    const outputJSON = compiler.compile(JSON.stringify(input));
    const output = JSON.parse(outputJSON);

    const diagnostics = (output.errors || []).map((e) => ({
      type: e.type,
      severity: e.severity,
      message: e.formattedMessage,
      sourceLocation: e.sourceLocation || null
    }));
    const hasError = diagnostics.some((d) => d.severity === "error");

    const base = {
      success: !hasError,
      compiler: { version: compiler.version() },
      filename: safeName,
      files: Object.keys(sourcesMap),
      diagnostics
    };

    if (!hasError && returnArtifacts) {
      const artifacts = [];
      for (const [file, contracts] of Object.entries(output.contracts || {})) {
        for (const [name, artifact] of Object.entries(contracts)) {
          artifacts.push({
            file,
            contract: name,
            abi: artifact.abi,
            bytecode: artifact.evm?.bytecode?.object || ""
          });
        }
      }
      base.artifacts = artifacts;
    }

    // cleanup best-effort
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}

    res.status(200).json(base);
  } catch (err) {
    res.status(200).json({ success: false, error: String(err?.message || err) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`sol-compile-api listening on :${PORT}`));
