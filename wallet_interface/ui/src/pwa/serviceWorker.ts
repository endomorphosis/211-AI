import { shouldDeleteAppCache } from "./cachePolicy";
import { shouldHandleServiceWorkerRequest } from "./fetchPolicy";

const CACHE_VERSION = "portal-095-v1";
const SHELL_CACHE = `abby-shell-${CACHE_VERSION}`;
const PUBLIC_SERVICE_CACHE = `abby-public-service-detail-${CACHE_VERSION}`;
const SHELL_CACHE_PREFIX = "abby-shell-";

const PUBLIC_SERVICE_DETAIL_ASSETS = new Set([
  "corpus/211-info/current/artifacts.manifest.json",
  "corpus/211-info/current/generated/generated-manifest.json"
]);

const PRIVATE_QUERY_KEYS = new Set([
  "actorDid",
  "audienceKeyHex",
  "issuerKeyHex",
  "walletApiBaseUrl",
  "walletId"
]);

type ServiceWorkerLifecycleEvent = Event & {
  waitUntil(promise: Promise<unknown>): void;
};

type ServiceWorkerFetchEvent = Event & {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

type ServiceWorkerGlobal = typeof globalThis & {
  registration: {
    scope: string;
  };
  clients: {
    claim(): Promise<void>;
  };
  addEventListener(type: "activate", listener: (event: ServiceWorkerLifecycleEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: ServiceWorkerFetchEvent) => void): void;
  addEventListener(type: "install", listener: (event: ServiceWorkerLifecycleEvent) => void): void;
  skipWaiting(): Promise<void>;
};

const sw = self as unknown as ServiceWorkerGlobal;

sw.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([precacheShell(), sw.skipWaiting()]));
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([deleteOldCaches(), sw.clients.claim()]));
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!shouldHandleServiceWorkerRequest(request.url, sw.registration.scope)) return;

  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (shouldBypassCache(request)) {
    event.respondWith(fetchWithoutBrowserCache(request));
    return;
  }

  if (isPublicServiceDetailAsset(request)) {
    event.respondWith(cacheFirst(request, PUBLIC_SERVICE_CACHE));
    return;
  }

  if (isPublicShellAsset(request)) {
    event.respondWith(cacheFirstShellAsset(request));
  }
});

async function precacheShell(): Promise<void> {
  const cache = await caches.open(SHELL_CACHE);
  const shellUrl = scopedUrl("index.html");
  const rootUrl = scopedUrl("");
  const manifestUrl = scopedUrl("manifest.webmanifest");
  const iconUrl = scopedUrl("assets/abby-icon.png");

  try {
    const shellResponse = await fetch(new Request(shellUrl, { cache: "reload" }));
    if (isCacheableResponse(shellResponse)) {
      await cache.put(new Request(shellUrl), shellResponse.clone());
      await cache.put(new Request(rootUrl), shellResponse.clone());
      const html = await shellResponse.text();
      const assetUrls = extractShellAssetUrls(html);
      await Promise.allSettled(
        [manifestUrl, iconUrl, ...assetUrls].map((url) => cache.add(new Request(url, { cache: "reload" })))
      );
      return;
    }
  } catch {
    // Runtime navigation fallback will use any previously cached shell.
  }

  await Promise.allSettled([rootUrl, shellUrl, manifestUrl, iconUrl].map((url) => cache.add(url)));
}

async function deleteOldCaches(): Promise<void> {
  const currentCaches = new Set([SHELL_CACHE, PUBLIC_SERVICE_CACHE]);
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => shouldDeleteAppCache(key, currentCaches))
      .map((key) => caches.delete(key))
  );
}

async function handleNavigation(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const shellRequest = new Request(scopedUrl("index.html"));
  const rootRequest = new Request(scopedUrl(""));
  const hasPrivateUrl = hasPrivateWalletUrl(request.url);

  try {
    const response = await fetch(requestWithCacheMode(request, hasPrivateUrl ? "no-store" : "reload"));
    if (!hasPrivateUrl && isCacheableResponse(response)) {
      await cache.put(shellRequest, response.clone());
      await cache.put(rootRequest, response.clone());
    }
    return response;
  } catch {
    return (
      (await cache.match(shellRequest)) ??
      (await cache.match(rootRequest)) ??
      new Response("Abby is offline and the app shell is not cached yet.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        status: 503,
        statusText: "Offline"
      })
    );
  }
}

