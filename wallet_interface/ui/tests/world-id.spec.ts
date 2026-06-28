/**
 * World ID IDKit Playwright tests.
 *
 * These tests mock IDKit and wallet API responses to verify:
 *  - Disabled state (backend disabled, missing app_id, no actor DID)
 *  - Successful verification (via __abbyWorldIdPanelTest test hook)
 *  - Proof refresh after successful verification
 *  - Backend failure during signature request or verification
 *  - Nullifier conflict messaging (409 from /verifications)
 *  - Mobile layout assertions
 *  - No raw nullifier exposure in visible UI
 *
 * The WorldIdVerificationPanel exposes window.__abbyWorldIdPanelTest only after
 * this spec opts in via window.__abbyEnableWorldIdPanelTest and an activeRequest
 * is set, so tests can simulate IDKit success / error without driving the real
 * World ID browser widget.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 5174);
const walletApiBaseUrl = `http://127.0.0.1:${playwrightPort}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walletRoute(route: string, actorDid: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({
    walletApiBaseUrl,
    walletId: "wallet-demo",
    actorDid,
    ...params
  });
  return `/?${query.toString()}#/${route}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function buildRpSignatureResponse(overrides: Record<string, unknown> = {}) {
  const now = nowSeconds();
  return {
    app_id: "app_staging_demo",
    action: "wallet-attach-world-id-v1",
    signal: "211-ai:wallet-world-id:v1:wallet-demo:did:key:owner",
    environment: "staging",
    allow_legacy_proofs: false,
    require_user_presence: true,
    rp_context: {
      rp_id: "rp_demo",
      nonce: "nonce-world-id-test",
      created_at: now,
      expires_at: now + 300,
      signature: "0xmocksignature"
    },
    ...overrides
  };
}

function buildWorldIdConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    app_id: "app_staging_demo",
    rp_id: "rp_demo",
    default_action: "wallet-attach-world-id-v1",
    environment: "staging",
    credential_policy: "proof_of_human",
    allow_legacy_proofs: false,
    require_user_presence: true,
    ...overrides
  };
}

function buildWorldIdStatus(verified: boolean) {
  return {
    verified,
    binding_id: verified ? "world-id-binding-demo" : null,
    proof_id: verified ? "proof-world-id-human" : null,
    verified_at: verified ? "2026-06-14T16:00:00Z" : null,
    action: "wallet-attach-world-id-v1",
    credential_policy: "proof_of_human",
    active_binding_count: verified ? 1 : 0
  };
}

function buildWorldIdProofReceipt() {
  return {
    proof_id: "proof-world-id-human",
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
      signal_hash: "sha256:signal",
      credential_policy: "proof_of_human",
      nullifier_commitment: "hmac-sha256:nullifier",
      verification_result_hash: "sha256:result"
    },
    proof_hash: "sha256:proof",
    witness_record_ids: ["wallet://wallet-demo/world-id-binding/world-id-binding-demo"],
    is_simulated: false,
    proof_system: "world_id_idkit_v4",
    circuit_id: "world-id-proof-of-human-v4",
    verifier_digest: "digest1234567890abcdef",
    proof_artifact_ref: "world-id-proof://proof-world-id-human",
    verification_status: "verified",
    created_at: "2026-06-14T16:00:00Z"
  };
}

async function mockBaseWalletRoutes(route: Route) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path.endsWith("/access-requests")) {
    await route.fulfill({ json: { requests: [] } });
    return true;
  }
  if (path.endsWith("/grant-receipts")) {
    await route.fulfill({ json: { receipts: [] } });
    return true;
  }
  if (path.endsWith("/records")) {
    await route.fulfill({ json: { records: [] } });
    return true;
  }
  if (path.endsWith("/audit")) {
    await route.fulfill({ json: { events: [] } });
    return true;
  }
  if (path === "/wallets/snapshots") {
    await route.fulfill({ json: { wallet_ids: [] } });
    return true;
  }
  return false;
}

async function signInIfNeeded(page: Page) {
  const username = page.getByLabel(/username/i).first();
  try {
    await username.waitFor({ state: "visible", timeout: 1500 });
  } catch {
    return false;
  }
  await username.fill("abby");
  await page.getByLabel(/password/i).fill("safety-plan");
  await page.getByRole("button", { name: /log in|login|sign in|continue/i }).click();
  return true;
}

async function openWalletRoute(page: Page, route: string) {
  await page.addInitScript(() => {
    (window as unknown as { __abbyEnableWorldIdPanelTest?: boolean }).__abbyEnableWorldIdPanelTest = true;
  });
  await page.goto(route);
  const signedIn = await signInIfNeeded(page);
  if (signedIn) {
    // After sign-in, navigate to the intended route again
    await page.goto(route);
    await signInIfNeeded(page);
  }
}

/** Wait until window.__abbyWorldIdPanelTest is populated (IDKit phase entered). */
async function waitForIdkitTestHook(page: Page, timeout = 10000) {
  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, unknown>).__abbyWorldIdPanelTest !== "undefined",
    { timeout }
  );
}

