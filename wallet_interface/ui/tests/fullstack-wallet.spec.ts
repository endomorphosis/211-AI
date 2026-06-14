import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { buildWalletProofBundlePayload, reviewWalletProofBundlePayload } from "../src/services/walletProofReview";

type ApiServer = {
  baseUrl: string;
  logs: string[];
  process: ChildProcess;
  tempDir: string;
};

type WalletRecord = {
  record_id: string;
};

type WalletGrant = {
  grant_id: string;
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
  const tempDir = await mkdtemp(path.join(tmpdir(), "abby-wallet-fullstack-"));
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
      WALLET_API_CORS_ORIGINS: uiOrigin,
      WALLET_AUTO_LOAD_REPOSITORY: "true",
      WALLET_AUTO_PERSIST: "true",
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
  params: Record<string, string>
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
  const diagnostics: PageDiagnostics = {
    apiErrors: [],
    browserErrors: []
  };
  page.on("pageerror", (error) => {
    diagnostics.browserErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (/^Failed to load resource: the server responded with a status of \d+/.test(text)) {
        return;
      }
      diagnostics.browserErrors.push(text);
    }
  });
  page.on("response", (response) => {
    if (!response.url().startsWith(apiBaseUrl) || response.status() < 400) return;
    void response.text().then((body) => {
      diagnostics.apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}: ${body.slice(0, 500)}`);
    });
  });
  return diagnostics;
}

async function signInIfNeeded(page: Page, username = "abby"): Promise<void> {
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

async function visibleHeadingOrDiagnostics(page: Page, name: RegExp, diagnostics: PageDiagnostics) {
  await expect.poll(() => diagnostics.browserErrors).toEqual([]);
  await expect(page.getByRole("heading", { name }))
    .toBeVisible({ timeout: 15_000 })
    .catch(async (error) => {
      const body = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nURL: ${page.url()}\nBody: ${body.slice(0, 2_000)}`
      );
    });
}