async function fetchWithoutBrowserCache(request: Request): Promise<Response> {
  return fetch(requestWithCacheMode(request, "no-store"));
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function cacheFirstShellAsset(request: Request): Promise<Response> {
  const cached = await matchShellAsset(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (isCacheableResponse(response)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
      return response;
    }
    return recoverMissingAppBuildAsset(request) ?? response;
  } catch (error) {
    const recovery = recoverMissingAppBuildAsset(request);
    if (recovery) return recovery;
    throw error;
  }
}

async function matchShellAsset(request: Request): Promise<Response | undefined> {
  const currentCache = await caches.open(SHELL_CACHE);
  const currentCached = await currentCache.match(request, { ignoreSearch: false });
  if (currentCached) return currentCached;

  if (shouldSkipLegacyShellAssetCache(request)) return undefined;

  const legacyCacheNames = (await caches.keys())
    .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE)
    .sort()
    .reverse();

  for (const cacheName of legacyCacheNames) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
  }

  return undefined;
}

function recoverMissingAppBuildAsset(request: Request): Response | undefined {
  const url = new URL(request.url);
  const relativePath = scopeRelativePath(url);
  if (/^assets\/clientLLMWorkerService-[A-Za-z0-9_-]+\.js$/.test(relativePath)) {
    return new Response(buildStaleClientLlmServiceRecovery(), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/javascript; charset=utf-8"
      }
    });
  }

  if (/^assets\/clientAudioWorker-[A-Za-z0-9_-]+\.js$/.test(relativePath)) {
    return new Response(buildStaleClientAudioWorkerRecovery(), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/javascript; charset=utf-8"
      }
    });
  }

  if (!/^assets\/app-[A-Za-z0-9_-]+\.(?:css|js|mjs)$/.test(relativePath)) return undefined;

  if (relativePath.endsWith(".css")) {
    return new Response("/* Abby stale app CSS compatibility stub. */\n", {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/css; charset=utf-8"
      }
    });
  }

  return new Response(buildStaleAppScriptRecovery(), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/javascript; charset=utf-8"
    }
  });
}

function buildStaleClientLlmServiceRecovery(): string {
  return `
const selfUrl = new URL(import.meta.url);
const appRoot = new URL("../", selfUrl);
const shellResponse = await fetch(new URL("index.html?abby-client-llm-recover=" + Date.now(), appRoot), {
  cache: "no-store"
});
if (!shellResponse.ok) throw new Error("Unable to load the current Abby app shell.");
const html = await shellResponse.text();
const scriptPattern = /\\bsrc=["']([^"']*assets\\/app-[^"']+\\.js)["']/gi;
let currentChunkUrl;
let scriptMatch;
while ((scriptMatch = scriptPattern.exec(html))) {
  const appScriptUrl = new URL(scriptMatch[1], appRoot);
  const appScriptResponse = await fetch(appScriptUrl.href + "?abby-client-llm-recover=" + Date.now(), {
    cache: "no-store"
  });
  if (!appScriptResponse.ok) continue;
  const appScript = await appScriptResponse.text();
  const chunkMatch = /clientLLMWorkerService-[A-Za-z0-9_-]+\\.js/.exec(appScript);
  if (chunkMatch) {
    currentChunkUrl = new URL("assets/" + chunkMatch[0], appRoot);
    break;
  }
}
if (!currentChunkUrl) throw new Error("Unable to find the current Abby LLM service chunk.");
const currentModule = await import(currentChunkUrl.href);
export const clientLLMWorkerService = currentModule.clientLLMWorkerService;
export default currentModule.default;
`;
}

function buildStaleClientAudioWorkerRecovery(): string {
  return `
const selfUrl = new URL(import.meta.url);
const appRoot = new URL("../", selfUrl);
const shellResponse = await fetch(new URL("index.html?abby-client-audio-worker-recover=" + Date.now(), appRoot), {
  cache: "no-store"
});
if (!shellResponse.ok) throw new Error("Unable to load the current Abby app shell.");
const html = await shellResponse.text();
const scriptPattern = /\\bsrc=["']([^"']*assets\\/app-[^"']+\\.js)["']/gi;
let currentWorkerUrl;
let scriptMatch;
while ((scriptMatch = scriptPattern.exec(html))) {
  const appScriptUrl = new URL(scriptMatch[1], appRoot);
  const appScriptResponse = await fetch(appScriptUrl.href + "?abby-client-audio-worker-recover=" + Date.now(), {
    cache: "no-store"
  });
  if (!appScriptResponse.ok) continue;
  const appScript = await appScriptResponse.text();
  const workerMatch = /clientAudioWorker-[A-Za-z0-9_-]+\\.js/.exec(appScript);
  if (workerMatch) {
    currentWorkerUrl = new URL("assets/" + workerMatch[0], appRoot);
    break;
  }
}
if (!currentWorkerUrl) throw new Error("Unable to find the current Abby audio worker chunk.");
await import(currentWorkerUrl.href);
`;
}