/** Simulate a successful IDKit completion via the test hook. */
async function simulateIdkitSuccess(page: Page) {
  await page.evaluate(() => {
    const hook = (window as unknown as Record<string, unknown>).__abbyWorldIdPanelTest as {
      simulateSuccess: (result: Record<string, unknown>) => Promise<void>;
    };
    // verifyWithBackend may throw when the backend rejects the proof – the
    // component still updates its UI state before throwing, so we swallow the
    // rejection here and let the test assert the resulting UI state instead.
    return hook.simulateSuccess({
      merkle_root: "0xmerkle",
      nullifier_hash: "0xnullifier",
      proof: "0xproof",
      verification_level: "orb"
    }).catch(() => undefined);
  });
}

/** Simulate an IDKit error via the test hook. */
async function simulateIdkitError(page: Page, errorCode: string) {
  await page.evaluate((code: string) => {
    const hook = (window as unknown as Record<string, unknown>).__abbyWorldIdPanelTest as {
      simulateError: (code: string) => void;
    };
    hook.simulateError(code);
  }, errorCode);
}

// ---------------------------------------------------------------------------
// Disabled-state tests
// ---------------------------------------------------------------------------

test("World ID panel shows disabled state when backend config returns enabled:false", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig({ enabled: false }) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));
  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText(/Unavailable/i)).toBeVisible();
  await expect(panel.getByRole("button", { name: /Verify with World ID/i })).toBeDisabled();
});

test("World ID panel shows disabled state when no actorDid is provided", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  // Route with empty actorDid
  await openWalletRoute(page, walletRoute("proof-center", ""));
  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByRole("button", { name: /Verify with World ID/i })).toBeDisabled();
  // Should show explanation about missing actorDid
  await expect(panel.getByText(/actor DID|wallet API/i)).toBeVisible();
});

test("World ID panel shows disabled state when wallet API is not configured", async ({ page }) => {
  // Navigate without walletApiBaseUrl param
  await page.goto("/?#/proof-center");
  await signInIfNeeded(page);
  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByRole("button", { name: /Verify with World ID/i })).toBeDisabled();
});

// ---------------------------------------------------------------------------
// Successful verification and proof refresh
// ---------------------------------------------------------------------------

test("World ID successful verification binds proof and refreshes status", async ({ page }) => {
  let verificationRequests = 0;
  let statusRequestsAfterVerify = 0;
  let verificationHappened = false;

  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      statusRequestsAfterVerify += verificationHappened ? 1 : 0;
      await route.fulfill({
        json: buildWorldIdStatus(verificationHappened)
      });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      await route.fulfill({ json: buildRpSignatureResponse() });
      return;
    }
    if (path.endsWith("/world-id/verifications") && method === "POST") {
      verificationRequests += 1;
      verificationHappened = true;
      await route.fulfill({
        json: { ok: true, proof_id: "proof-world-id-human", binding_id: "world-id-binding-demo" }
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({
        json: verificationHappened ? { proofs: [buildWorldIdProofReceipt()] } : { proofs: [] }
      });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText(/Not verified/i)).toBeVisible();

  // Click "Verify with World ID" and wait for the IDKit phase
  await panel.getByRole("button", { name: /Verify with World ID/i }).click();
  await waitForIdkitTestHook(page);

  // Simulate IDKit reporting a successful proof
  await simulateIdkitSuccess(page);

  // Panel should show success state
  await expect(panel.getByText(/World ID proof-of-human is now bound to this wallet/i)).toBeVisible({
    timeout: 10000
  });
  await expect(panel.getByText(/World ID verified/i)).toBeVisible();

  // At least one verification request should have been made
  expect(verificationRequests).toBe(1);
  // Status should have been refreshed after verification
  expect(statusRequestsAfterVerify).toBeGreaterThan(0);
});

test("World ID proof receipt appears in proof center after successful verification", async ({ page }) => {
  let verified = false;

  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(verified) });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      await route.fulfill({ json: buildRpSignatureResponse() });
      return;
    }
    if (path.endsWith("/world-id/verifications") && method === "POST") {
      verified = true;
      await route.fulfill({ json: { ok: true, proof_id: "proof-world-id-human" } });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({
        json: verified ? { proofs: [buildWorldIdProofReceipt()] } : { proofs: [] }
      });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  await panel.getByRole("button", { name: /Verify with World ID/i }).click();
  await waitForIdkitTestHook(page);
  await simulateIdkitSuccess(page);

  // Proof card should appear
  await expect(
    page.getByRole("article", { name: /World ID proof of human is bound to this wallet/i })
  ).toBeVisible({ timeout: 10000 });

  const proofCard = page.getByRole("article", { name: /World ID proof of human is bound to this wallet/i });
  await expect(proofCard).toContainText("world_id_proof_of_human");
  await expect(proofCard).toContainText("world_id_idkit_v4");
  await expect(proofCard).toContainText("proof_of_human");
});

