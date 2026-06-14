import { devices, expect, test, type Page, type Route } from "@playwright/test";

import {
  buildProveKitWalletProofsApiResponse,
  provekitForbiddenWitnessTokens
} from "./fixtures/provekit-proof-fixtures";

const walletApiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5174}`;
const walletId = "wallet-demo";
const actorDid = "did:key:provekit-ui-reviewer";
const pixel5 = devices["Pixel 5"];
const mobileChromeUse = {
  deviceScaleFactor: pixel5.deviceScaleFactor,
  hasTouch: pixel5.hasTouch,
  isMobile: pixel5.isMobile,
  userAgent: pixel5.userAgent,
  viewport: pixel5.viewport
};

function walletRoute(route: string) {
  const query = new URLSearchParams({
    actorDid,
    walletApiBaseUrl,
    walletId
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
  await username.fill("provekit-reviewer");
  await page.getByLabel(/password/i).fill("safety-plan");
  await page.getByRole("button", { name: /log in|login|sign in|continue/i }).click();
}

async function fulfillWalletRoute(route: Route) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const method = route.request().method();

  if (method === "GET" && path.endsWith("/proofs")) {
    await route.fulfill({ json: buildProveKitWalletProofsApiResponse() });
    return;
  }
  if (path.endsWith("/world-id/config")) {
    await route.fulfill({
      json: {
        enabled: false,
        environment: "staging",
        app_id: "",
        rp_id: "",
        allowed_actions: ["wallet-attach-world-id-v1"],
        default_action: "wallet-attach-world-id-v1",
        credential_policy: "proof_of_human"
      }
    });
    return;
  }
  if (path.endsWith("/world-id/status")) {
    await route.fulfill({
      json: {
        enabled: false,
        wallet: { wallet_id: walletId, binding_count: 0, active_binding_count: 0, bindings: [] }
      }
    });
    return;
  }
  if (path.endsWith("/audit")) {
    await route.fulfill({
      json: {
        events: [
          {
            action: "proof/create",
            actor_did: actorDid,
            created_at: "2026-06-14T08:00:00.000Z",
            decision: "allow",
            grant_id: null,
            resource: `wallet://${walletId}/proofs/proof-fixture-provekit-whir`
          }
        ]
      }
    });
    return;
  }
  if (path.endsWith("/access-requests")) {
    await route.fulfill({ json: { requests: [] } });
    return;
  }
  if (path.endsWith("/grant-receipts")) {
    await route.fulfill({ json: { receipts: [] } });
    return;
  }
  if (path.endsWith("/records")) {
    await route.fulfill({ json: { records: [] } });
    return;
  }
  if (path.endsWith("/portal/saved-services")) {
    await route.fulfill({ json: { saved_services: [] } });
    return;
  }
  if (path.endsWith("/portal/plans")) {
    await route.fulfill({ json: { plans: [] } });
    return;
  }
  if (path.endsWith("/portal/interactions")) {
    await route.fulfill({ json: { interactions: [] } });
    return;
  }
  if (path.endsWith("/storage")) {
    await route.fulfill({ json: { wallet_id: walletId, ok: true, records: [] } });
    return;
  }
  if (path.endsWith("/snapshot")) {
    await route.fulfill({
      json: { wallet_id: walletId, exists: true, valid: true, format: "envelope", path: "/tmp/wallet-demo.json" }
    });
    return;
  }
  if (path === "/wallets/snapshots") {
    await route.fulfill({ json: { wallet_ids: [walletId] } });
    return;
  }
  if (path === `/wallets/${walletId}`) {
    await route.fulfill({
      json: {
        wallet_id: walletId,
        owner_did: actorDid,
        controller_dids: [actorDid],
        device_dids: [actorDid]
      }
    });
    return;
  }

  await route.fulfill({ json: {} });
}

async function installWalletRoutes(page: Page) {
  const apiErrors: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    const watched = ["/wallets", "/analytics", "/exports", "/ops"].some((prefix) => url.pathname.startsWith(prefix));
    if (response.status() >= 400 && watched) {
      apiErrors.push(`${response.status()} ${url.pathname}`);
    }
  });
  await page.route("**/wallets/**", fulfillWalletRoute);
  await page.route("**/analytics/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/templates")) {
      await route.fulfill({ json: { templates: [] } });
      return;
    }
    await route.fulfill({ json: { consents: [] } });
  });
  await page.route("**/exports/**", async (route) => route.fulfill({ json: { valid: true } }));
  await page.route("**/ops/health", async (route) => route.fulfill({ json: { status: "ok", checks: [] } }));
  return apiErrors;
}

async function openWalletSurface(page: Page, route: string, heading: RegExp) {
  await page.goto(walletRoute(route));
  await signInIfNeeded(page);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
}

