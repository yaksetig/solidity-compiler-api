# solidity-compiler-api

# Solidity Compile API (Railway)

## Endpoints
- `POST /compile`
  - JSON body:
    ```json
    {
      "source": "pragma solidity ^0.8.20; contract C { function x() external pure returns(uint){ return 1; } }",
      "filename": "C.sol",
      "compilerVersion": "0.8.26",
      "returnArtifacts": true
    }
    ```
  - Response:
    ```json
    {
      "success": true,
      "compiler": { "version": "0.8.26+commit..." },
      "filename": "C.sol",
      "diagnostics": [],
      "artifacts": [
        { "contract": "C", "abi": [...], "bytecode": "0x6080..." }
      ]
    }
    ```

- `GET /healthz` → `{ "ok": true }`

## Running locally
npm ci
npm start
server on :8080

## cURL example
curl -sS -X POST http://localhost:8080/compile
-H "Content-Type: application/json"
-d '{"source":"pragma solidity ^0.8.20; contract C { function x() external pure returns(uint){ return 1; } }","filename":"C.sol","returnArtifacts":true}'

## Deploy to Railway (from GitHub)
1. Push this repo to GitHub.
2. In Railway → "New Project" → "Deploy from GitHub" → select repo.
3. Railway detects Dockerfile automatically. No extra config needed.
4. Set `PORT=8080` in Railway variables (optional; Dockerfile already sets it).
5. Deploy.

## Notes / Hardening
- Rate limit + small body size to keep compute low.
- Imports are disabled in MVP. If needed, restrict to `https://raw.githubusercontent.com/...` and pin to commit SHAs.
- Consider a `compilerVersion` allow-list (e.g., `0.7.6`, `0.8.20`, `0.8.26`) to prevent odd edge versions.
- Railway ephemeral FS is fine; nothing persists between deploys.