// ---------------------------------------------------------------------------
// Backend failure tests
// ---------------------------------------------------------------------------

test("World ID panel shows backend failure when RP signature request fails", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      await route.fulfill({
        status: 503,
        json: { detail: "World ID signature service temporarily unavailable." }
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  await panel.getByRole("button", { name: /Verify with World ID/i }).click();

  // Panel should show a failure or warning state
  await expect(
    panel.getByText(/signature service temporarily unavailable|could not be created|verification could not|failed/i)
  ).toBeVisible({ timeout: 10000 });
  // Button should return to enabled (not stuck in loading)
  await expect(panel.getByRole("button", { name: /Verify with World ID/i })).not.toBeDisabled({ timeout: 5000 });
});

test("World ID panel shows backend failure when verification endpoint fails", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      await route.fulfill({ json: buildRpSignatureResponse() });
      return;
    }
    if (path.endsWith("/world-id/verifications") && method === "POST") {
      await route.fulfill({
        status: 500,
        json: { detail: "Developer Portal verification failed. The wallet was not updated." }
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  await panel.getByRole("button", { name: /Verify with World ID/i }).click();
  await waitForIdkitTestHook(page);
  await simulateIdkitSuccess(page);

  // Should show backend failure messaging
  await expect(
    panel.getByText(
      /Developer Portal verification failed|verification failed|wallet was not updated/i
    )
  ).toBeVisible({ timeout: 10000 });
});

// ---------------------------------------------------------------------------
// Nullifier conflict messaging
// ---------------------------------------------------------------------------

test("World ID panel shows conflict message when nullifier is bound to another wallet (409)", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      await route.fulfill({ json: buildRpSignatureResponse() });
      return;
    }
    if (path.endsWith("/world-id/verifications") && method === "POST") {
      await route.fulfill({
        status: 409,
        json: {
          code: "nullifier_conflict",
          detail: "This World ID proof is already bound to another wallet."
        }
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  await panel.getByRole("button", { name: /Verify with World ID/i }).click();
  await waitForIdkitTestHook(page);
  await simulateIdkitSuccess(page);

  // Should show conflict / replay messaging
  await expect(
    panel.getByText(/already bound to another wallet|proof has already been used/i)
  ).toBeVisible({ timeout: 10000 });
});

test("World ID panel shows nullifier-replayed message from IDKit error code", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/world-id/rp-signature") && method === "POST") {
      await route.fulfill({ json: buildRpSignatureResponse() });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  await panel.getByRole("button", { name: /Verify with World ID/i }).click();
  await waitForIdkitTestHook(page);

  // Simulate IDKit reporting nullifier_replayed error
  await simulateIdkitError(page, "nullifier_replayed");

  await expect(
    panel.getByText(/already been used|active wallet binding|replay/i)
  ).toBeVisible({ timeout: 10000 });
});

// ---------------------------------------------------------------------------
// Privacy: no raw nullifier in visible UI
// ---------------------------------------------------------------------------

test("World ID verified status shows no raw nullifier in visible UI", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(true) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [buildWorldIdProofReceipt()] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText(/World ID verified/i)).toBeVisible();

  // The disclosure panel should list "Private" items but NOT display their raw values
  await expect(panel.getByText(/Raw nullifier, IDKit proof payload/i)).toBeVisible();

  // No raw nullifier hash (0x...) should be visible in the page body
  // nullifier_hash is a hex string; no hex-looking nullifier should appear
  const rawNullifierPattern = /0xnullifier|raw_nullifier_value|nullifier_hash.*0x[0-9a-f]{10}/i;
  await expect(page.getByText(rawNullifierPattern)).toHaveCount(0);

  // Proof card should also not expose raw nullifier
  const proofCard = page.getByRole("article", { name: /World ID proof of human/i }).first();
  if (await proofCard.isVisible()) {
    await expect(proofCard.getByText(/raw_nullifier|idkit_proof|developer_portal_response|rp_signature/i)).toHaveCount(0);
    // nullifier_commitment (the safe HMAC) is acceptable but raw nullifier hash is not
    // Verify nullifier_commitment is shown (safe) but no "0x" nullifier blob
    await expect(proofCard.getByText(/hmac-sha256:nullifier/i)).toBeVisible();
  }
});