async function expectNoProofLeakage(page: Page) {
  const body = await page.locator("body").innerText();
  for (const token of provekitForbiddenWitnessTokens) {
    expect(body, `visible UI must not contain ${token}`).not.toContain(token);
  }
  expect(body).not.toMatch(/raw witness|proves legal identity|guarantees eligibility|guaranteed benefits/i);
  const downloadMetadata = await page.locator("a[download]").evaluateAll((links) =>
    links.map((link) =>
      [
        link.textContent || "",
        link.getAttribute("href") || "",
        link.getAttribute("download") || ""
      ].join(" ")
    )
  );
  for (const value of downloadMetadata) {
    for (const token of provekitForbiddenWitnessTokens) {
      expect(value, `download metadata must not contain ${token}`).not.toContain(token);
    }
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const offenders = await page.evaluate(() => {
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
          tagName: element.tagName,
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
  expect(offenders).toEqual([]);
}

async function expectProofStateLabels(page: Page) {
  await expect(page.getByText("Simulated proof, demo-only").first()).toBeVisible();
  await expect(page.getByText("Groth16 BN254").first()).toBeVisible();
  await expect(page.getByText("ProveKit WHIR").first()).toBeVisible();
  await expect(page.getByText("ProveKit recursive Groth16 wrapper").first()).toBeVisible();
  await expect(page.getByText("ProveKit artifact hash mismatch").first()).toBeVisible();
  await expect(page.getByText("Stale ProveKit verifier key").first()).toBeVisible();
  await expect(page.getByText("ProveKit backend unavailable").first()).toBeVisible();
  await expect(page.getByText("ProveKit verification failed").first()).toBeVisible();
  await expect(page.getByText("Not on-chain ready without recursive wrapper").first()).toBeVisible();
  await expect(page.getByText("Recursive Groth16 wrapper evidence only").first()).toBeVisible();
}

async function expectCoreProofStateLabels(page: Page) {
  await expect(page.getByText("Simulated proof, demo-only").first()).toBeVisible();
  await expect(page.getByText("Groth16 BN254").first()).toBeVisible();
  await expect(page.getByText("ProveKit WHIR").first()).toBeVisible();
  await expect(page.getByText("ProveKit recursive Groth16 wrapper").first()).toBeVisible();
  await expect(page.getByText("Not on-chain ready without recursive wrapper").first()).toBeVisible();
  await expect(page.getByText("Recursive Groth16 wrapper evidence only").first()).toBeVisible();
}

async function expectProofControlsAreUsable(page: Page) {
  const locationInput = page.getByLabel(/Location record ID/i);
  const regionInput = page.getByLabel(/Region ID/i);
  const createProof = page.getByRole("button", { name: /^Create proof$/i });
  await locationInput.focus();
  await expect(locationInput).toBeFocused();
  await regionInput.focus();
  await expect(regionInput).toBeFocused();
  await createProof.focus();
  await expect(createProof).toBeFocused();
  const controlBoxes = await Promise.all([
    locationInput.boundingBox(),
    regionInput.boundingBox(),
    createProof.boundingBox()
  ]);
  for (const box of controlBoxes) {
    expect(box, "reviewed proof control must have a rendered box").not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(32);
  }
}

test("proof center distinguishes ProveKit proof states without leakage", async ({ page }) => {
  const apiErrors = await installWalletRoutes(page);
  await openWalletSurface(page, "proof-center", /Verified wallet claims/i);
  await expect(page.getByRole("heading", { name: /World ID verification/i })).toBeVisible();
  await expectProofStateLabels(page);
  await expectProofControlsAreUsable(page);
  await expectNoProofLeakage(page);
  await expectNoHorizontalOverflow(page);
  expect(apiErrors).toEqual([]);
});

test("ProveKit proof summaries stay clear across wallet surfaces", async ({ page }) => {
  const apiErrors = await installWalletRoutes(page);
  const surfaces: Array<[string, RegExp, RegExp]> = [
    ["uploads", /Saved files and info/i, /Wallet proof receipts/i],
    ["social-services", /Find support/i, /Provider proof review/i],
    ["analytics", /Share group facts, not your name/i, /Public proof dashboard/i],
    ["exports", /Shareable wallet bundles/i, /QR proof review/i],
    ["security", /Account safety/i, /Proof security review/i],
    ["audit", /Consent and access history/i, /Proof audit coverage/i]
  ];

  for (const [route, pageHeading, summaryHeading] of surfaces) {
    await openWalletSurface(page, route, pageHeading);
    await expect(page.getByRole("heading", { name: summaryHeading })).toBeVisible();
    await expectCoreProofStateLabels(page);
    await expectNoProofLeakage(page);
    await expectNoHorizontalOverflow(page);
  }
  expect(apiErrors).toEqual([]);
});

test.describe("Mobile Chrome ProveKit proof ergonomics", () => {
  test.use(mobileChromeUse);

  test("proof center controls remain usable in a Chromium mobile viewport", async ({ browserName, page }) => {
    test.skip(browserName !== "chromium", "Mobile Chrome viewport coverage runs on the Chromium project.");
    const apiErrors = await installWalletRoutes(page);
    await openWalletSurface(page, "proof-center", /Verified wallet claims/i);
    await expectProofControlsAreUsable(page);
    await expectProofStateLabels(page);
    await expectNoProofLeakage(page);
    await expectNoHorizontalOverflow(page);
    expect(apiErrors).toEqual([]);
  });
});
