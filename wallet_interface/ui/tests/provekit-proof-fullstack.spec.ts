import { expect, test, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildProveKitWalletProofsApiResponse,
  containsForbiddenWitnessToken,
  createProveKitLocationRegionApiReceipt,
  provekitForbiddenWitnessTokens,
  provekitProofFixtureScenarios
} from "./fixtures/provekit-proof-fixtures";

type JsonRecord = Record<string, unknown>;

type ApiServer = {
  baseUrl: string;
  logs: string[];
  process: ChildProcess;
  tempDir: string;
};

type ProveKitVerifierRequest = {
  method: string;
  path: string;
  payload: JsonRecord;
};

type ProveKitVerifierServer = {
  baseUrl: string;
  requests: ProveKitVerifierRequest[];
  server: Server;
};

type WalletRecord = {
  record_id: string;
};

type WalletProof = {
  is_simulated: boolean;
  proof_id: string;
  proof_system?: string;
  public_inputs: JsonRecord;
};

type PageDiagnostics = {
  apiErrors: string[];
  browserErrors: string[];
};

const repoRoot = path.resolve(process.cwd(), "../..");
const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 5174);
const uiOrigin = `http://127.0.0.1:${playwrightPort}`;
const privateCoordinateTokens = ["45.515232", "-122.678385"];

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not allocate a local port"));
      });
    });
  });
}

async function apiJson<T>(baseUrl: string, method: string, route: string, payload?: unknown): Promise<T> {
  const response = await fetch(new URL(route, baseUrl), {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    method
  });
  const body = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`${method} ${route} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const body = Buffer.concat(chunks).toString("utf-8");
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function safeStatement(statement: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(statement).filter(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      if (["lat", "latitude", "lon", "lng", "longitude", "private_axiom_text"].includes(normalizedKey)) {
        return false;
      }
      return !containsForbiddenWitnessToken(value);
    })
  );
}

async function handleVerifierRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ProveKitVerifierRequest[]
) {
  const payload = await readJsonBody(request);
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  requests.push({ method, path: requestUrl.pathname, payload });

  if (method === "POST" && requestUrl.pathname === "/health") {
    sendJson(response, 200, { ok: true, status: "ok", proof_system: "ProveKit-WHIR" });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/prove/location-region") {
    const publicInputs = isRecord(payload.public_inputs) ? payload.public_inputs : {};
    const statement = isRecord(payload.statement) ? safeStatement(payload.statement) : {};
    const witnessRecordIds = stringArray(payload.witness_record_ids);
    const receipt = createProveKitLocationRegionApiReceipt({
      proofId: "proof-fullstack-provekit-whir",
      publicInputs,
      statement,
      walletId: stringValue(payload.wallet_id) || "wallet-provekit-fullstack",
      witnessRecordId: witnessRecordIds[0] || "rec-location-current"
    });
    sendJson(response, 200, { receipt });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/verify") {
    const receipt = isRecord(payload.receipt) ? payload.receipt : {};
    sendJson(response, 200, {
      verified: receipt.proof_system === "ProveKit-WHIR" && receipt.is_simulated === false
    });
    return;
  }

  sendJson(response, 404, { error: "unexpected verifier request", path: requestUrl.pathname });
}

async function startProveKitVerifier(): Promise<ProveKitVerifierServer> {
  const requests: ProveKitVerifierRequest[] = [];
  const server = createHttpServer((request, response) => {
    void handleVerifierRequest(request, response, requests).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve ProveKit verifier server address");
  }
  return { baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`, requests, server };
}

async function stopProveKitVerifier(verifier: ProveKitVerifierServer) {
  await new Promise<void>((resolve) => verifier.server.close(() => resolve()));
}