function buildStaleAppScriptRecovery(): string {
  return `
(async () => {
  const selfUrl = new URL(import.meta.url);
  const appRoot = new URL("../", selfUrl);
  const response = await fetch(new URL("index.html?abby-cache-recover=" + Date.now(), appRoot), { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load the current Abby app shell.");
  const html = await response.text();
  const assetPattern = /\\b(?:href|src)=["']([^"']+)["']/gi;
  const assetUrls = [];
  let match;
  while ((match = assetPattern.exec(html))) {
    if (match[1] && !match[1].startsWith("data:") && !match[1].startsWith("blob:")) {
      assetUrls.push(new URL(match[1], appRoot));
    }
  }
  for (const url of assetUrls.filter((candidate) => /\\/assets\\/app-[^/]+\\.css(?:$|\\?)/.test(candidate.href))) {
    if (!document.querySelector('link[href="' + url.href + '"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url.href;
      document.head.appendChild(link);
    }
  }
  const currentScript = assetUrls.find((candidate) => /\\/assets\\/app-[^/]+\\.js(?:$|\\?)/.test(candidate.href) && candidate.href !== selfUrl.href);
  if (!currentScript) throw new Error("Unable to find the current Abby app bundle.");
  await import(currentScript.href);
})().catch((error) => {
  console.error("[Abby] stale app asset recovery failed", error);
  const url = new URL(window.location.href);
  if (!url.searchParams.has("abbyCacheRecover")) {
    url.searchParams.set("abbyCacheRecover", String(Date.now()));
    window.location.replace(url.href);
  }
});
`;
}

function isNavigationRequest(request: Request): boolean {
  return request.mode === "navigate" || request.destination === "document";
}

function shouldBypassCache(request: Request): boolean {
  if (request.method !== "GET") return true;
  if (hasPrivateWalletUrl(request.url)) return true;

  const url = new URL(request.url);
  if (!isSameOrigin(url)) return request.destination === "";
  if (isPublicServiceDetailAsset(request) || isPublicShellAsset(request)) return false;

  return request.destination === "";
}

function isPublicServiceDetailAsset(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  return isSameOrigin(url) && PUBLIC_SERVICE_DETAIL_ASSETS.has(scopeRelativePath(url));
}

function isPublicShellAsset(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (!isSameOrigin(url)) return false;

  const relativePath = scopeRelativePath(url);
  if (relativePath === "" || relativePath === "index.html") return true;
  if (relativePath === "manifest.webmanifest" || relativePath === "assets/abby-icon.png") return true;

  return (
    relativePath.startsWith("assets/") &&
    /\.(?:css|gif|ico|jpe?g|js|mjs|png|svg|wasm|webp|woff2?)$/i.test(relativePath)
  );
}

function shouldSkipLegacyShellAssetCache(request: Request): boolean {
  const url = new URL(request.url);
  const relativePath = scopeRelativePath(url);
  return /^assets\/client(?:AudioWorker|LLMWorkerService)-[A-Za-z0-9_-]+\.js$/.test(relativePath);
}

function hasPrivateWalletUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  if ([...PRIVATE_QUERY_KEYS].some((key) => url.searchParams.has(key))) return true;

  const normalizedPath = url.pathname.replace(/\/{2,}/g, "/");
  return (
    /(^|\/)wallets(\/|$)/.test(normalizedPath) ||
    /(^|\/)wallet(\/|$)/.test(normalizedPath) ||
    /(^|\/)records(\/|$)/.test(normalizedPath) ||
    /(^|\/)grants(\/|$)/.test(normalizedPath) ||
    /(^|\/)proofs(\/|$)/.test(normalizedPath)
  );
}

function isSameOrigin(url: URL): boolean {
  return url.origin === new URL(sw.registration.scope).origin;
}

function scopeRelativePath(url: URL): string {
  const scopePath = new URL(sw.registration.scope).pathname;
  const normalizedScope = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith(normalizedScope)) return path.replace(/^\/+/, "");
  return path.slice(normalizedScope.length).replace(/^\/+/, "");
}

function scopedUrl(path: string): URL {
  return new URL(path, sw.registration.scope);
}

function requestWithCacheMode(request: Request, cacheMode: RequestCache): Request {
  try {
    return new Request(request, { cache: cacheMode });
  } catch {
    return request;
  }
}

function isCacheableResponse(response: Response): boolean {
  return response.ok && (response.type === "basic" || response.type === "default");
}

function extractShellAssetUrls(html: string): URL[] {
  const urls = new Map<string, URL>();
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(html))) {
    const value = match[1];
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) continue;

    const url = new URL(value, sw.registration.scope);
    const relativePath = scopeRelativePath(url);
    if (isSameOrigin(url) && (relativePath.startsWith("assets/") || relativePath === "manifest.webmanifest")) {
      urls.set(url.href, url);
    }
  }

  return [...urls.values()];
}

export {
  PUBLIC_SERVICE_DETAIL_ASSETS,
  hasPrivateWalletUrl,
  isPublicServiceDetailAsset,
  isPublicShellAsset,
  shouldBypassCache
};
