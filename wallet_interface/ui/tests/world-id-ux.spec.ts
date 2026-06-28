import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  WORLD_ID_ACTOR_DID,
  WORLD_ID_WALLET_ID,
  buildWorldIdConfig,
  buildWorldIdRpSignature,
  buildWorldIdStatus,
  worldIdApiProofReceipt,
  worldIdForbiddenPrivateTokens,
  worldIdSanitizedExportReview,
  worldIdSanitizedQrProofBundle
} from "./fixtures/world-id-fixtures";

const walletApiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5174}`;
const repoRoot = path.resolve(process.cwd(), "../..");
const artifactRoot = path.join(repoRoot, "artifacts/world-id-idkit-ui-review");

function walletRoute(route: string, options: { actorDid?: string } = {}) {
  const query = new URLSearchParams({
    actorDid: options.actorDid ?? WORLD_ID_ACTOR_DID,
    walletApiBaseUrl,
    walletId: WORLD_ID_WALLET_ID
  });
  return `/?${query.toString()}#/${route}`;
}

async function signInIfNeeded(page: Page) {
  const username = page.getByLabel(/username/i).first();
  try {
    await username.waitFor({ state: "visible", timeout: 1_000 });
  } catch {
    return;
  }
  await username.fill("world-id-reviewer");
  await page.getByLabel(/password/i).fill("safety-plan");
  await page.getByRole("button", { name: /log in|login|sign in|continue/i }).click();
}

function walletSummary() {
  return {
    wallet_id: WORLD_ID_WALLET_ID,
    owner_did: WORLD_ID_ACTOR_DID,
    controller_dids: [WORLD_ID_ACTOR_DID],
    device_dids: [WORLD_ID_ACTOR_DID]
  };
}

async function fulfillWalletRoute(route: Route, options: { enabled?: boolean; verified?: boolean }) {
  const url = new URL(route.request().url());
  const pathName = url.pathname;
  const enabled = options.enabled ?? true;
  const verified = options.verified ?? true;

  if (pathName === "/wallets/snapshots") {
    await route.fulfill({ json: { wallet_ids: [WORLD_ID_WALLET_ID] } });
    return;
  }
  if (pathName === `/wallets/${WORLD_ID_WALLET_ID}`) {
    await route.fulfill({ json: walletSummary() });
    return;
  }
  if (pathName.endsWith("/snapshot")) {
    await route.fulfill({ json: { wallet_id: WORLD_ID_WALLET_ID, exists: true, valid: true, format: "envelope" } });
    return;
  }
  if (pathName.endsWith("/world-id/config")) {
    await route.fulfill({
      json: buildWorldIdConfig(enabled ? {} : { enabled: false, app_id: "", rp_id: "" })
    });
    return;
  }
  if (pathName.endsWith("/world-id/status")) {
    await route.fulfill({
      json: buildWorldIdStatus({
        verified: enabled && verified,
        overrides: enabled ? {} : { enabled: false, app_id: "", rp_id: "" }
      })
    });
    return;
  }
  if (pathName.endsWith("/world-id/rp-signature")) {
    await route.fulfill({ json: buildWorldIdRpSignature() });
    return;
  }
  if (pathName.endsWith("/proofs")) {
    await route.fulfill({ json: { proofs: enabled && verified ? [worldIdApiProofReceipt] : [] } });
    return;
  }
  if (pathName.endsWith("/audit")) {
    await route.fulfill({
      json: {
        events: [
          {
            event_id: "world-id-ux-audit",
            actor_did: WORLD_ID_ACTOR_DID,
            action: "world_id/verify",
            created_at: "2026-06-14T16:00:00.000Z",
            decision: "allow",
            resource: `wallet://${WORLD_ID_WALLET_ID}/proofs/${worldIdApiProofReceipt.proof_id}`
          }
        ]
      }
    });
    return;
  }
  if (pathName.endsWith("/access-requests")) {
    await route.fulfill({ json: { requests: [] } });
    return;
  }
  if (pathName.endsWith("/grant-receipts")) {
    await route.fulfill({ json: { receipts: [] } });
    return;
  }
  if (pathName.endsWith("/records")) {
    await route.fulfill({
      json: {
        records: [
          {
            record_id: "rec-world-id-public-proof",
            data_type: "document",
            sensitivity: "medium",
            public_descriptor: "World ID public proof review note",
            status: "active",
            created_at: "2026-06-14T16:00:00.000Z"
          }
        ]
      }
    });
    return;
  }
  if (pathName.endsWith("/storage")) {
    await route.fulfill({ json: { wallet_id: WORLD_ID_WALLET_ID, ok: true, records: [] } });
    return;
  }
  await route.fulfill({ json: {} });
}

