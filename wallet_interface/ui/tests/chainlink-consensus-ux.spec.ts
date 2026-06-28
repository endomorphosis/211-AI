import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SANITIZER_SENTINEL_STRINGS,
  chainlinkConsensusFixturesById,
  type ChainlinkConsensusFixtureId
} from "./fixtures/chainlink-consensus-fixtures";

const walletApiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5174}`;
const walletId = "wallet-demo";
const actorDid = "did:key:chainlink-ux-reviewer";
const repoRoot = path.resolve(process.cwd(), "../..");
const artifactRoot = path.join(repoRoot, "artifacts/chainlink-zkml-ui-review");

function walletRoute(route: string) {
  const query = new URLSearchParams({ actorDid, walletApiBaseUrl, walletId });
  return `/?${query.toString()}#/${route}`;
}

async function signInIfNeeded(page: Page) {
  const username = page.getByLabel(/username/i).first();
  try {
    await username.waitFor({ state: "visible", timeout: 1_000 });
  } catch {
    return;
  }
  await username.fill("chainlink-reviewer");
  await page.getByLabel(/password/i).fill("safety-plan");
  await page.getByRole("button", { name: /log in|login|sign in|continue/i }).click();
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
    witness_record_ids: ["rec-benefits-letter"],
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

function buildProofs() {
  const receiptOnlyConsensus = fixtureConsensus("receipt-only");
  const creConsensus = fixtureConsensus("cre");
  const zkmlConsensus = fixtureConsensus("zkml");
  const teeConsensus = fixtureConsensus("tee");
  const quorumFailureConsensus = fixtureConsensus("quorum-failure");
  const proofFailureConsensus = fixtureConsensus("proof-failure");
  const creMismatchConsensus = {
    ...creConsensus,
    fail_closed_error: "cre_workflow_mismatch",
    failure_reason: "CRE workflow report did not match the request/output commitments.",
    verification_label: "Manual review required"
  };

  return [
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
    })
  ];
}

async function fulfillWalletRoute(route: Route) {
  const url = new URL(route.request().url());
  const pathName = url.pathname;
  const libp2pConsensus = fixtureConsensus("libp2p");
  const receiptOnlyConsensus = fixtureConsensus("receipt-only");
  const quorumFailureConsensus = fixtureConsensus("quorum-failure");
  const proofFailureConsensus = fixtureConsensus("proof-failure");

  if (pathName === "/wallets/snapshots") {
    await route.fulfill({ json: { wallet_ids: [walletId] } });
    return;
  }
  if (pathName.endsWith("/snapshot")) {
    await route.fulfill({ json: { wallet_id: walletId, exists: true, valid: true, format: "envelope" } });
    return;
  }
  if (pathName.endsWith("/proofs")) {
    await route.fulfill({ json: { proofs: buildProofs() } });
    return;
  }
  if (pathName.endsWith("/access-requests")) {
    await route.fulfill({
      json: {
        requests: [
          {
            request_id: "access-libp2p-consensus",
            requester_did: "did:key:provider",
            audience_did: actorDid,
            resources: [`wallet://${walletId}/records/rec-benefits-letter`],
            abilities: ["record/analyze"],
            purpose: "recipient access derived artifact",
            status: "pending",
            created_at: "2026-06-14T12:00:00Z",
            consensus: libp2pConsensus
          },
          {
            request_id: "access-quorum-failure",
            requester_did: "did:key:manual-provider",
            audience_did: actorDid,
            resources: [`wallet://${walletId}/records/rec-benefits-letter`],
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
  if (pathName.endsWith("/grant-receipts")) {
    await route.fulfill({ json: { receipts: [] } });
    return;
  }
  if (pathName.endsWith("/records") && url.searchParams.get("data_type") === "document") {
    await route.fulfill({
      json: {
        records: [
          {
            record_id: "rec-benefits-letter",
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
            created_at: "2026-06-14T12:01:00Z",
            metadata: { consensus: quorumFailureConsensus }
          }
        ]
      }
    });
    return;
  }
  if (pathName.includes("/records/") && pathName.endsWith("/storage")) {
    await route.fulfill({ json: { ok: true } });
    return;
  }
  if (pathName.endsWith("/audit")) {
    await route.fulfill({
      json: {
        events: [
          {
            event_id: "audit-libp2p-consensus",
            created_at: "2026-06-14T12:02:00Z",
            actor_did: actorDid,
            action: "record/analyze_redacted",
            resource: `wallet://${walletId}/records/rec-benefits-letter`,
            decision: "allow",
            consensus: libp2pConsensus
          },
          {
            event_id: "audit-proof-failure",
            created_at: "2026-06-14T12:03:00Z",
            actor_did: actorDid,
            action: "proof/verify",
            resource: `wallet://${walletId}/proofs/proof-failure-consensus`,
            decision: "deny",
            consensus: proofFailureConsensus
          }
        ]
      }
    });
    return;
  }
  if (pathName.endsWith("/world-id/config")) {
    await route.fulfill({ json: { enabled: false, allowed_actions: [], default_action: "" } });
    return;
  }
  if (pathName.endsWith("/world-id/status")) {
    await route.fulfill({
      json: { enabled: false, wallet: { wallet_id: walletId, binding_count: 0, active_binding_count: 0, bindings: [] } }
    });
    return;
  }
  if (pathName === `/wallets/${walletId}`) {
    await route.fulfill({
      json: { wallet_id: walletId, owner_did: actorDid, controller_dids: [actorDid], device_dids: [actorDid] }
    });
    return;
  }
  await route.fulfill({ json: {} });
}

async function installRoutes(page: Page) {
  await page.route("**/wallets/**", fulfillWalletRoute);
  await page.route("**/analytics/**", async (route) => route.fulfill({ json: { templates: [], consents: [] } }));
  await page.route("**/exports/**", async (route) => route.fulfill({ json: { valid: true } }));
  await page.route("**/ops/health", async (route) => route.fulfill({ json: { status: "ok", checks: [] } }));
}

async function openRoute(page: Page, route: string, heading: RegExp) {
  await page.goto(walletRoute(route));
  await signInIfNeeded(page);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          className: String((element as HTMLElement).className || ""),
          display: style.display,
          height: rect.height,
          right: rect.right,
          text: String(element.textContent || "").trim().slice(0, 80),
          visibility: style.visibility,
          width: rect.width
        };
      })
      .filter(
        (item) =>
          item.display !== "none" &&
          item.visibility !== "hidden" &&
          item.width > 0 &&
          item.height > 0 &&
          item.right > width + 2
      )
      .slice(0, 8);
  });
  expect(overflow).toEqual([]);
}

async function expectNoSentinelLeakage(page: Page) {
  const body = await page.locator("body").innerText();
  for (const token of SANITIZER_SENTINEL_STRINGS) {
    expect(body).not.toContain(token);
  }
}

async function expectKeyboardReachableConsensus(page: Page) {
  await page.keyboard.press("Tab");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return active?.textContent?.trim() || active?.getAttribute("aria-label") || active?.tagName || "";
      })
    )
    .not.toBe("");
}