async function startWalletApi(provekitVerifierBaseUrl: string): Promise<ApiServer> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "abby-provekit-fullstack-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pythonPath = [path.join(repoRoot, "ipfs_datasets_py"), repoRoot, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(":");
  const logs: string[] = [];
  const apiProcess = spawn(
    process.env.PYTHON ?? "python3",
    [
      "-m",
      "uvicorn",
      "wallet_interface.asgi:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "warning"
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        IPFS_AUTO_INSTALL: "false",
        IPFS_DATASETS_AUTO_INSTALL: "false",
        IPFS_DATASETS_PY_MINIMAL_IMPORTS: "1",
        PYTHONPATH: pythonPath,
        WALLET_ALLOW_SIMULATED_PROOFS: "false",
        WALLET_API_CORS_ORIGINS: uiOrigin,
        WALLET_AUTO_LOAD_REPOSITORY: "true",
        WALLET_AUTO_PERSIST: "true",
        WALLET_PROOF_BACKEND: "http-location-region",
        WALLET_PROOF_BEARER_TOKEN: "",
        WALLET_PROOF_CIRCUIT_ID: "provekit_knowledge_of_axioms@v1",
        WALLET_PROOF_HTTP_HEADER_NAME: "",
        WALLET_PROOF_HTTP_HEADER_VALUE: "",
        WALLET_PROOF_MODE: "production",
        WALLET_PROOF_PROVE_PATH: "/prove/location-region",
        WALLET_PROOF_SERVICE_URL: provekitVerifierBaseUrl,
        WALLET_PROOF_SYSTEM: "ProveKit-WHIR",
        WALLET_PROOF_VERIFIER_ID: "provekit-whir-eligibility-v1",
        WALLET_PROOF_VERIFY_PATH: "/verify",
        WALLET_REPOSITORY_ROOT: path.join(tempDir, "wallet-repository"),
        WALLET_STORAGE_CONFIG: JSON.stringify({
          primary: { type: "local", root: path.join(tempDir, "wallet-blobs") }
        })
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  apiProcess.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  apiProcess.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const deadline = Date.now() + 15_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) {
      throw new Error(`wallet API exited early with ${apiProcess.exitCode}:\n${logs.join("")}`);
    }
    try {
      const health = await apiJson<{ status: string }>(baseUrl, "GET", "/health");
      if (health.status === "ok") return { baseUrl, logs, process: apiProcess, tempDir };
    } catch (error) {
      lastError = String(error);
    }
    await delay(100);
  }
  await stopWalletApi({ baseUrl, logs, process: apiProcess, tempDir });
  throw new Error(`wallet API did not become healthy: ${lastError}\n${logs.join("")}`);
}

async function stopWalletApi(server: ApiServer) {
  let exited = server.process.exitCode !== null;
  server.process.once("exit", () => {
    exited = true;
  });
  if (!exited) {
    server.process.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.process.once("exit", resolve)), delay(5_000)]).then(
      () => undefined
    );
    if (!exited && server.process.exitCode === null) {
      server.process.kill("SIGKILL");
      await Promise.race([new Promise((resolve) => server.process.once("exit", resolve)), delay(5_000)]).then(
        () => undefined
      );
    }
  }
  await rm(server.tempDir, { force: true, recursive: true });
}

function walletRoute(
  route: string,
  apiBaseUrl: string,
  walletId: string,
  actorDid: string,
  params: Record<string, string> = {}
) {
  const query = new URLSearchParams({
    actorDid,
    walletApiBaseUrl: apiBaseUrl,
    walletId,
    ...params
  });
  return `/?${query.toString()}#/${route}`;
}

function collectPageDiagnostics(page: Page, apiBaseUrl: string): PageDiagnostics {
  const diagnostics: PageDiagnostics = { apiErrors: [], browserErrors: [] };
  page.on("pageerror", (error) => {
    diagnostics.browserErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.browserErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (!response.url().startsWith(apiBaseUrl) || response.status() < 400) return;
    void response.text().then((body) => {
      diagnostics.apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}: ${body.slice(0, 500)}`);
    });
  });
  return diagnostics;
}

async function signInIfNeeded(page: Page, username = "abby") {
  const usernameField = page.getByLabel(/username/i).first();
  try {
    await usernameField.waitFor({ state: "visible", timeout: 1_000 });
  } catch {
    return;
  }
  await usernameField.fill(username);
  await page.getByLabel(/password/i).fill("safety-plan");
  await page.getByRole("button", { name: /log in|login|sign in|continue/i }).click();
}

async function expectHeading(page: Page, name: RegExp, diagnostics: PageDiagnostics) {
  await expect(page.getByRole("heading", { name }))
    .toBeVisible({ timeout: 15_000 })
    .catch(async (error) => {
      const body = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nURL: ${page.url()}\nBrowser errors: ${diagnostics.browserErrors.join(" | ")}\nBody: ${body.slice(0, 2_000)}`
      );
    });
}

