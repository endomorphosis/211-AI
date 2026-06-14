import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildWalletProofBundlePayload, reviewWalletProofBundlePayload } from "../src/services/walletProofReview";
import {
  WORLD_ID_ACTION,
  WORLD_ID_ACTOR_DID,
  WORLD_ID_APP_ID,
  WORLD_ID_PRIVATE_SENTINELS,
  WORLD_ID_RP_ID,
  buildWorldIdConfig,
  buildWorldIdIdkitPayload,
  collectForbiddenWorldIdTokens,
  worldIdApiProofReceipt,
  worldIdForbiddenPrivateTokens,
  worldIdSanitizedExportReview,
  worldIdSanitizedQrProofBundle
} from "./fixtures/world-id-fixtures";

type JsonRecord = Record<string, unknown>;

type ApiServer = {
  baseUrl: string;
  logs: string[];
  process: ChildProcess;
  tempDir: string;
};

type DeveloperPortalRequest = {
  method: string;
  path: string;
  payload: JsonRecord;
};

type DeveloperPortalServer = {
  baseUrl: string;
  requests: DeveloperPortalRequest[];
  server: Server;
};

type PageDiagnostics = {
  apiErrors: string[];
  browserErrors: string[];
};

const repoRoot = path.resolve(process.cwd(), "../..");
const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 5174);
const uiOrigin = `http://127.0.0.1:${playwrightPort}`;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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

function idkitNullifier(payload: JsonRecord): string {
  const responses = Array.isArray(payload.responses) ? payload.responses : [];
  const firstResponse = responses.find(isRecord);
  return firstString(
    firstResponse?.nullifier,
    firstResponse?.nullifier_hash,
    payload.nullifier,
    payload.nullifier_hash,
    WORLD_ID_PRIVATE_SENTINELS.rawNullifier
  );
}

