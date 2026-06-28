import { expect, test, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SANITIZER_SENTINEL_STRINGS,
  chainlinkConsensusFixturesById,
  type ChainlinkConsensusFixtureId
} from "./fixtures/chainlink-consensus-fixtures";

type ApiServer = {
  baseUrl: string;
  logs: string[];
  process: ChildProcess;
  tempDir: string;
};

type PageDiagnostics = {
  apiErrors: string[];
  browserErrors: string[];
};

type WalletRecord = {
  record_id: string;
};

const repoRoot = path.resolve(process.cwd(), "../..");
const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 5174);
const uiOrigin = `http://127.0.0.1:${playwrightPort}`;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
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

async function startWalletApi(): Promise<ApiServer> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "abby-chainlink-consensus-fullstack-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pythonPath = [path.join(repoRoot, "ipfs_datasets_py"), repoRoot, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(":");
  const logs: string[] = [];
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
      WALLET_ALLOW_SIMULATED_PROOFS: "false",
      WALLET_API_CORS_ORIGINS: uiOrigin,
      WALLET_AUTO_LOAD_REPOSITORY: "true",
      WALLET_AUTO_PERSIST: "true",
      WALLET_PROOF_MODE: "production",
      WALLET_REPOSITORY_ROOT: path.join(tempDir, "wallet-repository"),
      WALLET_STORAGE_CONFIG: JSON.stringify({
        primary: { type: "local", root: path.join(tempDir, "wallet-blobs") }
      })
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

async function openWalletRoute(
  page: Page,
  route: string,
  apiBaseUrl: string,
  walletId: string,
  actorDid: string,
  params: Record<string, string> = {}
) {
  await page.goto(walletRoute(route, apiBaseUrl, walletId, actorDid, params));
  await signInIfNeeded(page, actorDid);
}

async function navigateHash(page: Page, route: string) {
  await page.evaluate((nextRoute) => {
    window.location.hash = `#/${nextRoute}`;
  }, route);
}

function fixtureConsensus(id: ChainlinkConsensusFixtureId): Record<string, unknown> {
  const fixture = chainlinkConsensusFixturesById[id];
  const response = fixture.response as Record<string, unknown> | undefined;
  const output = response?.output as Record<string, unknown> | undefined;
  const apiError = fixture.apiError as Record<string, unknown> | undefined;
  const detail = apiError?.detail as Record<string, unknown> | undefined;
  const consensus = response?.consensus ?? output?.consensus ?? detail?.consensus;
  if (!consensus || typeof consensus !== "object" || Array.isArray(consensus)) {
    throw new Error(`Fixture ${id} does not expose consensus metadata`);
  }
  return consensus as Record<string, unknown>;
}

function proofRecord({
  claim,
  consensus,
  id,
  proofSystem,
  status = "verified",
  type
}: {
  claim: string;
  consensus?: Record<string, unknown>;
  id: string;
  proofSystem: string;
  status?: string;
  type: string;
}) {
  return {
    proof_id: id,
    proof_type: type,
    statement: { claim },
    verifier_id: `${proofSystem}-verifier`,
    public_inputs: {
      claim,
      claim_hash: `sha256:${id}-public-claim`,
      receipt_hash: consensus?.receipt_hash ?? `sha256:${id}-receipt`
    },
    proof_hash: `sha256:${id}-proof-hash`,
    witness_record_ids: ["rec-consensus-benefits"],
    is_simulated: false,
    proof_system: proofSystem,
    circuit_id: `${type}-circuit-v1`,
    verifier_digest: `sha256:${id}-verifier-digest`,
    proof_artifact_ref: consensus?.proof_cid ?? consensus?.receipt_cid ?? `proof://${id}`,
    verification_status: status,
    created_at: "2026-06-14T12:00:00Z",
    ...(consensus ? { consensus } : {})
  };
}

function assertNoSentinelInText(text: string, label: string) {
  for (const sentinel of SANITIZER_SENTINEL_STRINGS) {
    expect(text, `${label} must not contain ${sentinel}`).not.toContain(sentinel);
  }
}

async function expectNoVisibleSentinelLeakage(page: Page) {
  assertNoSentinelInText(await page.locator("body").innerText(), "visible UI");
}

function expectNoSentinelInPayload(payload: unknown) {
  assertNoSentinelInText(JSON.stringify(payload), "exported payload");
}

