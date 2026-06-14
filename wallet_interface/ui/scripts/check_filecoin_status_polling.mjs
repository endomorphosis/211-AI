import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiRoot = path.resolve(__dirname, "..");
const outDir = await mkdtemp(path.join(tmpdir(), "abby-filecoin-polling-"));
const outfile = path.join(outDir, "check-filecoin-status-polling.mjs");

const entry = String.raw`
import assert from "node:assert/strict";

import { pollFilecoinStorageStatus, toFilecoinStoragePatch } from "./src/services/filecoinStorage.ts";

globalThis.window = {
  location: { href: "http://127.0.0.1/" },
  setTimeout
};

const statusRequestCounts = new Map();

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url, "http://127.0.0.1/");
  const requestId = url.pathname.split("/").pop();
  statusRequestCounts.set(requestId, (statusRequestCounts.get(requestId) || 0) + 1);

  if (requestId === "pin-failed") {
    return new Response(JSON.stringify({ requestid: requestId, status: "failed" }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  }

  if (requestId === "pin-pinned") {
    return new Response(
      JSON.stringify({
        info: { synapse_piece_cid: "baga-piece" },
        requestid: requestId,
        status: "pinned"
      }),
      {
        headers: { "content-type": "application/json" },
        status: 200
      }
    );
  }

  throw new Error("Unexpected status request: " + url.toString());
};

const failedResult = await pollFilecoinStorageStatus(
  {
    filecoinPinRequestId: "pin-failed",
    filecoinPinStatus: "queued",
    ipfsCid: "bafyfailed",
    requestId: "pin-failed",
    statusUrl: "/filecoin-upload/status/pin-failed"
  },
  {
    clientConfig: { uploadUrl: "/filecoin-upload" },
    maxAttempts: 3,
    pollIntervalMs: 0
  }
);

assert.equal(statusRequestCounts.get("pin-failed"), 1, "failed status should stop polling after the first update");
assert.equal(failedResult?.filecoinPinStatus, "failed", "failed status should override the initial queued state");
assert.equal(
  toFilecoinStoragePatch(failedResult).decentralizedStorageMessage,
  "Stored on IPFS, but Filecoin persistence failed.",
  "failed status should produce the IPFS-only failure message"
);

const pinnedResult = await pollFilecoinStorageStatus(
  {
    filecoinPinRequestId: "pin-pinned",
    filecoinPinStatus: "queued",
    ipfsCid: "bafypinned",
    requestId: "pin-pinned",
    statusUrl: "/filecoin-upload/status/pin-pinned"
  },
  {
    clientConfig: { uploadUrl: "/filecoin-upload" },
    maxAttempts: 3,
    pollIntervalMs: 0
  }
);

assert.equal(statusRequestCounts.get("pin-pinned"), 1, "pinned status should stop polling after the first update");
assert.equal(pinnedResult?.filecoinPinStatus, "pinned", "pinned status should override the initial queued state");
assert.equal(
  toFilecoinStoragePatch(pinnedResult).filecoinPieceCid,
  "baga-piece",
  "pinned status should preserve piece CID details returned during status polling"
);

console.log("Filecoin polling regression checks passed.");
`;

try {
  await build({
    bundle: true,
    format: "esm",
    outfile,
    platform: "node",
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    stdin: {
      contents: entry,
      resolveDir: uiRoot,
      sourcefile: "check-filecoin-status-polling.ts"
    },
    target: "node20"
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(outDir, { force: true, recursive: true });
}