async function startDeveloperPortal(): Promise<DeveloperPortalServer> {
  const requests: DeveloperPortalRequest[] = [];
  const server = createHttpServer((request, response) => {
    void (async () => {
      const payload = await readJsonBody(request);
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      requests.push({ method, path: requestUrl.pathname, payload });

      if (method === "POST" && requestUrl.pathname === `/api/v4/verify/${WORLD_ID_RP_ID}`) {
        const nullifier = idkitNullifier(payload);
        sendJson(response, 200, {
          success: true,
          results: [
            {
              success: true,
              identifier: "proof_of_human",
              nullifier
            }
          ],
          action: firstString(payload.action) || WORLD_ID_ACTION,
          nullifier,
          created_at: "2026-06-14T16:00:00Z",
          environment: "staging",
          message: "verified"
        });
        return;
      }

      sendJson(response, 404, { error: "unexpected Developer Portal request", path: requestUrl.pathname });
    })().catch((error) => {
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
    throw new Error("Could not resolve Developer Portal server address");
  }
  return { baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`, requests, server };
}

async function stopDeveloperPortal(portal: DeveloperPortalServer) {
  await new Promise<void>((resolve) => portal.server.close(() => resolve()));
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

async function apiResponse(baseUrl: string, method: string, route: string, payload?: unknown): Promise<Response> {
  return fetch(new URL(route, baseUrl), {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    method
  });
}

async function startWalletApi(options: { developerPortalBaseUrl?: string; worldIdEnabled?: boolean } = {}): Promise<ApiServer> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "abby-world-id-fullstack-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pythonPath = [path.join(repoRoot, "ipfs_datasets_py"), repoRoot, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(":");
  const logs: string[] = [];
  const worldIdEnabled = options.worldIdEnabled ?? true;
  const apiProcess = spawn(process.env.PYTHON ?? "python3", [
    "-m",
    "uvicorn",
    "wallet_interface.asgi:app",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "warning"
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      IPFS_AUTO_INSTALL: "false",
      IPFS_DATASETS_AUTO_INSTALL: "false",
      IPFS_DATASETS_PY_MINIMAL_IMPORTS: "1",
      PYTHONPATH: pythonPath,
      WALLET_API_CORS_ORIGINS: uiOrigin,
      WALLET_AUTO_LOAD_REPOSITORY: "true",
      WALLET_AUTO_PERSIST: "true",
      WALLET_REPOSITORY_ROOT: path.join(tempDir, "wallet-repository"),
      WALLET_STORAGE_CONFIG: JSON.stringify({
        primary: { type: "local", root: path.join(tempDir, "wallet-blobs") }
      }),
      WORLD_ID_ALLOW_LEGACY_PROOFS: "false",
      WORLD_ID_ALLOWED_ACTIONS: `${WORLD_ID_ACTION},provider-staff-world-id-v1`,
      WORLD_ID_APP_ID,
      WORLD_ID_DEFAULT_ACTION: WORLD_ID_ACTION,
      WORLD_ID_ENABLED: worldIdEnabled ? "1" : "0",
      WORLD_ID_ENVIRONMENT: "staging",
      WORLD_ID_HTTP_TIMEOUT_SECONDS: "5",
      WORLD_ID_NULLIFIER_HMAC_KEY: "world-id-fullstack-nullifier-hmac-secret",
      WORLD_ID_REQUIRE_USER_PRESENCE: "true",
      WORLD_ID_RP_ID,
      WORLD_ID_RP_SIGNATURE_TTL_SECONDS: "300",
      WORLD_ID_RP_SIGNING_KEY: `0x${"11".repeat(32)}`,
      WORLD_ID_VERIFY_BASE_URL: options.developerPortalBaseUrl ?? "http://127.0.0.1:9"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
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
      if (health.status === "ok") {
        return { baseUrl, logs, process: apiProcess, tempDir };
      }
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

function walletRoute(route: string, apiBaseUrl: string, walletId: string, actorDid: string) {
  const query = new URLSearchParams({
    actorDid,
    walletApiBaseUrl: apiBaseUrl,
    walletId
  });
  return `/?${query.toString()}#/${route}`;
}

function collectPageDiagnostics(page: Page, apiBaseUrl: string): PageDiagnostics {
  const diagnostics: PageDiagnostics = { apiErrors: [], browserErrors: [] };
  page.on("pageerror", (error) => {
    diagnostics.browserErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^Failed to load resource: the server responded with a status of \d+/.test(text)) return;
    diagnostics.browserErrors.push(text);
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

async function openWalletRoute(page: Page, route: string, apiBaseUrl: string, walletId: string, actorDid: string) {
  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { __abbyEnableWorldIdPanelTest?: boolean }).__abbyEnableWorldIdPanelTest = true;
  });
  await page.goto(walletRoute(route, apiBaseUrl, walletId, actorDid));
  await signInIfNeeded(page, actorDid);
}

async function waitForIdkitTestHook(page: Page, timeout = 10_000) {
  await page.waitForFunction(
    () => typeof (globalThis as typeof globalThis & { __abbyWorldIdPanelTest?: unknown }).__abbyWorldIdPanelTest !== "undefined",
    { timeout }
  );
}

async function simulateIdkitSuccess(page: Page, nullifier = WORLD_ID_PRIVATE_SENTINELS.rawNullifier) {
  const payload = {
    ...buildWorldIdIdkitPayload(),
    protocol_version: "4.0",
    nonce: "world-id-fullstack-nonce",
    action: WORLD_ID_ACTION,
    environment: "staging",
    user_presence_completed: true,
    responses: [
      {
        identifier: "proof_of_human",
        signal_hash: "0x0",
        proof: ["0x1a", "0x2b", "0x3c", "0x4d", "0x5e"],
        nullifier,
        issuer_schema_id: 1,
        expires_at_min: 1_756_166_400
      }
    ]
  };
  await page.evaluate((idkitPayload) => {
    const hook = (globalThis as typeof globalThis & {
      __abbyWorldIdPanelTest?: {
        simulateSuccess: (result: Record<string, unknown>) => Promise<void>;
      };
    }).__abbyWorldIdPanelTest;
    if (!hook) throw new Error("World ID panel test hook is unavailable");
    return hook.simulateSuccess(idkitPayload).catch(() => undefined);
  }, payload);
  return payload;
}

async function visiblePanel(page: Page) {
  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

function expectNoForbiddenTokens(rendered: string) {
  expect(collectForbiddenWorldIdTokens(rendered)).toEqual([]);
}

test("World ID disabled and missing-config guards stay safe with a live wallet API", async ({ page }) => {
  const api = await startWalletApi({ worldIdEnabled: false });
  try {
    const diagnostics = collectPageDiagnostics(page, api.baseUrl);
    const wallet = await apiJson<{ wallet_id: string }>(api.baseUrl, "POST", "/wallets", {
      owner_did: WORLD_ID_ACTOR_DID
    });

    await openWalletRoute(page, "proof-center", api.baseUrl, wallet.wallet_id, WORLD_ID_ACTOR_DID);
    const disabledPanel = await visiblePanel(page);
    await expect(disabledPanel.getByText(/Unavailable/i)).toBeVisible();
    await expect(disabledPanel.getByRole("button", { name: /Verify with World ID/i })).toBeDisabled();
    await expect(disabledPanel.getByText(/World ID is disabled for this wallet/i)).toBeVisible();

    await page.route(`${api.baseUrl}/wallets/${wallet.wallet_id}/world-id/config`, async (route) => {
      await route.fulfill({ json: buildWorldIdConfig({ enabled: true, app_id: "" }) });
    });
    await page.reload();
    await signInIfNeeded(page, WORLD_ID_ACTOR_DID);
    const missingConfigPanel = await visiblePanel(page);
    await expect(missingConfigPanel.getByRole("button", { name: /Verify with World ID/i })).toBeDisabled();
    await expect(missingConfigPanel.getByText(/World ID app configuration is missing/i)).toBeVisible();
    await expect.poll(() => diagnostics.browserErrors).toEqual([]);
  } finally {
    await stopWalletApi(api);
  }
});

test("World ID verification completes through the real UI and live wallet API", async ({ page }) => {
  const portal = await startDeveloperPortal();
  const api = await startWalletApi({ developerPortalBaseUrl: portal.baseUrl });
  try {
    const diagnostics = collectPageDiagnostics(page, api.baseUrl);
    const wallet = await apiJson<{ wallet_id: string }>(api.baseUrl, "POST", "/wallets", {
      owner_did: WORLD_ID_ACTOR_DID
    });

    await openWalletRoute(page, "proof-center", api.baseUrl, wallet.wallet_id, WORLD_ID_ACTOR_DID);
    const panel = await visiblePanel(page);
    await expect(panel.getByText(/Not verified/i)).toBeVisible({ timeout: 15_000 });

    await panel.getByRole("button", { name: /Verify with World ID/i }).click();
    await waitForIdkitTestHook(page);
    await simulateIdkitSuccess(page);

    await expect(panel.getByText(/World ID proof-of-human is now bound to this wallet/i)).toBeVisible({
      timeout: 15_000
    });
    await expect(panel.getByText(/World ID verified/i)).toBeVisible();
    await expect(
      page.getByRole("article", { name: /world_id_proof_of_human|World ID proof/i })
    ).toBeVisible({ timeout: 15_000 });

    expect(portal.requests).toHaveLength(1);
    expect(JSON.stringify(portal.requests[0].payload)).toContain(WORLD_ID_PRIVATE_SENTINELS.rawNullifier);

    const status = await apiJson<{
      wallet: { active_binding_count: number; bindings: Array<{ binding_id: string; nullifier_ref: string }> };
    }>(api.baseUrl, "GET", `/wallets/${wallet.wallet_id}/world-id/status?actor_did=${encodeURIComponent(WORLD_ID_ACTOR_DID)}`);
    expect(status.wallet.active_binding_count).toBe(1);
    expect(status.wallet.bindings[0].nullifier_ref).toMatch(/^worldid-nullifier-ref:v1:/);

    const sameWalletReplay = await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/world-id/verifications`,
      {
        actor_did: WORLD_ID_ACTOR_DID,
        idkit_payload: await simulateSafeApiPayload(WORLD_ID_PRIVATE_SENTINELS.rawNullifier)
      }
    );
    expect(JSON.stringify(sameWalletReplay)).toContain(status.wallet.bindings[0].binding_id);

    const secondWallet = await apiJson<{ wallet_id: string }>(api.baseUrl, "POST", "/wallets", {
      owner_did: "did:key:world-id-conflict-owner"
    });
    const conflict = await apiResponse(api.baseUrl, "POST", `/wallets/${secondWallet.wallet_id}/world-id/verifications`, {
      actor_did: "did:key:world-id-conflict-owner",
      idkit_payload: await simulateSafeApiPayload(WORLD_ID_PRIVATE_SENTINELS.rawNullifier)
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain("already bound");

    const proofs = await apiJson<{ proofs: unknown[] }>(api.baseUrl, "GET", `/wallets/${wallet.wallet_id}/proofs`);
    const audit = await apiJson<{ events: Array<{ action: string }> }>(api.baseUrl, "GET", `/wallets/${wallet.wallet_id}/audit`);
    const renderedState = JSON.stringify({ status, proofs, audit, body: await page.locator("body").innerText() });
    expect(renderedState).toContain("world_id_proof_of_human");
    expect(renderedState).toContain("hmac-sha256:");
    expectNoForbiddenTokens(renderedState);
    expect(audit.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["wallet/world_id_bind", "proof/world_id_bind"])
    );

    await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/world-id/bindings/${status.wallet.bindings[0].binding_id}/revoke`,
      {
        actor_did: WORLD_ID_ACTOR_DID,
        reason: "user disconnected"
      }
    );
    await panel.getByRole("button", { name: /Refresh status/i }).click();
    await expect(panel.getByText(/Not verified/i)).toBeVisible({ timeout: 15_000 });

    await expect.poll(() => diagnostics.browserErrors).toEqual([]);
    expect(diagnostics.apiErrors.filter((error) => !error.includes(secondWallet.wallet_id))).toEqual([]);
  } finally {
    await stopWalletApi(api);
    await stopDeveloperPortal(portal);
  }
});

test("World ID QR and export review fixtures render only sanitized public metadata", () => {
  const proofPayload = buildWalletProofBundlePayload({
    actorDid: WORLD_ID_ACTOR_DID,
    walletId: "wallet-world-id-qr-fullstack",
    proofs: [
      {
        id: "proof-world-id-qr-fullstack",
        proofType: worldIdApiProofReceipt.proof_type,
        claim: String(worldIdApiProofReceipt.public_inputs.claim),
        verifier: worldIdApiProofReceipt.verifier_id,
        proofSystem: worldIdApiProofReceipt.proof_system,
        verificationStatus: worldIdApiProofReceipt.verification_status,
        circuitId: worldIdApiProofReceipt.circuit_id,
        verifierDigest: worldIdApiProofReceipt.verifier_digest,
        proofArtifactRef: worldIdApiProofReceipt.proof_artifact_ref,
        publicInputs: {
          ...worldIdApiProofReceipt.public_inputs,
          raw_nullifier: WORLD_ID_PRIVATE_SENTINELS.rawNullifier,
          idkit_proof: WORLD_ID_PRIVATE_SENTINELS.idkitProof,
          developer_portal_response: WORLD_ID_PRIVATE_SENTINELS.developerPortalResponse,
          rp_signature: WORLD_ID_PRIVATE_SENTINELS.rpSignature,
          email: WORLD_ID_PRIVATE_SENTINELS.email,
          phone: WORLD_ID_PRIVATE_SENTINELS.phone
        },
        witnessLabel: "World ID wallet binding",
        simulated: false,
        createdAt: worldIdApiProofReceipt.created_at
      }
    ]
  });
  const review = reviewWalletProofBundlePayload(worldIdSanitizedQrProofBundle);
  const rendered = JSON.stringify({
    proofPayload: JSON.parse(proofPayload),
    review,
    exportReview: worldIdSanitizedExportReview
  });
  expect(rendered).toContain("world_id_proof_of_human");
  expect(rendered).toContain("hmac-sha256:");
  expectNoForbiddenTokens(rendered);
  for (const token of worldIdForbiddenPrivateTokens) {
    expect(rendered).not.toContain(token);
  }
});

async function simulateSafeApiPayload(nullifier: string): Promise<Record<string, unknown>> {
  return {
    ...buildWorldIdIdkitPayload(),
    protocol_version: "4.0",
    nonce: `world-id-api-${Date.now()}`,
    action: WORLD_ID_ACTION,
    environment: "staging",
    user_presence_completed: true,
    responses: [
      {
        identifier: "proof_of_human",
        signal_hash: "0x0",
        proof: ["0x1a", "0x2b", "0x3c", "0x4d", "0x5e"],
        nullifier,
        issuer_schema_id: 1,
        expires_at_min: 1_756_166_400
      }
    ]
  };
}