async function installConsensusWalletRoutes({
  apiBaseUrl,
  documentId,
  page,
  walletId
}: {
  apiBaseUrl: string;
  documentId: string;
  page: Page;
  walletId: string;
}) {
  const receiptOnlyConsensus = fixtureConsensus("receipt-only");
  const libp2pConsensus = fixtureConsensus("libp2p");
  const creConsensus = fixtureConsensus("cre");
  const zkmlConsensus = fixtureConsensus("zkml");
  const teeConsensus = fixtureConsensus("tee");
  const quorumFailureConsensus = fixtureConsensus("quorum-failure");
  const proofFailureConsensus = fixtureConsensus("proof-failure");
  const sanitizerConsensus = fixtureConsensus("sanitizer-sentinel");
  const creMismatchConsensus = {
    ...creConsensus,
    fail_closed_error: "cre_workflow_mismatch",
    failure_reason: "CRE workflow report did not match the request/output commitments.",
    verification_label: "Manual review required"
  };
  const proofs = [
    proofRecord({
      claim: "Document privacy profile",
      consensus: zkmlConsensus,
      id: "proof-zkml-consensus",
      proofSystem: "zkml-checker",
      type: "document_privacy_profile"
    }),
    proofRecord({
      claim: "TEE eligibility claim",
      consensus: teeConsensus,
      id: "proof-tee-consensus",
      proofSystem: "tee-attested",
      type: "eligibility_attestation"
    }),
    proofRecord({
      claim: "Public analytics release",
      consensus: creConsensus,
      id: "proof-cre-consensus",
      proofSystem: "chainlink-cre",
      type: "analytics_release"
    }),
    proofRecord({
      claim: "No quorum provider claim",
      consensus: quorumFailureConsensus,
      id: "proof-quorum-failure-consensus",
      proofSystem: "consensus-receipt",
      status: "verification_failed",
      type: "provider_eligibility"
    }),
    proofRecord({
      claim: "Receipt-only upload profile",
      consensus: receiptOnlyConsensus,
      id: "proof-receipt-only-consensus",
      proofSystem: "consensus-receipt",
      type: "consensus_receipt"
    }),
    proofRecord({
      claim: "Proof CRE mismatch claim",
      consensus: creMismatchConsensus,
      id: "proof-cre-mismatch-consensus",
      proofSystem: "chainlink-cre",
      status: "verification_failed",
      type: "analytics_release"
    }),
    proofRecord({
      claim: "Manual review proof failure",
      consensus: proofFailureConsensus,
      id: "proof-failure-consensus",
      proofSystem: "zkml-checker",
      status: "verification_failed",
      type: "document_privacy_profile"
    }),
    proofRecord({
      claim: "Sanitized consensus claim",
      consensus: sanitizerConsensus,
      id: "proof-sanitized-consensus",
      proofSystem: "tee-attested-cre",
      type: "consensus_receipt"
    })
  ];

  await page.route(`${apiBaseUrl}/wallets/${walletId}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const pathName = url.pathname;
    const method = route.request().method();

    if (method === "GET" && pathName.endsWith("/access-requests")) {
      await route.fulfill({
        json: {
          requests: [
            {
              request_id: "access-libp2p-consensus",
              requester_did: "did:key:provider",
              audience_did: "did:key:owner",
              resources: [`wallet://${walletId}/records/${documentId}`],
              abilities: ["record/analyze"],
              purpose: "recipient access derived artifact",
              status: "pending",
              created_at: "2026-06-14T12:00:00Z",
              consensus: libp2pConsensus
            },
            {
              request_id: "access-quorum-failure",
              requester_did: "did:key:manual-review-provider",
              audience_did: "did:key:owner",
              resources: [`wallet://${walletId}/records/${documentId}`],
              abilities: ["record/analyze"],
              purpose: "manual fallback after no quorum",
              status: "pending",
              created_at: "2026-06-14T12:01:00Z",
              consensus: quorumFailureConsensus
            }
          ]
        }
      });
      return;
    }

    if (method === "GET" && pathName.endsWith("/grant-receipts")) {
      await route.fulfill({ json: { receipts: [] } });
      return;
    }

    if (method === "GET" && pathName.endsWith("/records") && url.searchParams.get("data_type") === "document") {
      await route.fulfill({
        json: {
          records: [
            {
              record_id: documentId,
              data_type: "document",
              sensitivity: "high",
              public_descriptor: "Consensus benefits note",
              status: "active",
              created_at: "2026-06-14T12:00:00Z",
              metadata: { consensus: receiptOnlyConsensus }
            },
            {
              record_id: "rec-upload-quorum-failure",
              data_type: "document",
              sensitivity: "high",
              public_descriptor: "Manual-review upload profile",
              status: "active",
              created_at: "2026-06-14T12:02:00Z",
              metadata: { consensus: quorumFailureConsensus }
            }
          ]
        }
      });
      return;
    }

    if (method === "GET" && pathName.includes("/records/") && pathName.endsWith("/storage")) {
      await route.fulfill({ json: { ok: true } });
      return;
    }

    if (method === "GET" && pathName.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs } });
      return;
    }

    if (method === "GET" && pathName.endsWith("/audit")) {
      await route.fulfill({
        json: {
          events: [
            {
              event_id: "audit-libp2p-consensus",
              created_at: "2026-06-14T12:03:00Z",
              actor_did: "did:key:provider",
              action: "record/analyze_redacted",
              resource: `wallet://${walletId}/records/${documentId}`,
              decision: "allow",
              grant_id: null,
              consensus: libp2pConsensus
            },
            {
              event_id: "audit-cre-consensus",
              created_at: "2026-06-14T12:04:00Z",
              actor_did: "did:key:owner",
              action: "analytics/release",
              resource: `wallet://${walletId}/analytics/pilot_housing_gap_v1`,
              decision: "allow",
              grant_id: null,
              consensus: creConsensus
            },
            {
              event_id: "audit-tee-consensus",
              created_at: "2026-06-14T12:05:00Z",
              actor_did: "did:key:owner",
              action: "hmis/validate",
              resource: `wallet://${walletId}/hmis/referral-tee-eligibility`,
              decision: "allow",
              grant_id: null,
              consensus: teeConsensus
            },
            {
              event_id: "audit-quorum-failure-consensus",
              created_at: "2026-06-14T12:06:00Z",
              actor_did: "did:key:owner",
              action: "consensus/quorum",
              resource: `wallet://${walletId}/records/${documentId}`,
              decision: "manual_review",
              grant_id: null,
              consensus: quorumFailureConsensus
            },
            {
              event_id: "audit-proof-failure-consensus",
              created_at: "2026-06-14T12:07:00Z",
              actor_did: "did:key:owner",
              action: "proof/verify",
              resource: `wallet://${walletId}/proofs/proof-failure-consensus`,
              decision: "deny",
              grant_id: null,
              consensus: proofFailureConsensus
            },
            {
              event_id: "audit-cre-mismatch-consensus",
              created_at: "2026-06-14T12:08:00Z",
              actor_did: "did:key:owner",
              action: "cre/report_mismatch",
              resource: `wallet://${walletId}/analytics/pilot_housing_gap_v1`,
              decision: "manual_review",
              grant_id: null,
              consensus: creMismatchConsensus
            }
          ]
        }
      });
      return;
    }

    if (method === "POST" && pathName.endsWith("/locations/rec-location-current/region-proofs")) {
      const error = chainlinkConsensusFixturesById["proof-failure"].apiError;
      await route.fulfill({
        status: error?.status ?? 422,
        json: error ?? { detail: { code: "proof_verification_failed", consensus: proofFailureConsensus } }
      });
      return;
    }

    await route.fallback();
  });
}