test("World ID verification disclosure does not expose private field values", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  // The "Private" row names the withheld items but does not display their values
  await expect(panel.getByText(/Raw nullifier.*IDKit proof payload.*RP signature.*Developer Portal response/i)).toBeVisible();

  // No actual proof hex blobs or nullifier hashes in the DOM
  await expect(page.locator("text=0xproof")).toHaveCount(0);
  await expect(page.locator("text=0xnullifier")).toHaveCount(0);
  await expect(page.locator("text=0xsignature")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Mobile layout
// ---------------------------------------------------------------------------

test("World ID panel renders correctly on mobile viewport", async ({ page }, testInfo) => {
  test.skip(!/Mobile/i.test(testInfo.project.name), "Mobile layout test – skipped on desktop projects");

  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  // Panel must be within viewport width (no horizontal overflow)
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  const viewportSize = page.viewportSize();
  expect(viewportSize).not.toBeNull();

  if (panelBox && viewportSize) {
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewportSize.width + 2); // 2px tolerance
  }

  // Key UI elements should be visible and accessible on mobile
  await expect(panel.getByRole("heading", { name: /World ID verification/i })).toBeVisible();
  await expect(panel.getByText(/Proof-of-human wallet binding/i)).toBeVisible();
  await expect(panel.getByRole("button", { name: /Verify with World ID/i })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Refresh status/i })).toBeVisible();
});

test("World ID panel elements are accessible on mobile - buttons have discernible names", async ({ page }, testInfo) => {
  test.skip(!/Mobile/i.test(testInfo.project.name), "Mobile accessibility test – skipped on desktop projects");

  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(true) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [buildWorldIdProofReceipt()] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText(/World ID verified/i)).toBeVisible();

  // Buttons must have accessible names (role="button" with visible label)
  const verifyButton = panel.getByRole("button", { name: /Verify with World ID/i });
  const refreshButton = panel.getByRole("button", { name: /Refresh status/i });
  await expect(verifyButton).toBeVisible();
  await expect(refreshButton).toBeVisible();
});

// ---------------------------------------------------------------------------
// Status display and refresh
// ---------------------------------------------------------------------------

test("World ID refresh status button re-fetches config and status", async ({ page }) => {
  let configFetchCount = 0;
  let statusFetchCount = 0;

  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      configFetchCount += 1;
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      statusFetchCount += 1;
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  const initialConfigCount = configFetchCount;
  const initialStatusCount = statusFetchCount;

  await panel.getByRole("button", { name: /Refresh status/i }).click();

  // Wait for refresh to complete
  await expect(panel.getByText(/Not verified|World ID verified/i)).toBeVisible({ timeout: 5000 });

  // Both config and status should have been re-fetched
  expect(configFetchCount).toBeGreaterThan(initialConfigCount);
  expect(statusFetchCount).toBeGreaterThan(initialStatusCount);
});

test("World ID panel shows verified state when status is already verified on load", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(true) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [buildWorldIdProofReceipt()] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText(/World ID verified/i)).toBeVisible();
  // Verify button should still be available (can re-verify or update binding)
  await expect(panel.getByRole("button", { name: /Verify with World ID/i })).toBeVisible();
  // Proof card should be visible
  await expect(
    page.getByRole("article", { name: /World ID proof of human is bound to this wallet/i })
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Disclosure panel content
// ---------------------------------------------------------------------------

test("World ID disclosure panel lists public claim and withheld private fields", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/world-id/config")) {
      await route.fulfill({ json: buildWorldIdConfig() });
      return;
    }
    if (path.endsWith("/world-id/status")) {
      await route.fulfill({ json: buildWorldIdStatus(false) });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (await mockBaseWalletRoutes(route)) return;
    await route.fulfill({ status: 404, json: { error: "unexpected call", path } });
  });

  await openWalletRoute(page, walletRoute("proof-center", "did:key:owner"));

  const panel = page.getByRole("article", { name: /World ID verification/i });
  await expect(panel).toBeVisible({ timeout: 10000 });

  // Public claim disclosure
  await expect(panel.getByText(/World ID proof-of-human is bound to this wallet/i)).toBeVisible();

  // "Not a claim" disclosure – legal identity attributes not proven
  await expect(panel.getByText(/Legal name, age, citizenship, address/i)).toBeVisible();

  // Private disclosure – raw nullifier etc withheld
  await expect(panel.getByText(/Raw nullifier.*IDKit proof payload.*RP signature.*Developer Portal response/i)).toBeVisible();
});
