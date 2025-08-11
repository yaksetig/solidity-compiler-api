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

// ---------- Config ----------
const PORT = process.env.PORT || 8080;
const MAX_SOURCES = Number(process.env.MAX_SOURCES ?? 64);
const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES ?? 1_500_000); // ~1.5MB
const ALLOW_REDIRECTS = true; // for CDNs
const DEFAULT_NPM_CDN = process.env.NPM_CDN ?? "https://unpkg.com"; // could be jsDelivr

// ---------- App ----------
const app = express();
app.use(helmet());
app.use(morgan("tiny"));
app.use(bodyParser.json({ limit: "512kb" }));
app.use(rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

// ---------- Helpers ----------
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

function isHttp(u) {
  return /^https?:\/\//i.test(u);
}

function parseGithubShorthand(s) {
  // github:owner/repo@ref/path/to/file.sol
  const m = /^github:([^/]+)\/([^@]+)@([^/]+)\/(.+)$/.exec(s);
  if (!m) return null;
  const [, owner, repo, ref, filePath] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

function parseNpmSpec(s, pkgVersions = {}) {
  // Accept either:
  //  - npm:@scope/pkg@1.2.3/path/to/file.sol
  //  - @scope/pkg/path/to/file.sol  (version pulled from pkgVersions map)
  if (s.startsWith("npm:")) {
    const body = s.slice(4);
    const m = /^(@?[^/@]+\/?[^@/]*)@([^/]+)\/(.+)$/.exec(body);
    if (!m) throw new Error(`Invalid npm import: ${s}`);
    const [, pkg, ver, rest] = m;
    return `${DEFAULT_NPM_CDN}/${pkg}@${ver}/${rest}`;
  }
  // Bare package form requiring version mapping:
  if (/^@?[^./][^:]*\//.test(s)) {
    // e.g., @openzeppelin/contracts/...
    const parts = s.split("/");
    const pkg = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    const rest = parts[0].startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
    const ver = pkgVersions[pkg];
    if (!ver) {
      throw new Error(`Missing version for package "${pkg}". Provide "packageVersions": { "${pkg}": "<version>" }`);
    }
    return `${DEFAULT_NPM_CDN}/${pkg}@${ver}/${rest}`;
  }
  return null;
}

function resolveImportPath(raw, parentBase, pkgVersions) {
  if (isHttp(raw)) return new URL(raw, parentBase || undefined).toString();

  if (raw.startsWith("github:")) {
    const u = parseGithubShorthand(raw);
    if (!u) throw new Error(`Invalid GitHub shorthand: ${raw}`);
    return u;
  }

  if (raw.startsWith("npm:") || /^[^./]/.test(raw)) {
    const u = parseNpmSpec(raw, pkgVersions);
    if (u) return u;
  }

  // Relative path
  if (raw.startsWith("./") || raw.startsWith("../")) {
    if (!parentBase) throw new Error(`Relative import "${raw}" has no base context`);
    return new URL(raw, parentBase).toString();
  }

  throw new Error(`Unsupported import path: ${raw}`);
}

function extractImports(sol) {
  // Handles: import "x";  import * as Y from "x";  import {A as B} from "x";
  const regex = /import\s+(?:[^'"]*from\s+)?["']([^"']+)["']\s*;/g;
  const out = [];
  let m;
  while ((m = regex.exec(sol)) !== null) out.push(m[1]);
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: ALLOW_REDIRECTS ? "follow" : "manual" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

function keyFromUrl(url) {
  // a stable key for sources map; use the full URL string
  return url;
}

async function resolveAllSources(entryContent, entryKey, options) {
  const { packageVersions = {}, maxSources = MAX_SOURCES, maxBytes = MAX_TOTAL_BYTES } = options || {};
  const sources = new Map(); // key -> { content, baseUrl? }
  const queue = [];
  let totalBytes = 0;

  sources.set(entryKey, { content: entryContent, baseUrl: null });
  queue.push({ key: entryKey, baseUrl: null, content: entryContent });

  const visited = new Set([entryKey]);

  while (queue.length) {
    if (sources.size > maxSources) throw new Error(`Too many source files (> ${maxSources})`);
    const { key, baseUrl, content } = queue.shift();
    const imps = extractImports(content);

    for (const imp of imps) {
      let resolvedUrl;
      try {
        resolvedUrl = resolveImportPath(imp, baseUrl, packageVersions);
      } catch (e) {
        throw new Error(`Import resolution error for "${imp}" in "${key}": ${e.message}`);
      }
      const childKey = keyFromUrl(resolvedUrl);
      if (visited.has(childKey)) continue;
      visited.add(childKey);

      const childText = await fetchText(resolvedUrl);
      totalBytes += Buffer.byteLength(childText, "utf8");
      if (totalBytes > maxBytes) throw new Error(`Total import size exceeded (${maxBytes} bytes)`);

      sources.set(childKey, { content: childText, baseUrl: new URL(resolvedUrl).toString() });
      queue.push({ key: childKey, baseUrl: resolvedUrl, content: childText });

      if (sources.size > maxSources) throw new Error(`Too many source files (> ${maxSources})`);
    }
  }

  // Convert to standard-json "sources" map
  const stdSources = {};
  for (const [k, v] of sources.entries()) stdSources[k] = { content: v.content };
  return stdSources;
}

// ---------- API ----------
app.post("/compile", async (req, res) => {
  try {
    const {
      source,
      filename,
      compilerVersion,      // e.g., "0.8.26"
      returnArtifacts,
      packageVersions,      // e.g., { "@openzeppelin/contracts": "5.0.2" }
      settings              // optional solc settings override
    } = req.body || {};

    if (typeof source !== "string" || !source.trim()) {
      return res.status(400).json({ success: false, error: "Missing 'source' string." });
    }

    const safeName =
      (filename && filename.replace(/[^a-zA-Z0-9_.-]/g, "")) || `Contract_${uuidv4().slice(0, 8)}.sol`;

    // 1) Write a temp .sol file (your hard requirement)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "solc-"));
    const filePath = path.join(tmpDir, safeName);
    await fs.writeFile(filePath, source, "utf8");

    // 2) Resolve imports recursively and build sources
    //    The entry key is the local filename; relative imports inside the entry are not allowed
    //    unless you also provide a base (use absolute URLs or npm/github shorthands).
    const sourcesMap = await resolveAllSources(source, safeName, { packageVersions });

    // 3) Build standard JSON
    const input = buildStandardJson(sourcesMap, settings);

    // 4) Pick compiler version
    let compiler = solc;
    if (compilerVersion && /^v?\d+\.\d+\.\d+/.test(compilerVersion)) {
      const ver = compilerVersion.startsWith("v") ? compilerVersion : `v${compilerVersion}`;
      const load = await new Promise((resolve, reject) => {
        solc.loadRemoteVersion(ver, (err, solcSpecific) => (err ? reject(err) : resolve(solcSpecific)));
      });
      compiler = load;
    }

    // 5) Compile (no import callback needed)
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

    // Cleanup best-effort
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}

    res.status(200).json(base);
  } catch (err) {
    res.status(200).json({ success: false, error: String(err?.message || err) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`sol-compile-api listening on :${PORT}`));