test("full-stack Chainlink consensus surfaces fail closed and leak no private consensus data", async ({ page }) => {
  test.setTimeout(240_000);

  const api = await startWalletApi();
  const ownerDid = "did:key:chainlink-consensus-fullstack-owner";
  const ownerKeyHex = "c3".repeat(32);
  const delegateDid = "did:key:chainlink-consensus-fullstack-clinic";
  const delegateKeyHex = "d4".repeat(32);
  const diagnostics = collectPageDiagnostics(page, api.baseUrl);

  try {
    const wallet = await apiJson<{ wallet_id: string }>(api.baseUrl, "POST", "/wallets", { owner_did: ownerDid });
    const document = await apiJson<WalletRecord>(api.baseUrl, "POST", `/wallets/${wallet.wallet_id}/documents/text`, {
      actor_did: ownerDid,
      filename: "consensus-benefits-note.txt",
      key_hex: ownerKeyHex,
      text: [
        "Consensus full-stack benefits note.",
        "Email: maya.private@example.org",
        ...SANITIZER_SENTINEL_STRINGS
      ].join("\n"),
      title: "Consensus benefits note"
    });

    await installConsensusWalletRoutes({
      apiBaseUrl: api.baseUrl,
      documentId: document.record_id,
      page,
      walletId: wallet.wallet_id
    });

    const walletParams = { audienceKeyHex: delegateKeyHex, issuerKeyHex: ownerKeyHex };
    await openWalletRoute(page, "home", api.baseUrl, wallet.wallet_id, ownerDid, walletParams);
    await expect(page.getByRole("heading", { name: /Welcome to your safety plan!/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Recipient access artifacts/i })).toBeVisible();
    await expect(page.getByText("libp2p quorum receipt").first()).toBeVisible();
    await expect(page.getByText("Raw operator outputs hidden").first()).toBeVisible();
    await expect(page.getByText("Manual review required").first()).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    await navigateHash(page, "uploads");
    await expect(page.getByRole("heading", { name: /Wallet proof receipts/i })).toBeVisible();
    await expect(page.getByText("Consensus receipt").first()).toBeVisible();
    await expect(page.getByText("Raw prompt and operator outputs hidden").first()).toBeVisible();
    await expect(page.getByText("Manual-review upload profile").first()).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    await navigateHash(page, "proof-center");
    await expect(page.getByRole("heading", { name: /Verified wallet claims/i })).toBeVisible();
    await expect(page.getByText("ZKML checker verified").first()).toBeVisible();
    await expect(page.getByText("TEE attested").first()).toBeVisible();
    await expect(page.getByText("Chainlink CRE verified").first()).toBeVisible();
    await expect(page.getByText("Manual review required").first()).toBeVisible();
    await expect(page.getByText(/CRE workflow report did not match/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^Create proof$/i }).click();
    await expect(page.getByText(/Proof creation failed/i)).toBeVisible();
    await expect(page.getByText(/proof verification failed/i).first()).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    await navigateHash(page, "exports");
    await expect(page.getByRole("heading", { name: /QR proof review/i })).toBeVisible();
    await expect(page.getByText("QR review shows ZKML proof metadata only").first()).toBeVisible();
    await expect(page.getByText("QR review shows fail-closed receipt metadata only").first()).toBeVisible();
    await page.getByLabel(/Recipient DID/i).fill(delegateDid);
    await page.getByLabel(/Recipient label/i).fill("Full-stack CRE clinic");
    await page.getByLabel(/Purpose/i).fill("chainlink_cre_portability");
    await page.getByLabel(/Record IDs/i).fill(document.record_id);
    const exportResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/wallets/${wallet.wallet_id}/exports` && response.request().method() === "POST";
    });
    await page.getByRole("button", { name: /Create bundle/i }).click();
    const exportBundle = await (await exportResponse).json();
    expectNoSentinelInPayload(exportBundle);
    await expect(page.getByText(/Export bundle verified/i)).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    await navigateHash(page, "social-services");
    await expect(page.getByRole("heading", { name: /Provider proof review/i })).toBeVisible();
    await expect(page.getByText("Provider may review TEE attestation metadata").first()).toBeVisible();
    await expect(page.getByText("Provider must use manual review").first()).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    await navigateHash(page, "analytics");
    await expect(page.getByRole("heading", { name: /Public proof dashboard/i })).toBeVisible();
    await expect(page.getByText("CRE claims").first()).toBeVisible();
    await expect(page.getByText("ZKML claims").first()).toBeVisible();
    await expect(page.getByText("Manual review").first()).toBeVisible();
    await expect(page.getByText("CRE verification, not ZK proof").first()).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    await navigateHash(page, "security");
    await expect(page.getByRole("heading", { name: /Proof security review/i })).toBeVisible();
    await expect(page.getByText("TEE quote bytes hidden").first()).toBeVisible();
    await expect(page.getByText("Verifier state fails closed").first()).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    await navigateHash(page, "audit");
    await expect(page.getByRole("heading", { name: /Proof audit coverage/i })).toBeVisible();
    await expect(page.getByText(/analytics\/release/i)).toBeVisible();
    await expect(page.getByText(/cre\/report_mismatch/i)).toBeVisible();
    await expect(page.getByText(/proof verification failed/i).first()).toBeVisible();
    await page.reload();
    await signInIfNeeded(page, ownerDid);
    await expect(page.getByRole("heading", { name: /Proof audit coverage/i })).toBeVisible();
    await expect(page.getByText(/consensus\/quorum/i)).toBeVisible();
    await expectNoVisibleSentinelLeakage(page);

    const unexpectedErrors = diagnostics.apiErrors.filter((error) => !error.includes("proof_verification_failed"));
    await expect.poll(() => diagnostics.browserErrors).toEqual([]);
    await expect.poll(() => unexpectedErrors).toEqual([]);
  } finally {
    await stopWalletApi(api);
  }
});