async function installRoutes(page: Page, options: { enabled?: boolean; verified?: boolean } = {}) {
  const apiErrors: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && ["/wallets", "/analytics", "/exports", "/ops"].some((prefix) => url.pathname.startsWith(prefix))) {
      apiErrors.push(`${response.status()} ${url.pathname}`);
    }
  });
  await page.route("**/wallets/**", async (route) => fulfillWalletRoute(route, options));
  await page.route("**/analytics/**", async (route) => route.fulfill({ json: { templates: [], consents: [] } }));
  await page.route("**/exports/**", async (route) => route.fulfill({ json: { valid: true } }));
  await page.route("**/ops/health", async (route) => route.fulfill({ json: { status: "ok", checks: [] } }));
  return apiErrors;
}

async function openWalletSurface(page: Page, route: string, heading: RegExp, options: { actorDid?: string } = {}) {
  await page.goto(walletRoute(route, options));
  await signInIfNeeded(page);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
}

async function expectNoPrivateWorldIdLeakage(page: Page) {
  const body = await page.locator("body").innerText();
  for (const token of worldIdForbiddenPrivateTokens) {
    expect(body, `visible UI must not contain ${token}`).not.toContain(token);
  }
  expect(body).not.toMatch(/World ID proves legal identity|verified legal identity|guaranteed eligibility|citizenship verified/i);
  const downloadMetadata = await page.locator("a[download]").evaluateAll((links) =>
    links.map((link) => `${link.textContent || ""} ${link.getAttribute("href") || ""} ${link.getAttribute("download") || ""}`)
  );
  for (const value of downloadMetadata) {
    for (const token of worldIdForbiddenPrivateTokens) {
      expect(value, `download metadata must not contain ${token}`).not.toContain(token);
    }
  }
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

async function expectNoClippedControls(page: Page) {
  const clipped = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button, input, textarea, select, label, [role='button']"))
      .map((element) => {
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(htmlElement);
        return {
          label: htmlElement.getAttribute("aria-label") || htmlElement.textContent?.trim().slice(0, 80) || element.tagName,
          clippedX: htmlElement.scrollWidth > htmlElement.clientWidth + 2,
          clippedY: htmlElement.scrollHeight > htmlElement.clientHeight + 2,
          display: style.display,
          height: rect.height,
          visibility: style.visibility,
          width: rect.width
        };
      })
      .filter((item) => item.display !== "none" && item.visibility !== "hidden" && item.width > 0 && item.height > 0)
      .filter((item) => item.clippedX || item.clippedY)
      .slice(0, 8)
  );
  expect(clipped).toEqual([]);
}

async function expectKeyboardFocusable(locator: Locator) {
  await locator.focus();
  await expect(locator).toBeFocused();
  const box = await locator.boundingBox();
  expect(box, "focused control must have a rendered box").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(12);
}

async function archiveScreenshot(page: Page, route: string, projectName: string) {
  const viewportName = projectName.replace(/\W+/g, "-").toLowerCase();
  const targetDir = path.join(artifactRoot, viewportName);
  await mkdir(targetDir, { recursive: true });
  await page.screenshot({ fullPage: false, path: path.join(targetDir, `${route}.png`) });
}

test("review matrix covers World ID IDKit UX evidence", async () => {
  const matrix = JSON.parse(await readFile(path.join(artifactRoot, "review-matrix.json"), "utf-8")) as {
    checks: string[];
    reviewed_surfaces: string[];
    viewport_coverage: Array<{ name: string }>;
  };
  expect(matrix.reviewed_surfaces).toEqual(
    expect.arrayContaining([
      "proof-center",
      "wallet-uploads",
      "register-intake",
      "security",
      "qr-proof-review",
      "export-import"
    ])
  );
  expect(matrix.viewport_coverage.map((entry) => entry.name)).toEqual(
    expect.arrayContaining(["Desktop Chrome", "Mobile Chrome", "Mobile Safari"])
  );
  expect(matrix.checks.join(" ")).toMatch(/keyboard focus/i);
  expect(matrix.checks.join(" ")).toMatch(/emergency.*fallback/i);
  expect(matrix.checks.join(" ")).toMatch(/raw nullifier/i);
});