async function navigateHash(page: Page, route: string, heading: RegExp, diagnostics: PageDiagnostics) {
  await page.evaluate((nextRoute) => {
    window.location.hash = `#/${nextRoute}`;
  }, route);
  await expectHeading(page, heading, diagnostics);
}

async function expectNoProofLeakage(page: Page) {
  const body = await page.locator("body").innerText();
  for (const token of provekitForbiddenWitnessTokens) {
    expect(body, `visible UI must not contain ${token}`).not.toContain(token);
  }
  for (const token of privateCoordinateTokens) {
    expect(body, `visible UI must not contain precise coordinate ${token}`).not.toContain(token);
  }
}

function expectPublicPayloadHasNoProofLeakage(payload: unknown) {
  const serialized = JSON.stringify(payload);
  expect(containsForbiddenWitnessToken(payload)).toBe(false);
  for (const token of privateCoordinateTokens) {
    expect(serialized).not.toContain(token);
  }
}

function proofRouteResponseForError(key: "disabled" | "unavailable") {
  const apiError = provekitProofFixtureScenarios[key].apiError;
  if (!apiError) throw new Error(`missing ProveKit ${key} API error fixture`);
  return {
    status: apiError.status,
    json: {
      code: apiError.code,
      detail: apiError.detail
    }
  };
}

function unexpectedApiErrors(diagnostics: PageDiagnostics): string[] {
  return diagnostics.apiErrors.filter(
    (error) =>
      !error.includes("provekit_backend_disabled") &&
      !error.includes("provekit_backend_unavailable")
  );
}

async function installFailClosedProofRoutes(page: Page) {
  await page.route("**/wallets/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const pathName = url.pathname;
    const method = route.request().method();

    if (method === "GET" && pathName.endsWith("/proofs") && !pathName.endsWith("/region-proofs")) {
      await route.fulfill({
        json: buildProveKitWalletProofsApiResponse([
          "groth16",
          "provekitWhir",
          "recursive",
          "artifactHashMismatch",
          "staleVerifierKey",
          "unavailable",
          "verificationFailure",
          "witnessSentinel"
        ])
      });
      return;
    }

    if (method === "POST" && pathName.endsWith("/region-proofs")) {
      const requestBody = route.request().postDataJSON() as JsonRecord;
      const regionId = stringValue(requestBody.region_id);
      if (regionId === "disabled_state") {
        await route.fulfill(proofRouteResponseForError("disabled"));
        return;
      }
      if (regionId === "unavailable_state") {
        await route.fulfill(proofRouteResponseForError("unavailable"));
        return;
      }
    }

    await route.fallback();
  });
}

