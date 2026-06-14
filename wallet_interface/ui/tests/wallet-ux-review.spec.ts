import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildProveKitWalletProofsApiResponse,
  provekitForbiddenWitnessTokens
} from "./fixtures/provekit-proof-fixtures";

const walletApiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5174}`;
const walletId = "wallet-demo";
const actorDid = "did:key:wallet-ux-reviewer";
const repoRoot = path.resolve(process.cwd(), "../..");

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
  await username.fill("wallet-reviewer");
  await page.getByLabel(/password/i).fill("safety-plan");
  await page.getByRole("button", { name: /log in|login|sign in|continue/i }).click();
}

async function fulfillWalletRoute(route: Route) {
  const url = new URL(route.request().url());
  const pathName = url.pathname;
  if (pathName.endsWith("/proofs")) {
    await route.fulfill({ json: buildProveKitWalletProofsApiResponse() });
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
    await route.fulfill({ json: { records: [] } });
    return;
  }
  if (pathName.endsWith("/audit")) {
    await route.fulfill({ json: { events: [] } });
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
  if (pathName.endsWith("/storage")) {
    await route.fulfill({ json: { ok: true, records: [] } });
    return;
  }
  if (pathName === "/wallets/snapshots") {
    await route.fulfill({ json: { wallet_ids: [walletId] } });
    return;
  }
  if (pathName.endsWith("/snapshot")) {
    await route.fulfill({ json: { wallet_id: walletId, exists: true, valid: true, format: "envelope" } });
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
  expect(overflow).toEqual([]);
}

async function expectNoLeakage(page: Page) {
  const body = await page.locator("body").innerText();
  for (const token of provekitForbiddenWitnessTokens) {
    expect(body).not.toContain(token);
  }
  const downloadValues = await page.locator("a[download]").evaluateAll((links) =>
    links.map((link) => `${link.textContent || ""} ${link.getAttribute("href") || ""} ${link.getAttribute("download") || ""}`)
  );
  for (const value of downloadValues) {
    for (const token of provekitForbiddenWitnessTokens) {
      expect(value).not.toContain(token);
    }
  }
}

test("review artifact covers required ProveKit UX surfaces and viewports", async () => {
  const matrixPath = path.join(repoRoot, "artifacts/provekit-ui-review/review-matrix.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf-8")) as {
    checks: string[];
    reviewed_surfaces: string[];
    viewport_coverage: Array<{ name: string }>;
  };
  expect(matrix.reviewed_surfaces).toEqual(
    expect.arrayContaining([
      "proof-center",
      "wallet-uploads",
      "provider-proofs",
      "public-analytics",
      "export-import",
      "security-audit",
      "audit-history"
    ])
  );
  expect(matrix.viewport_coverage.map((entry) => entry.name)).toEqual(
    expect.arrayContaining(["Desktop Chrome", "Mobile Chrome", "Mobile Safari"])
  );
  expect(matrix.checks.join(" ")).toMatch(/keyboard focus/i);
  expect(matrix.checks.join(" ")).toMatch(/private witness/i);
});

test("review artifact covers required Chainlink consensus UX surfaces and viewports", async () => {
  const matrixPath = path.join(repoRoot, "artifacts/chainlink-zkml-ui-review/review-matrix.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf-8")) as {
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

test("review artifact covers required World ID UX surfaces and viewports", async () => {
  const matrixPath = path.join(repoRoot, "artifacts/world-id-idkit-ui-review/review-matrix.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf-8")) as {
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

test("wallet proof review surfaces are scannable and do not expose private proof material", async ({ page }, testInfo) => {
  await installRoutes(page);
  const routes: Array<[string, RegExp, RegExp]> = [
    ["uploads", /Saved files and info/i, /Wallet proof receipts/i],
    ["exports", /Shareable wallet bundles/i, /QR proof review/i],
    ["security", /Account safety/i, /Proof security review/i]
  ];

  for (const [route, heading, proofSummary] of routes) {
    await openRoute(page, route, heading);
    await expect(page.getByRole("heading", { name: proofSummary })).toBeVisible();
    await expect(page.getByText("ProveKit WHIR").first()).toBeVisible();
    await expectNoLeakage(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`provekit-${route}-${testInfo.project.name.replace(/\W+/g, "-").toLowerCase()}.png`)
    });
  }
});