async function archiveScreenshot(page: Page, route: string, projectName: string) {
  const viewportName = projectName.replace(/\W+/g, "-").toLowerCase();
  const targetDir = path.join(artifactRoot, viewportName);
  await mkdir(targetDir, { recursive: true });
  await page.screenshot({ fullPage: false, path: path.join(targetDir, `${route}.png`) });
}

test("review matrix covers Chainlink consensus UX evidence", async () => {
  const matrix = JSON.parse(await readFile(path.join(artifactRoot, "review-matrix.json"), "utf-8")) as {
    checks: string[];
    reviewed_surfaces: string[];
    viewport_coverage: Array<{ name: string }>;
  };
  expect(matrix.reviewed_surfaces).toEqual(
    expect.arrayContaining([
      "recipient-access-artifacts",
      "wallet-uploads",
      "proof-center",
      "qr-proof-review",
      "provider-eligibility",
      "public-analytics",
      "security-audit",
      "audit-history"
    ])
  );
  expect(matrix.viewport_coverage.map((entry) => entry.name)).toEqual(
    expect.arrayContaining(["Desktop Chrome", "Mobile Chrome", "Mobile Safari"])
  );
  expect(matrix.checks.join(" ")).toMatch(/keyboard focus/i);
  expect(matrix.checks.join(" ")).toMatch(/manual-review fallback/i);
  expect(matrix.checks.join(" ")).toMatch(/operator secret/i);
});

test("Chainlink consensus badges are accessible, non-overclaiming, and leak-free across wallet routes", async ({
  page
}, testInfo) => {
  await installRoutes(page);
  const routes: Array<[string, RegExp, RegExp]> = [
    ["home", /Welcome to your safety plan!/i, /Recipient access artifacts/i],
    ["uploads", /Saved files and info/i, /Wallet proof receipts/i],
    ["proof-center", /Verified wallet claims/i, /Manual review required/i],
    ["exports", /Shareable wallet bundles/i, /QR proof review/i],
    ["social-services", /Find support/i, /Provider proof review/i],
    ["analytics", /Public proof dashboard/i, /CRE claims/i],
    ["security", /Account safety/i, /Proof security review/i],
    ["audit", /Consent and access history/i, /Proof audit coverage/i]
  ];
  const consensusPanel = page.locator(
    [
      '[aria-label*="Chainlink CRE verified" i]',
      '[aria-label*="Consensus receipt" i]',
      '[aria-label*="Manual review required" i]',
      '[aria-label*="TEE attested" i]',
      '[aria-label*="ZKML checker verified" i]',
      '[aria-label*="libp2p quorum receipt" i]'
    ].join(", ")
  );

  for (const [route, pageHeading, surfaceHeading] of routes) {
    await openRoute(page, route, pageHeading);
    await expect(page.getByText(surfaceHeading).first()).toBeVisible();
    await expect(consensusPanel.first()).toBeVisible();
    await expectKeyboardReachableConsensus(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSentinelLeakage(page);
    await archiveScreenshot(page, route, testInfo.project.name);
  }

  if (testInfo.project.name === "Desktop Chrome") {
    await page.setViewportSize({ width: 393, height: 851 });
    for (const [route, pageHeading, surfaceHeading] of routes) {
      await openRoute(page, route, pageHeading);
      await expect(page.getByText(surfaceHeading).first()).toBeVisible();
      await expect(consensusPanel.first()).toBeVisible();
      await expectKeyboardReachableConsensus(page);
      await expectNoHorizontalOverflow(page);
      await expectNoSentinelLeakage(page);
      await archiveScreenshot(page, route, "Mobile Chrome");
    }
  }

  await openRoute(page, "proof-center", /Verified wallet claims/i);
  await expect(page.getByText("Manual review required").first()).toBeVisible();
  await expect(page.getByText(/CRE workflow report did not match/i).first()).toBeVisible();
  await expect(page.getByText("TEE evidence, not ZK proof").first()).toBeVisible();
  await expect(page.getByText("CRE verification, not ZK proof").first()).toBeVisible();
  await expect(page.getByText("Consensus receipt, not ZK proof").first()).toBeVisible();
  await expect(page.getByText("verified proof", { exact: true })).toHaveCount(0);
  await expectNoSentinelLeakage(page);
});