test("live Abby UI and wallet API exercise ProveKit proof workflows without witness leakage", async ({ page }) => {
  test.setTimeout(180_000);

  const verifier = await startProveKitVerifier();
  let api: ApiServer | undefined;
  const ownerDid = "did:key:provekit-fullstack-owner";
  const ownerKeyHex = "a1".repeat(32);
  const delegateDid = "did:key:provekit-fullstack-clinic";
  const delegateKeyHex = "b2".repeat(32);
  const walletParams = {
    audienceKeyHex: delegateKeyHex,
    issuerKeyHex: ownerKeyHex
  };

  try {
    api = await startWalletApi(verifier.baseUrl);
    const apiServer = api;
    const diagnostics = collectPageDiagnostics(page, apiServer.baseUrl);
    const wallet = await apiJson<{ wallet_id: string }>(apiServer.baseUrl, "POST", "/wallets", { owner_did: ownerDid });
    const document = await apiJson<WalletRecord>(apiServer.baseUrl, "POST", `/wallets/${wallet.wallet_id}/documents/text`, {
      actor_did: ownerDid,
      filename: "provekit-benefits-note.txt",
      key_hex: ownerKeyHex,
      text: "ProveKit full-stack export note. Private axiom text must stay outside exported proof metadata.",
      title: "ProveKit benefits note"
    });
    const location = await apiJson<WalletRecord>(apiServer.baseUrl, "POST", `/wallets/${wallet.wallet_id}/locations`, {
      actor_did: ownerDid,
      lat: 45.515232,
      lon: -122.678385
    });

    await page.goto(walletRoute("proof-center", apiServer.baseUrl, wallet.wallet_id, ownerDid, walletParams));
    await signInIfNeeded(page, ownerDid);
    await expectHeading(page, /Verified wallet claims/i, diagnostics);
    await page.getByLabel(/Location record ID/i).fill(location.record_id);
    await page.getByLabel(/Region ID/i).fill("multnomah_county");

    const proofResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith(`/locations/${location.record_id}/region-proofs`) && response.request().method() === "POST";
    });
    await page.getByRole("button", { name: /^Create proof$/i }).click();
    const proofReceipt = (await (await proofResponsePromise).json()) as WalletProof;

    expect(proofReceipt.proof_system).toBe("ProveKit-WHIR");
    expect(proofReceipt.is_simulated).toBe(false);
    expectPublicPayloadHasNoProofLeakage(proofReceipt);
    await expect(page.getByText(/Proof receipt created/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("ProveKit WHIR").first()).toBeVisible();
    await expect(page.getByText("Not on-chain ready without recursive wrapper").first()).toBeVisible();
    await expectNoProofLeakage(page);

    await expect
      .poll(async () => {
        const response = await apiJson<{ proofs: WalletProof[] }>(
          apiServer.baseUrl,
          "GET",
          `/wallets/${wallet.wallet_id}/proofs`
        );
        return response.proofs.map((proof) => proof.proof_system);
      })
      .toContain("ProveKit-WHIR");

    const proveRequest = verifier.requests.find((request) => request.path === "/prove/location-region");
    expect(proveRequest, "the wallet API should call the ProveKit verifier stub").toBeTruthy();
    expect(JSON.stringify(proveRequest?.payload.witness)).toContain("45.515232");

    await page.reload();
    await signInIfNeeded(page, ownerDid);
    await expectHeading(page, /Verified wallet claims/i, diagnostics);
    await expect(page.getByText("ProveKit WHIR").first()).toBeVisible({ timeout: 15_000 });
    await expectNoProofLeakage(page);

    await page.goto(walletRoute("exports", apiServer.baseUrl, wallet.wallet_id, ownerDid, walletParams));
    await signInIfNeeded(page, ownerDid);
    await expectHeading(page, /Shareable wallet bundles/i, diagnostics);
    await expect(page.getByRole("heading", { name: /QR proof review/i })).toBeVisible();
    await expect(page.getByText("QR review shows proof system, verifier, and public inputs only").first()).toBeVisible();
    await page.getByLabel(/Recipient DID/i).fill(delegateDid);
    await page.getByLabel(/Recipient label/i).fill("Full-stack ProveKit clinic");
    await page.getByLabel(/Purpose/i).fill("provekit_portability");
    await page.getByLabel(/Record IDs/i).fill(`${document.record_id}\n${location.record_id}`);

    const exportResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/wallets/${wallet.wallet_id}/exports` && response.request().method() === "POST";
    });
    await page.getByRole("button", { name: /Create bundle/i }).click();
    const exportBundle = (await (await exportResponsePromise).json()) as JsonRecord;
    expectPublicPayloadHasNoProofLeakage(exportBundle);
    expect(JSON.stringify(exportBundle)).toContain("ProveKit-WHIR");
    await expect(page.getByText(/Export bundle verified/i)).toBeVisible({ timeout: 15_000 });
    const createdBundle = page.getByRole("article", { name: /Full-stack ProveKit clinic/i });
    await expect(createdBundle.getByText("ProveKit WHIR")).toBeVisible();
    await expect(createdBundle.getByText(/No on-chain claim in this export/i)).toBeVisible();
    await createdBundle.getByRole("button", { name: /Import descriptors/i }).click();
    await expect(page.getByText(/Export descriptors imported/i)).toBeVisible();
    await expect(createdBundle.getByText(/import verified/i)).toBeVisible();
    await expectNoProofLeakage(page);

    await navigateHash(page, "audit", /Consent and access history/i, diagnostics);
    await expect(page.getByRole("heading", { name: /Proof audit coverage/i })).toBeVisible();
    await expect(page.getByText(/proof\/create/i)).toBeVisible();
    await expect(page.getByText(/verified.*ProveKit WHIR/i).first()).toBeVisible();
    await expectNoProofLeakage(page);

    await installFailClosedProofRoutes(page);
    const failClosedWalletParams = { ...walletParams, provekitStateFixture: "fail-closed" };
    await page.goto(walletRoute("proof-center", apiServer.baseUrl, wallet.wallet_id, ownerDid, failClosedWalletParams));
    await signInIfNeeded(page, ownerDid);
    await expectHeading(page, /Verified wallet claims/i, diagnostics);
    await expect(page.getByText("ProveKit WHIR").first()).toBeVisible();
    await expect(page.getByText("ProveKit artifact hash mismatch").first()).toBeVisible();
    await expect(page.getByText("Stale ProveKit verifier key").first()).toBeVisible();
    await expect(page.getByText("ProveKit backend unavailable").first()).toBeVisible();
    await expect(page.getByText("ProveKit verification failed").first()).toBeVisible();
    await expectNoProofLeakage(page);

    await page.getByLabel(/Location record ID/i).fill(location.record_id);
    await page.getByLabel(/Region ID/i).fill("disabled_state");
    await page.getByRole("button", { name: /^Create proof$/i }).click();
    await expect(page.getByText(/ProveKit backend disabled/i)).toBeVisible();
    await expect(page.getByText(/No simulated fallback was created/i)).toBeVisible();
    await page.getByLabel(/Region ID/i).fill("unavailable_state");
    await page.getByRole("button", { name: /^Create proof$/i }).click();
    await expect(page.getByText(/ProveKit backend unavailable/i).first()).toBeVisible();
    await expect(page.getByText(/no proof receipt was minted/i)).toBeVisible();
    await expectNoProofLeakage(page);

    await navigateHash(page, "uploads", /Saved files and info/i, diagnostics);
    await expect(page.getByRole("heading", { name: /Wallet proof receipts/i })).toBeVisible();
    await expect(page.getByText("Private witness and private axioms hidden").first()).toBeVisible();
    await expectNoProofLeakage(page);

    await navigateHash(page, "social-services", /Find support/i, diagnostics);
    await expect(page.getByRole("heading", { name: /Provider proof review/i })).toBeVisible();
    await expect(page.getByText("Provider may review public proof metadata").first()).toBeVisible();
    await expectNoProofLeakage(page);

    await navigateHash(page, "analytics", /Share group facts, not your name/i, diagnostics);
    await expect(page.getByRole("heading", { name: /Public proof dashboard/i })).toBeVisible();
    await expect(page.getByText("Production proof evidence").first()).toBeVisible();
    await expect(page.getByText("Fail-closed receipts").first()).toBeVisible();
    await expectNoProofLeakage(page);

    await navigateHash(page, "exports", /Shareable wallet bundles/i, diagnostics);
    await expect(page.getByRole("heading", { name: /QR proof review/i })).toBeVisible();
    await expect(page.getByText("QR review shows proof system, verifier, and public inputs only").first()).toBeVisible();
    await expectNoProofLeakage(page);

    await navigateHash(page, "security", /Account safety/i, diagnostics);
    await expect(page.getByRole("heading", { name: /Proof security review/i })).toBeVisible();
    await expect(page.getByText("Verifier state fails closed").first()).toBeVisible();
    await expectNoProofLeakage(page);

    await navigateHash(page, "audit", /Consent and access history/i, diagnostics);
    await expect(page.getByRole("heading", { name: /Proof audit coverage/i })).toBeVisible();
    await expect(page.getByText(/ProveKit artifact hash mismatch/i).first()).toBeVisible();
    await expectNoProofLeakage(page);

    await expect.poll(() => unexpectedApiErrors(diagnostics)).toEqual([]);
  } finally {
    if (api) {
      await stopWalletApi(api);
    }
    await stopProveKitVerifier(verifier);
  }
});