test("World ID status controls stay accessible, fallback-safe, and leak-free across wallet surfaces", async ({
  page
}, testInfo) => {
  const apiErrors = await installRoutes(page, { enabled: true, verified: true });
  const surfaces: Array<[string, RegExp, RegExp]> = [
    ["proof-center", /Verified wallet claims/i, /World ID wallet status/i],
    ["uploads", /Saved files and info/i, /Uploads World ID status/i],
    ["register", /Create your Abby profile/i, /Register World ID status/i],
    ["security", /Account safety/i, /Security World ID status/i]
  ];

  for (const [route, pageHeading, surfaceLabel] of surfaces) {
    await openWalletSurface(page, route, pageHeading);
    const surface = page.getByLabel(surfaceLabel);
    await expect(surface).toBeVisible();
    await expect(surface.getByText(/Verified proof-of-human/i).first()).toBeVisible();
    await expect(surface.getByText(/Emergency and essential-service flows remain available/i).first()).toBeVisible();
    await expectKeyboardFocusable(page.getByRole("button", { name: /Verify with World ID/i }).first());
    await expectNoPrivateWorldIdLeakage(page);
    await expectNoHorizontalOverflow(page);
    await expectNoClippedControls(page);
    await archiveScreenshot(page, route, testInfo.project.name);
  }

  await openWalletSurface(page, "proof-center", /Verified wallet claims/i);
  await expect(page.getByText(/This World ID proof-of-human receipt is not legal identity/i).first()).toBeVisible();
  await expect(page.getByText(/does not disclose or prove legal name, age, citizenship, address/i).first()).toBeVisible();
  expect(apiErrors).toEqual([]);
});

test("World ID unavailable intake keeps manual fallback and does not overclaim identity", async ({ page }, testInfo) => {
  const apiErrors = await installRoutes(page, { enabled: false, verified: false });
  await openWalletSurface(page, "register", /Create your Abby profile/i);

  const registerStatus = page.getByLabel(/Register World ID status/i);
  await expect(registerStatus.getByText(/World ID unavailable|World ID unverified/i).first()).toBeVisible();
  await expect(registerStatus.getByText(/Emergency and essential-service flows remain available/i).first()).toBeVisible();
  await expect(page.getByLabel(/World ID proof-of-human verified for intake/i)).not.toBeChecked();
  await expectKeyboardFocusable(page.getByLabel(/Use manual intake fallback/i));
  await page.getByLabel(/Use manual intake fallback/i).check();
  await expect(page.getByText(/Manual fallback is active for accessibility, device availability, or emergency service access/i)).toBeVisible();
  await expectNoPrivateWorldIdLeakage(page);
  await expectNoHorizontalOverflow(page);
  await expectNoClippedControls(page);
  await archiveScreenshot(page, "register-fallback", testInfo.project.name);
  expect(apiErrors).toEqual([]);
});

test("World ID QR and export reviews render only sanitized public proof metadata", async ({ page }, testInfo) => {
  const apiErrors = await installRoutes(page, { enabled: true, verified: true });
  await openWalletSurface(page, "exports", /Shareable wallet bundles/i);

  await expect(page.getByRole("heading", { name: /QR proof review/i })).toBeVisible();
  await expect(page.getByText(/World ID proof of human is bound to this wallet/i).first()).toBeVisible();
  await expect(page.getByText(/world_id_idkit_v4/i).first()).toBeVisible();
  await expect(page.getByText(/public inputs only/i).first()).toBeVisible();
  const renderedFixtures = JSON.stringify([worldIdSanitizedQrProofBundle, worldIdSanitizedExportReview], null, 2);
  for (const token of worldIdForbiddenPrivateTokens) {
    expect(renderedFixtures, `sanitized QR/export fixtures must not contain ${token}`).not.toContain(token);
  }
  await expectNoPrivateWorldIdLeakage(page);
  await expectNoHorizontalOverflow(page);
  await expectNoClippedControls(page);
  await archiveScreenshot(page, "exports", testInfo.project.name);
  expect(apiErrors).toEqual([]);
});