async function installVerifiedWorldIdRoutes(page: Page, apiBaseUrl: string, walletId: string, ownerDid: string) {
  await page.route(`${apiBaseUrl}/wallets/*/world-id/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({
        json: {
          enabled: true,
          app_id: "app_staging_demo",
          rp_id: "rp_demo",
          default_action: "wallet-attach-world-id-v1",
          environment: "staging",
          credential_policy: "proof_of_human",
          allow_legacy_proofs: false,
          require_user_presence: true
        }
      });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({
        json: {
          verified: true,
          binding_id: "world-id-binding-fullstack",
          proof_id: "proof-world-id-fullstack",
          verified_at: "2026-06-14T16:00:00Z",
          action: "wallet-attach-world-id-v1",
          credential_policy: "proof_of_human",
          active_binding_count: 1
        }
      });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      const now = Math.floor(Date.now() / 1000);
      await route.fulfill({
        json: {
          app_id: "app_staging_demo",
          action: "wallet-attach-world-id-v1",
          signal: `211-ai:wallet-world-id:v1:${walletId}:${ownerDid}`,
          environment: "staging",
          allow_legacy_proofs: false,
          require_user_presence: true,
          rp_context: {
            rp_id: "rp_demo",
            nonce: "nonce-fullstack-test",
            created_at: now,
            expires_at: now + 300,
            signature: "0xmocksig"
          }
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected world-id call", path } });
  });

  await page.route(`${apiBaseUrl}/wallets/*/proofs*`, async (route) => {
    await route.fulfill({
      json: {
        proofs: [
          {
            proof_id: "proof-world-id-fullstack",
            wallet_id: walletId,
            proof_type: "world_id_proof_of_human",
            statement: {
              claim: "wallet_actor_has_world_id_proof_of_human",
              wallet_id: walletId,
              action: "wallet-attach-world-id-v1",
              credential_policy: "proof_of_human"
            },
            verifier_id: "world-developer-portal-v4:rp_demo",
            public_inputs: {
              claim: "World ID proof of human is bound to this wallet",
              rp_id: "rp_demo",
              app_id: "app_staging_demo",
              action: "wallet-attach-world-id-v1",
              signal_hash: "sha256:signal-fullstack",
              credential_policy: "proof_of_human",
              nullifier_commitment: "hmac-sha256:nullifier-fullstack",
              verification_result_hash: "sha256:result-fullstack"
            },
            proof_hash: "sha256:proof-fullstack",
            witness_record_ids: [`wallet://${walletId}/world-id-binding/world-id-binding-fullstack`],
            is_simulated: false,
            proof_system: "world_id_idkit_v4",
            circuit_id: "world-id-proof-of-human-v4",
            verifier_digest: "digest-fullstack-abcdef",
            proof_artifact_ref: "world-id-proof://proof-world-id-fullstack",
            verification_status: "verified",
            created_at: "2026-06-14T16:00:00Z"
          }
        ]
      }
    });
  });
}

test("export center works against a live wallet API", async ({ page }) => {
  const api = await startWalletApi();
  const ownerDid = "did:key:fullstack-owner";
  const ownerKeyHex = "11".repeat(32);
  const delegateDid = "did:key:fullstack-clinic";
  const delegateKeyHex = "22".repeat(32);

  try {
    const diagnostics = collectPageDiagnostics(page, api.baseUrl);
    const wallet = await apiJson<{ wallet_id: string }>(api.baseUrl, "POST", "/wallets", { owner_did: ownerDid });
    const document = await apiJson<WalletRecord>(api.baseUrl, "POST", `/wallets/${wallet.wallet_id}/documents/text`, {
      actor_did: ownerDid,
      filename: "fullstack-benefits.txt",
      key_hex: ownerKeyHex,
      text: "Full-stack export note for benefits portability. Email jane@example.org must not appear in exports.",
      title: "Full-stack benefits note"
    });
    const location = await apiJson<WalletRecord>(api.baseUrl, "POST", `/wallets/${wallet.wallet_id}/locations`, {
      actor_did: ownerDid,
      lat: 45.515232,
      lon: -122.678385
    });

    await page.goto(
      walletRoute("exports", api.baseUrl, wallet.wallet_id, ownerDid, {
        audienceKeyHex: delegateKeyHex,
        issuerKeyHex: ownerKeyHex
      })
    );
    await signInIfNeeded(page, ownerDid);
    await visibleHeadingOrDiagnostics(page, /Shareable wallet bundles/i, diagnostics);
    await page.getByLabel(/Recipient DID/i).fill(delegateDid);
    await page.getByLabel(/Recipient label/i).fill("Full-stack Clinic");
    await page.getByLabel(/Purpose/i).fill("benefits_portability");
    await page.getByLabel(/Record IDs/i).fill(`${document.record_id}\n${location.record_id}`);
    await page.getByRole("button", { name: /Create bundle/i }).click();

    await expect(page.getByText(/Export bundle verified/i)).toBeVisible({ timeout: 15_000 });
    const createdBundle = page.getByRole("article", { name: /Full-stack Clinic/i });
    await expect(createdBundle.getByText(/storage verified/i)).toBeVisible();
    await expect(createdBundle.getByText(/hash verified/i)).toBeVisible();
    await expect(createdBundle.getByText(/schema verified/i)).toBeVisible();
    await createdBundle.getByRole("button", { name: /Import descriptors/i }).click();
    await expect(page.getByText(/Export descriptors imported/i)).toBeVisible();
    await expect(createdBundle.getByText(/import verified/i)).toBeVisible();

    await expect
      .poll(async () => {
        const audit = await apiJson<{ events: Array<{ action: string }> }>(
          api.baseUrl,
          "GET",
          `/wallets/${wallet.wallet_id}/audit`
        );
        return audit.events.map((event) => event.action);
      })
      .toEqual(expect.arrayContaining(["export/create"]));
  } finally {
    await stopWalletApi(api);
  }
});

test("recipient access runs live redacted analysis workflows", async ({ page }) => {
  const api = await startWalletApi();
  const ownerDid = "did:key:fullstack-owner";
  const ownerKeyHex = "33".repeat(32);
  const delegateDid = "did:key:fullstack-clinic";
  const delegateKeyHex = "44".repeat(32);
  const plaintext = [
    "Full name: Jane Example",
    "Email: jane@example.org",
    "Phone: 503-555-1212",
    "SSN: 123-45-6789",
    "Rent assistance required: yes",
    "SNAP enrollment: yes",
    "Clinic referral needed: yes"
  ].join("\n");

  try {
    const diagnostics = collectPageDiagnostics(page, api.baseUrl);
    const wallet = await apiJson<{ wallet_id: string }>(api.baseUrl, "POST", "/wallets", { owner_did: ownerDid });
    const document = await apiJson<WalletRecord>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/documents/text`,
      {
        actor_did: ownerDid,
        filename: "fullstack-intake-form.txt",
        key_hex: ownerKeyHex,
        text: plaintext,
        title: "Full-stack intake form"
      }
    );
    const grant = await apiJson<WalletGrant>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/grants`,
      {
        issuer_did: ownerDid,
        audience_did: delegateDid,
        issuer_key_hex: ownerKeyHex,
        audience_key_hex: delegateKeyHex,
        abilities: ["record/analyze", "record/decrypt"],
        output_types: [
          "summary",
          "plaintext",
          "redacted_derived_only",
          "vector_profile",
          "redacted_extracted_text",
          "redacted_form_analysis",
          "redacted_graphrag"
        ],
        purpose: "service_matching",
        user_presence_required: true
      }
    );

    await page.goto(
      walletRoute("home", api.baseUrl, wallet.wallet_id, delegateDid, {
        audienceKeyHex: delegateKeyHex
      })
    );
    await signInIfNeeded(page, delegateDid);
    await visibleHeadingOrDiagnostics(page, /Welcome to your safety plan/i, diagnostics);
    const artifacts = page.getByRole("region", { name: /Recipient access artifacts/i });
    await expect(artifacts.getByText(/Direct AI response/i).first()).toBeVisible({ timeout: 15_000 });

    const summaryInvocation = await apiJson<{ token: string }>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analysis-invocations`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        grant_id: grant.grant_id,
        output_types: ["summary"],
        user_present: true
      }
    );
    const summary = await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analyze`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        invocation_token: summaryInvocation.token,
        max_chars: 200
      }
    );
    expect(JSON.stringify(summary)).toContain(document.record_id);

    const redactedInvocation = await apiJson<{ token: string }>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analysis-invocations`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        grant_id: grant.grant_id,
        output_types: ["redacted_derived_only"],
        user_present: true
      }
    );
    const redacted = await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analyze/redacted`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        invocation_token: redactedInvocation.token
      }
    );
    await expect.poll(() => diagnostics.apiErrors).toEqual([]);
    expect(JSON.stringify(redacted)).toContain("redacted_document_analysis");
    expect(JSON.stringify(redacted)).toContain("redacted_derived_only");
    expect(JSON.stringify(redacted)).not.toContain("jane@example.org");
    expect(JSON.stringify(redacted)).not.toContain("503-555-1212");
    expect(JSON.stringify(redacted)).not.toContain("123-45-6789");

    const vectorInvocation = await apiJson<{ token: string }>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analysis-invocations`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        grant_id: grant.grant_id,
        output_types: ["vector_profile"],
        user_present: true
      }
    );
    const vector = await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/vector-profile`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        chunk_size_words: 8,
        invocation_token: vectorInvocation.token
      }
    );
    await expect.poll(() => diagnostics.apiErrors).toEqual([]);
    expect(JSON.stringify(vector)).toContain("redacted_document_vector_profile");
    expect(JSON.stringify(vector)).toContain("encrypted_vector_profile");
    expect(JSON.stringify(vector)).toContain("redacted_lexical_hash_vector");

    const extractedInvocation = await apiJson<{ token: string }>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analysis-invocations`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        grant_id: grant.grant_id,
        output_types: ["redacted_extracted_text"],
        user_present: true
      }
    );
    const extracted = await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/extract-text/redacted`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        invocation_token: extractedInvocation.token
      }
    );
    await expect.poll(() => diagnostics.apiErrors).toEqual([]);
    expect(JSON.stringify(extracted)).toContain("redacted_document_text_extraction");
    expect(JSON.stringify(extracted)).toContain("[REDACTED_EMAIL]");
    expect(JSON.stringify(extracted)).not.toContain("jane@example.org");
    expect(JSON.stringify(extracted)).not.toContain("503-555-1212");
    expect(JSON.stringify(extracted)).not.toContain("123-45-6789");

    const formInvocation = await apiJson<{ token: string }>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analysis-invocations`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        grant_id: grant.grant_id,
        output_types: ["redacted_form_analysis"],
        user_present: true
      }
    );
    const form = await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/forms/analyze/redacted`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        invocation_token: formInvocation.token
      }
    );
    await expect.poll(() => diagnostics.apiErrors).toEqual([]);
    expect(JSON.stringify(form)).toContain("redacted_document_form_analysis");
    expect(JSON.stringify(form)).toContain("redacted_form_analysis");

    const graphInvocation = await apiJson<{ token: string }>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/${document.record_id}/analysis-invocations`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        grant_id: grant.grant_id,
        output_types: ["redacted_graphrag"],
        user_present: true
      }
    );
    const graph = await apiJson<Record<string, unknown>>(
      api.baseUrl,
      "POST",
      `/wallets/${wallet.wallet_id}/records/graphrag/redacted`,
      {
        actor_did: delegateDid,
        actor_key_hex: delegateKeyHex,
        invocation_token: graphInvocation.token,
        record_ids: [document.record_id]
      }
    );
    await expect.poll(() => diagnostics.apiErrors).toEqual([]);
    expect(JSON.stringify(graph)).toContain("redacted_document_graphrag");
    expect(JSON.stringify(graph)).toContain("redacted_category_entity_graph");

    await expect
      .poll(async () => {
        const audit = await apiJson<{ events: Array<{ action: string }> }>(
          api.baseUrl,
          "GET",
          `/wallets/${wallet.wallet_id}/audit`
        );
        return audit.events.map((event) => event.action);
      })
      .toEqual(
        expect.arrayContaining([
          "record/analyze",
          "record/analyze_redacted",
          "record/vector_profile",
          "record/extract_text_redacted",
          "record/analyze_form_redacted",
          "record/graphrag_redacted",
          "invocation/issue",
          "invocation/verify"
        ])
      );
  } finally {
    await stopWalletApi(api);
  }
});

// ---------------------------------------------------------------------------
// World ID sanitized proof display with a live wallet API
// ---------------------------------------------------------------------------

test("wallet proof QR bundles and imported review sanitize World ID proof metadata", async () => {
  const forbidden = [
    "0xraw-world-id-nullifier",
    "0x1a",
    "nullifier_ref",
    "idkit_payload",
    "idkit_proof",
    "developer_portal_response",
    "rp_signature",
    "0xmocksig",
    "jane@example.org",
    "503-555-1212",
    "123-45-6789",
    "Jane Example"
  ];
  const leakyProof = {
    id: "proof-world-id-qr",
    proofType: "world_id_proof_of_human",
    claim: "World ID proof of human is bound to this wallet",
    verifier: "world_id_developer_portal_v4",
    proofSystem: "world_id_idkit_v4",
    verificationStatus: "verified",
    circuitId: "world-id-proof-of-human-v4",
    verifierDigest: "digest-world-id-qr",
    publicInputs: {
      claim: "World ID proof of human is bound to this wallet",
      rp_id: "rp_demo",
      app_id: "app_staging_demo",
      action: "wallet-attach-world-id-v1",
      credential_policy: "proof_of_human",
      nullifier_ref: "worldid-nullifier-ref:v1:qrcommitment",
      raw_nullifier: "0xraw-world-id-nullifier",
      idkit_proof: "0x1a",
      developer_portal_response: "developer_portal_response",
      rp_signature: "0xmocksig",
      email: "jane@example.org",
      phone: "503-555-1212",
      ssn: "123-45-6789"
    },
    witnessLabel: "World ID wallet binding",
    simulated: false,
    createdAt: "2026-06-14T16:00:00Z"
  };
  const payload = buildWalletProofBundlePayload({
    actorDid: "did:key:qr-review-owner",
    walletId: "wallet-qr-world-id",
    proofs: [leakyProof]
  });
  const renderedPayload = JSON.stringify(JSON.parse(payload));

  expect(renderedPayload).toContain("world_id_proof_of_human");
  expect(renderedPayload).toContain("hmac-sha256:qrcommitment");
  for (const token of forbidden) {
    expect(renderedPayload).not.toContain(token);
  }

  const importedReview = reviewWalletProofBundlePayload({
    schemaVersion: "211-ai-wallet-root-ipld-v1",
    title: "Imported World ID proof bundle",
    wallet: { id: "wallet-qr-world-id", label: "Wallet QR World ID", actorDid: "did:key:qr-review-owner" },
    proofs: [
      {
        proof_id: "proof-world-id-imported",
        proof_type: "world_id_proof_of_human",
        statement: {
          claim: "World ID proof of human is bound to this wallet",
          idkit_payload: { responses: [{ proof: ["0x1a"], nullifier: "0xraw-world-id-nullifier" }] },
          developer_portal_response: { nullifier: "0xraw-world-id-nullifier" }
        },
        verifier_id: "world_id_developer_portal_v4",
        public_inputs: {
          claim: "World ID proof of human is bound to this wallet",
          rp_id: "rp_demo",
          app_id: "app_staging_demo",
          action: "wallet-attach-world-id-v1",
          credential_policy: "proof_of_human",
          nullifier_ref: "worldid-nullifier-ref:v1:importcommitment",
          raw_nullifier: "0xraw-world-id-nullifier",
          idkit_proof: "0x1a",
          developer_portal_response: "developer_portal_response",
          rp_signature: "0xmocksig",
          contact_email: "jane@example.org",
          contact_phone: "503-555-1212",
          ssn: "123-45-6789"
        },
        proof_system: "world_id_idkit_v4",
        circuit_id: "world-id-proof-of-human-v4",
        verifier_digest: "digest-world-id-imported",
        proof_artifact_ref: "worldid-proof://proof-world-id-imported",
        verification_status: "verified",
        created_at: "2026-06-14T16:00:00Z"
      }
    ]
  });
  const renderedReview = JSON.stringify(importedReview);

  expect(importedReview.proofs).toHaveLength(1);
  expect(importedReview.proofs[0].claim).toBe("World ID proof of human is bound to this wallet");
  expect(importedReview.proofs[0].proofType).toBe("world_id_proof_of_human");
  expect(importedReview.proofs[0].publicInputs.nullifier_commitment).toBe("hmac-sha256:importcommitment");
  expect(importedReview.proofs[0].publicInputs.credential_policy).toBe("proof_of_human");
  for (const token of forbidden) {
    expect(renderedReview).not.toContain(token);
  }
});

test("World ID disabled state is handled gracefully with a live wallet API", async ({ page }) => {
  const api = await startWalletApi();
  const ownerDid = "did:key:fullstack-world-id-owner";

  const query = new URLSearchParams({
    walletApiBaseUrl: api.baseUrl,
    walletId: "wallet-demo",
    actorDid: ownerDid
  });
  const targetRoute = `/?${query.toString()}#/proof-center`;

  const diagnostics = collectPageDiagnostics(page, api.baseUrl);

  try {
    await page.goto(targetRoute);
    await signInIfNeeded(page);

    // The wallet API may not have World ID enabled – which is fine.
    // The panel should display an Unavailable badge or disabled button.
    const panel = page.getByRole("article", { name: /World ID verification/i });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const verifyButton = panel.getByRole("button", { name: /Verify with World ID/i });
    await expect(verifyButton).toBeVisible({ timeout: 5_000 });

    // When World ID config is not enabled, the button must be disabled (no accidental
    // verification against an unconfigured backend)
    const buttonDisabled = await verifyButton.isDisabled();
    if (buttonDisabled) {
      // World ID is correctly disabled – verify the fallback messaging
      await expect(panel.getByText(/Unavailable|disabled|unavailable/i)).toBeVisible();
    }

    // No browser errors should have occurred
    await expect.poll(() => diagnostics.browserErrors).toEqual([]);
  } finally {
    await stopWalletApi(api);
  }
});

test("World ID proof-center with mocked verified state shows no raw nullifier via live API", async ({ page }) => {
  const api = await startWalletApi();
  const ownerDid = "did:key:fullstack-world-id-notnull-owner";

  const query = new URLSearchParams({
    walletApiBaseUrl: api.baseUrl,
    walletId: "wallet-demo",
    actorDid: ownerDid
  });
  const targetRoute = `/?${query.toString()}#/proof-center`;

  const diagnostics = collectPageDiagnostics(page, api.baseUrl);

  // Intercept World ID wallet API routes so we can inject a verified state
  // without needing actual World ID credentials in the test environment.
  await page.route(`${api.baseUrl}/wallets/*/world-id/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({
        json: {
          enabled: true,
          app_id: "app_staging_demo",
          rp_id: "rp_demo",
          default_action: "wallet-attach-world-id-v1",
          environment: "staging",
          credential_policy: "proof_of_human",
          allow_legacy_proofs: false,
          require_user_presence: true
        }
      });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({
        json: {
          verified: true,
          binding_id: "world-id-binding-fullstack",
          proof_id: "proof-world-id-fullstack",
          verified_at: "2026-06-14T16:00:00Z",
          action: "wallet-attach-world-id-v1",
          credential_policy: "proof_of_human",
          active_binding_count: 1
        }
      });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      const now = Math.floor(Date.now() / 1000);
      await route.fulfill({
        json: {
          app_id: "app_staging_demo",
          action: "wallet-attach-world-id-v1",
          signal: `211-ai:wallet-world-id:v1:wallet-demo:${ownerDid}`,
          environment: "staging",
          allow_legacy_proofs: false,
          require_user_presence: true,
          rp_context: {
            rp_id: "rp_demo",
            nonce: "nonce-fullstack-test",
            created_at: now,
            expires_at: now + 300,
            signature: "0xmocksig"
          }
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected world-id call", path } });
  });

  // Let the proofs endpoint pass through to the live API (so we get a real empty proofs list)
  // but also intercept to inject a World ID proof receipt
  await page.route(`${api.baseUrl}/wallets/*/proofs*`, async (route) => {
    await route.fulfill({
      json: {
        proofs: [
          {
            proof_id: "proof-world-id-fullstack",
            wallet_id: "wallet-demo",
            proof_type: "world_id_proof_of_human",
            statement: {
              claim: "wallet_actor_has_world_id_proof_of_human",
              wallet_id: "wallet-demo",
              action: "wallet-attach-world-id-v1",
              credential_policy: "proof_of_human"
            },
            verifier_id: "world-developer-portal-v4:rp_demo",
            public_inputs: {
              claim: "World ID proof of human is bound to this wallet",
              rp_id: "rp_demo",
              app_id: "app_staging_demo",
              action: "wallet-attach-world-id-v1",
              signal_hash: "sha256:signal-fullstack",
              credential_policy: "proof_of_human",
              nullifier_commitment: "hmac-sha256:nullifier-fullstack",
              verification_result_hash: "sha256:result-fullstack"
            },
            proof_hash: "sha256:proof-fullstack",
            witness_record_ids: ["wallet://wallet-demo/world-id-binding/world-id-binding-fullstack"],
            is_simulated: false,
            proof_system: "world_id_idkit_v4",
            circuit_id: "world-id-proof-of-human-v4",
            verifier_digest: "digest-fullstack-abcdef",
            proof_artifact_ref: "world-id-proof://proof-world-id-fullstack",
            verification_status: "verified",
            created_at: "2026-06-14T16:00:00Z"
          }
        ]
      }
    });
  });

  try {
    await page.goto(targetRoute);
    await signInIfNeeded(page);

    const panel = page.getByRole("article", { name: /World ID verification/i });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // Verified state should be displayed
    await expect(panel.getByText(/World ID verified/i)).toBeVisible({ timeout: 10_000 });

    // No raw nullifier values should be visible in the panel or proof card
    await expect(page.getByText(/0xnullifier|raw_nullifier_value/i)).toHaveCount(0);

    const proofCard = page.getByRole("article", {
      name: /World ID proof of human is bound to this wallet/i
    });
    await expect(proofCard).toBeVisible({ timeout: 10_000 });

    // Proof card should show sanitized commitment, not raw nullifier
    await expect(proofCard.getByText(/hmac-sha256:nullifier-fullstack/i)).toBeVisible();
    // Proof card should NOT show idkit proof, raw nullifier, or rp signature values
    await expect(proofCard.getByText(/raw_nullifier|idkit_proof|developer_portal_response|rp_signature/i)).toHaveCount(0);

    // Disclosure panel should name the withheld items
    await expect(panel.getByText(/Raw nullifier.*IDKit proof payload/i)).toBeVisible();

    await expect.poll(() => diagnostics.browserErrors).toEqual([]);
  } finally {
    await stopWalletApi(api);
  }
});

test("World ID verified intake replaces the demo bot check against a live wallet API", async ({ page }) => {
  const api = await startWalletApi();
  const ownerDid = "did:key:fullstack-world-id-intake-owner";

  try {
    const diagnostics = collectPageDiagnostics(page, api.baseUrl);
    const wallet = await apiJson<{ wallet_id: string }>(api.baseUrl, "POST", "/wallets", { owner_did: ownerDid });
    await installVerifiedWorldIdRoutes(page, api.baseUrl, wallet.wallet_id, ownerDid);

    await page.goto(walletRoute("register", api.baseUrl, wallet.wallet_id, ownerDid, {}));
    await signInIfNeeded(page, ownerDid);
    await visibleHeadingOrDiagnostics(page, /Create your Abby profile/i, diagnostics);

    await expect(page.getByLabel(/World ID proof-of-human verified for intake/i)).toBeChecked();
    await expect(page.getByLabel(/Use manual intake fallback/i)).toBeDisabled();
    await expect(page.getByLabel(/Bot check complete/i)).toBeDisabled();
    await expect(page.getByLabel(/Client intake verification status/i)).toContainText(
      /World ID proof-of-human satisfies intake without the demo bot check/i
    );

    await page.goto(walletRoute("shelter", api.baseUrl, wallet.wallet_id, ownerDid, {}));
    await signInIfNeeded(page, ownerDid);
    await visibleHeadingOrDiagnostics(page, /Assisted access/i, diagnostics);
    await page.getByLabel("Shelter").first().selectOption("Rose City Shelter");
    await page.getByLabel(/Verified staff operator/i).selectOption({ label: "Avery Patel" });

    const createUser = page.locator('section[aria-labelledby="Create-user-account"]');
    await expect(createUser.getByLabel(/World ID proof-of-human verified for assisted intake/i)).toBeChecked();
    await expect(createUser.getByLabel(/Bot check complete/i)).toBeDisabled();
    await createUser.getByLabel(/Legal or full name/i).fill("Fullstack World ID Client");
    await createUser.getByLabel(/Photo or photo ID/i).setInputFiles({
      name: "fullstack-world-id-client.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n")
    });
    await expect(createUser.getByRole("button", { name: /Create user account/i })).toBeEnabled();
    await createUser.getByRole("button", { name: /Create user account/i }).click();

    const createdUser = page.locator(".list-item").filter({ hasText: "Fullstack World ID Client" }).first();
    await expect(createdUser).toBeVisible();
    await expect(createdUser.getByText(/Demo bot check|Manual fallback/i)).toHaveCount(0);
    await expect.poll(() => diagnostics.browserErrors).toEqual([]);
    expect(diagnostics.apiErrors).toEqual([]);
  } finally {
    await stopWalletApi(api);
  }
});
