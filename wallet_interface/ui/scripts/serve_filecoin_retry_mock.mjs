import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, "..", "dist");
const port = Number(process.env.PORT || 4174);

let proofUploadAttempt = 0;
let recordUploadAttempt = 0;
let statusRequests = 0;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8"
  });
  response.end(html);
}

async function serveStatic(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const requestedPath = path.join(distDir, safePath.replace(/^\/+/, ""));
  const normalizedPath = path.normalize(requestedPath);
  if (!normalizedPath.startsWith(distDir)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }

  const resolvedPath = existsSync(normalizedPath) ? normalizedPath : path.join(distDir, "index.html");
  try {
    const body = await readFile(resolvedPath);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes.get(path.extname(resolvedPath).toLowerCase()) || "application/octet-stream"
    });
    response.end(body);
  } catch (error) {
    console.error("static-serve-failed", pathname, error);
    response.writeHead(404);
    response.end("not found");
  }
}

function manualBootstrapHtml(origin) {
  const walletDid = "did:key:owner";
  const nextUrl = `${origin}/?walletApiBaseUrl=${encodeURIComponent(origin)}&walletId=wallet-demo&actorDid=${encodeURIComponent(walletDid)}#/uploads`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Abby Filecoin Retry Harness</title>
  </head>
  <body>
    <main>
      <h1>Preparing Abby Filecoin retry harness</h1>
      <p>This page clears cached Abby state, seeds the wallet session, and redirects to the uploads screen.</p>
    </main>
    <script>
      (async () => {
        localStorage.clear();
        localStorage.setItem("abby-ui-session-v1", JSON.stringify({ username: "${walletDid}" }));
        localStorage.setItem("abby-filecoin-storage-config", JSON.stringify({ uploadUrl: "/filecoin-upload" }));
        if ("serviceWorker" in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        }
        if ("caches" in globalThis) {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        }
        window.location.replace(${JSON.stringify(nextUrl)});
      })();
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  const { pathname, searchParams } = url;
  console.log(request.method, pathname + (url.search || ""));

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers": "content-type,authorization",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-origin": "*"
    });
    response.end();
    return;
  }

  if (pathname === "/manual-filecoin-retry") {
    sendHtml(response, manualBootstrapHtml(url.origin));
    return;
  }

  if (pathname === "/wallets/wallet-demo/access-requests") {
    sendJson(response, 200, { requests: [] });
    return;
  }
  if (pathname === "/wallets/wallet-demo/audit") {
    sendJson(response, 200, { events: [] });
    return;
  }
  if (pathname === "/wallets/wallet-demo/dead-drops/missing-person" && request.method === "PUT") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === "/wallets/wallet-demo/grant-receipts") {
    sendJson(response, 200, { receipts: [] });
    return;
  }
  if (pathname === "/wallets/wallet-demo/portal/interactions") {
    sendJson(response, 200, { interactions: [] });
    return;
  }
  if (pathname === "/wallets/wallet-demo/portal/plans") {
    sendJson(response, 200, { plans: [] });
    return;
  }
  if (pathname === "/wallets/wallet-demo/portal/saved-services") {
    sendJson(response, 200, { services: [] });
    return;
  }
  if (pathname === "/wallets/wallet-demo/proofs") {
    sendJson(response, 200, { proofs: [] });
    return;
  }
  if (pathname === "/wallets/wallet-demo/records" && searchParams.get("data_type") === "document") {
    sendJson(response, 200, {
      records: [
        {
          created_at: "2026-05-03T18:00:00Z",
          data_type: "document",
          public_descriptor: "Benefits letter",
          record_id: "rec-benefits-letter",
          sensitivity: "high",
          status: "active"
        }
      ]
    });
    return;
  }
  if (pathname === "/wallets/wallet-demo/records/rec-benefits-letter/storage") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === "/filecoin-upload" && request.method === "POST") {
    const contentType = String(request.headers["content-type"] || "");
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += chunk.toString();
    });
    request.on("end", () => {
      if (contentType.includes("application/json")) {
        recordUploadAttempt += 1;
        console.log("record-upload-attempt", recordUploadAttempt, rawBody.slice(0, 200));
        sendJson(response, 200, {
          filecoinPinRequestId: `record-pin-${recordUploadAttempt}`,
          filecoinPinStatus: "queued",
          ipfsCid: "bafywallet",
          provider: "ipfs-filecoin",
          requestId: `record-pin-${recordUploadAttempt}`,
          statusUrl: `/filecoin-upload/status/record-pin-${recordUploadAttempt}`
        });
        return;
      }

      proofUploadAttempt += 1;
      console.log("proof-upload-attempt", proofUploadAttempt, rawBody.slice(0, 200));
      sendJson(response, 200, {
        ipfsCid: "bafywalletproofbundlecid",
        message: "Stored wallet proof bundle.",
        provider: "ipfs-filecoin"
      });
    });
    return;
  }

  if (pathname.startsWith("/filecoin-upload/status/")) {
    statusRequests += 1;
    const requestId = pathname.split("/").pop();
    const status = requestId === "record-pin-1" ? "failed" : "pinned";
    console.log("status-request", statusRequests, requestId, status);
    sendJson(response, 200, {
      info: status === "pinned" ? { synapse_piece_cid: "baga-wallet-piece" } : undefined,
      requestid: requestId,
      status
    });
    return;
  }

  await serveStatic(response, pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`manual retry server listening on http://127.0.0.1:${port}`);
  console.log(`open http://127.0.0.1:${port}/manual-filecoin-retry to seed the wallet session and open uploads`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});