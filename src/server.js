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

const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(morgan("tiny"));
app.use(bodyParser.json({ limit: "256kb" })); // keep it small/cheap
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// Simple import callback that supports HTTP(S) URLs only.
// (Single-file sources with no imports work out of the box.)
async function importCallback(url) {
  try {
    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) return { error: `Failed to fetch ${url}: ${res.status}` };
      const content = await res.text();
      return { contents: content };
    }
    return { error: `Unsupported import: ${url}. Only http(s) URLs supported in this MVP.` };
  } catch (e) {
    return { error: `Import error for ${url}: ${e.message}` };
  }
}

function buildStandardJson(sourceCode, filename, settings = {}) {
  const fileKey = path.basename(filename);
  return {
    language: "Solidity",
    sources: {
      [fileKey]: { content: sourceCode }
    },
    settings: {
      optimizer: { enabled: false, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"]
        }
      },
      ...settings
    }
  };
}

// POST /compile
// body: { source: string, filename?: string, compilerVersion?: string, returnArtifacts?: boolean }
app.post("/compile", async (req, res) => {
  try {
    const { source, filename, compilerVersion, returnArtifacts } = req.body || {};
    if (typeof source !== "string" || !source.trim()) {
      return res.status(400).json({ success: false, error: "Missing 'source' string." });
    }

    // Create a temp .sol file (to satisfy the “write .sol first” requirement)
    const safeName =
      (filename && filename.replace(/[^a-zA-Z0-9_.-]/g, "")) || `Contract_${uuidv4().slice(0, 8)}.sol`;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "solc-"));
    const filePath = path.join(tmpDir, safeName);
    await fs.writeFile(filePath, source, "utf8");

    // Prepare standard JSON input
    const input = buildStandardJson(source, safeName);

    // Choose compiler: either bundled solc or remote version
    let compiler = solc;
    if (compilerVersion && /^v?\d+\.\d+\.\d+/.test(compilerVersion)) {
      // Load solc-js for a specific version (e.g., "0.8.20")
      const ver = compilerVersion.startsWith("v") ? compilerVersion : `v${compilerVersion}`;
      const load = await new Promise((resolve, reject) => {
        solc.loadRemoteVersion(ver, (err, solcSpecific) => {
          if (err) reject(err);
          else resolve(solcSpecific);
        });
      });
      compiler = load;
    }

    // Compile with import resolver
    const outputJSON = compiler.compile(JSON.stringify(input), {
      import: (pathOrUrl) => {
        // solc expects a sync callback; use deasync-like approach via Atomics not available here.
        // Workaround: reject non-HTTP imports synchronously; accept http(s) imports only via blocking fetch.
        // BUT Node fetch is async. MVP: disallow async imports here.
        // To keep it fully synchronous (and robust), we reject non-inline imports for now.
        return { error: "Imports are disabled in this endpoint. Use http(s) raw contents inline or single-file." };
      }
    });

    const output = JSON.parse(outputJSON);

    // Collect errors/warnings
    const diagnostics = (output.errors || []).map((e) => ({
      type: e.type,
      severity: e.severity,
      message: e.formattedMessage,
      sourceLocation: e.sourceLocation || null
    }));

    const hasError = diagnostics.some((d) => d.severity === "error");

    // Minimal response
    const base = {
      success: !hasError,
      compiler: {
        version: compiler.version()
      },
      filename: safeName,
      diagnostics
    };

    if (!hasError && returnArtifacts) {
      const artifacts = [];
      for (const [file, contracts] of Object.entries(output.contracts || {})) {
        for (const [name, artifact] of Object.entries(contracts)) {
          artifacts.push({
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
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`sol-compile-api listening on :${PORT}`);
});
