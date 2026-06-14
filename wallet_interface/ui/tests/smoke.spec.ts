import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  buildProveKitWalletProofsApiResponse,
  provekitForbiddenWitnessTokens
} from "./fixtures/provekit-proof-fixtures";
import {
  chainlinkConsensusFixturesById,
  SANITIZER_SENTINEL_STRINGS
} from "./fixtures/chainlink-consensus-fixtures";

const walletApiBaseUrl = encodeURIComponent(`http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5174}`);

function walletRoute(route: string, actorDid: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({
    walletApiBaseUrl: decodeURIComponent(walletApiBaseUrl),
    walletId: "wallet-demo",
    actorDid,
    ...params
  });
  return `/?${query.toString()}#/${route}`;
}

function fixtureConsensus(id: keyof typeof chainlinkConsensusFixturesById) {
  const fixture = chainlinkConsensusFixturesById[id];
  const response = fixture.response as Record<string, unknown> | undefined;
  const output = response?.output as Record<string, unknown> | undefined;
  const apiError = fixture.apiError as Record<string, unknown> | undefined;
  const detail = apiError?.detail as Record<string, unknown> | undefined;
  return response?.consensus ?? output?.consensus ?? detail?.consensus;
}

function consensusProofRecord({
  claim,
  consensus,
  id,
  proofSystem,
  status = "verified",
  type
}: {
  claim: string;
  consensus?: unknown;
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
      claim_hash: `sha256:${id}-public-claim`
    },
    proof_hash: `sha256:${id}-proof-hash`,
    witness_record_ids: ["rec-benefits-letter"],
    is_simulated: false,
    proof_system: proofSystem,
    circuit_id: `${type}-circuit-v1`,
    verifier_digest: `sha256:${id}-verifier-digest`,
    proof_artifact_ref: `proof://${id}`,
    verification_status: status,
    created_at: "2026-06-14T12:00:00Z",
    ...(consensus ? { consensus } : {})
  };
}

async function expectLoginForm(page: Page) {
  await expect(page.getByLabel(/username/i)).toBeVisible({ timeout: 10000 });
  await expect(page.getByLabel(/password/i)).toBeVisible();
}

async function signInIfNeeded(page: Page) {
  const username = page.getByLabel(/username/i).first();

  try {
    await username.waitFor({ state: "visible", timeout: 1000 });
  } catch {
    return false;
  }

  await username.fill("abby");
  await page.getByLabel(/password/i).fill("safety-plan");
  await page.getByRole("button", { name: /log in|login|sign in|continue/i }).click();
  return true;
}

async function openAppRoute(page: Page, route: string) {
  await page.goto("/");
  const signedIn = await signInIfNeeded(page);

  if (signedIn && route !== "/") {
    await page.goto(route);
    await signInIfNeeded(page);
    return;
  }

  if (route !== "/") {
    await page.goto(route);
    await signInIfNeeded(page);
  }
}

function buildWorldIdHumanProofsResponse() {
  return {
    proofs: [
      {
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
          credential_policy: "proof_of_human"
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
      }
    ]
  };
}

async function fulfillWorldIdSurfaceWalletRoute(route: Route, options: { verified: boolean }) {
  const url = new URL(route.request().url());
  const path = url.pathname;

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
        verified: options.verified,
        binding_id: options.verified ? "world-id-binding-demo" : null,
        proof_id: options.verified ? "proof-world-id-human" : null,
        verified_at: options.verified ? "2026-06-14T16:00:00Z" : null,
        action: "wallet-attach-world-id-v1",
        credential_policy: "proof_of_human",
        active_binding_count: options.verified ? 1 : 0
      }
    });
    return;
  }
  if (path.endsWith("/proofs")) {
    await route.fulfill({ json: options.verified ? buildWorldIdHumanProofsResponse() : { proofs: [] } });
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
  if (path.endsWith("/audit")) {
    await route.fulfill({ json: { events: [] } });
    return;
  }
  if (path === "/wallets/snapshots") {
    await route.fulfill({ json: { wallet_ids: [] } });
    return;
  }
  await route.fulfill({ status: 404, json: { error: "unexpected wallet API call", path } });
}

async function expectFirstAboveSecond(first: Locator, second: Locator) {
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  expect(firstBox, "expected first element to have a layout box").not.toBeNull();
  expect(secondBox, "expected second element to have a layout box").not.toBeNull();
  expect(firstBox!.y).toBeLessThan(secondBox!.y);
}

test("login page appears before the home screen", async ({ page }) => {
  await page.goto("/");
  await expectLoginForm(page);
  await signInIfNeeded(page);
  await expect(page.getByRole("heading", { name: /Welcome to your safety plan!/i })).toBeVisible({ timeout: 10000 });
});

test("mobile home exposes the safety plan heading and quick check-in action", async ({ page }) => {
  await openAppRoute(page, "/");
  await expect(page.getByRole("heading", { name: /Welcome to your safety plan!/i })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".home-actions")).toBeVisible();
  const quickCheckIn = page.locator(".checkin-panel");
  const checkInNowIsLargest = await quickCheckIn.evaluate((panel) => {
    const cta = panel.querySelector(".checkin-panel-cta");
    const label = panel.querySelector(".checkin-panel-label");
    const value = panel.querySelector(".checkin-panel-value");
    if (!cta || !label || !value) return false;
    const ctaSize = parseFloat(window.getComputedStyle(cta).fontSize);
    const labelSize = parseFloat(window.getComputedStyle(label).fontSize);
    const valueSize = parseFloat(window.getComputedStyle(value).fontSize);
    return ctaSize > labelSize && ctaSize > valueSize;
  });
  expect(checkInNowIsLargest).toBe(true);
  await quickCheckIn.click();
  await expect(page.getByRole("heading", { name: /Set your schedule/i })).toBeVisible();
});

test("registration enforces minimum required profile fields", async ({ page }) => {
  await openAppRoute(page, "/#/register");
  await expect(page.getByRole("heading", { name: /Create your Abby profile/i })).toBeVisible({ timeout: 10000 });
  await expect(page.getByLabel(/Legal or full name/i)).toBeVisible();
  await expect(page.getByLabel(/Birth date/i)).toBeVisible();
  const photoOrPhotoId = page.getByLabel(/Photo or photo ID/i);
  await expect(photoOrPhotoId).toBeVisible();
  await expect(photoOrPhotoId).toHaveAttribute("accept", /pdf/i);
  expect(await photoOrPhotoId.getAttribute("capture")).toBeNull();
  await expect(page.getByPlaceholder(/call me she\/her, he\/him, they\/them/i)).toBeVisible();
  await expect(page.getByText("Used for text reminders.", { exact: true })).toBeVisible();
  await expect(page.getByText("Used for email reminders.", { exact: true })).toBeVisible();
  const helperStyles = await page
    .locator(".field")
    .filter({ hasText: /Used for (text|email) reminders/ })
    .evaluateAll((fields) =>
      fields.map((field) => {
        const title = field.querySelector(".field-title");
        const helper = field.querySelector(".field-help-text");
        if (!title || !helper) return false;
        const titleSize = parseFloat(window.getComputedStyle(title).fontSize);
        const helperSize = parseFloat(window.getComputedStyle(helper).fontSize);
        return helperSize >= 15 && helperSize < titleSize;
      })
    );
  expect(helperStyles).toEqual([true, true]);
  await photoOrPhotoId.setInputFiles({
    name: "id-card.gif",
    mimeType: "image/gif",
    buffer: Buffer.from("not accepted")
  });
  await expect(page.getByText(/We can't use this file/i)).toBeVisible();
  await expect(page.getByText(/Selected file: id-card\.gif/i)).toHaveCount(0);
  await page.waitForFunction(() => {
    const state = JSON.parse(window.localStorage.getItem("abby-ui-state-v1") ?? "{}");
    return state.profile?.photoAssetId === "";
  });
  await photoOrPhotoId.setInputFiles({
    name: "id-card.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n")
  });
  await expect(page.getByText(/Selected file: id-card\.pdf \(PDF\)/i)).toBeVisible();
  await photoOrPhotoId.setInputFiles({
    name: "id-card.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("jpeg")
  });
  await expect(page.getByText(/Selected file: id-card\.jpg \(JPG\)/i)).toBeVisible();
  await expect(page.locator(".photo-preview-card, .photo-preview-toggle")).toHaveCount(0);
  await expect(page.locator(".field").filter({ hasText: "Photo or photo ID" }).locator("img, object, embed, canvas")).toHaveCount(0);
  await expect(page.getByLabel(/Bot check complete/i)).toBeDisabled();
  await page.getByLabel(/Legal or full name/i).fill("Abby Example");
  await page.getByLabel(/Birth date/i).fill("1990-01-01");
  await page.getByLabel(/Quick health check complete/i).check();
  await expect(page.getByLabel(/Bot check complete/i)).toBeEnabled();
  await page.getByLabel(/Bot check complete/i).check();
  await expect(page.getByLabel(/Bot check complete/i)).toBeChecked();
});

test("registration intake uses World ID proof-of-human before the demo bot check", async ({ page }) => {
  await page.route("**/wallets/**", (route) => fulfillWorldIdSurfaceWalletRoute(route, { verified: true }));

  await openAppRoute(page, walletRoute("register", "did:key:owner"));
  await expect(page.getByRole("heading", { name: /Create your Abby profile/i })).toBeVisible({ timeout: 10000 });

  await expect(page.getByLabel(/World ID proof-of-human verified for intake/i)).toBeChecked();
  await expect(page.getByLabel(/Use manual intake fallback/i)).toBeDisabled();
  await expect(page.getByLabel(/Bot check complete/i)).toBeDisabled();
  await expect(page.getByLabel(/Client intake verification status/i)).toContainText(
    /World ID proof-of-human satisfies intake without the demo bot check/i
  );
});

test("registration intake keeps manual fallback available when World ID is unavailable", async ({ page }) => {
  await page.route("**/wallets/**", (route) => fulfillWorldIdSurfaceWalletRoute(route, { verified: false }));

  await openAppRoute(page, walletRoute("register", "did:key:owner"));
  await expect(page.getByRole("heading", { name: /Create your Abby profile/i })).toBeVisible({ timeout: 10000 });

  await expect(page.getByLabel(/World ID proof-of-human verified for intake/i)).not.toBeChecked();
  await page.getByLabel(/Use manual intake fallback/i).check();
  await expect(page.getByLabel(/Use manual intake fallback/i)).toBeChecked();
  await expect(page.getByLabel(/Bot check complete/i)).toBeDisabled();
  await expect(page.getByLabel(/Client intake verification status/i)).toContainText(
    /Manual fallback is active for accessibility, device availability, or emergency service access/i
  );
});

test("check-in interval cannot exceed thirty days", async ({ page }) => {
  await openAppRoute(page, "/#/check-in");
  await expect(page.getByRole("heading", { name: /Set your schedule/i })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("button", { name: /Texting allowed/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Email allowed/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Web allowed/i })).toBeVisible();
  await expect(page.getByText(/check in by text, email, or web/i)).toBeVisible();
  const interval = page.getByLabel(/Days between check-ins/i);
  await interval.fill("45");
  await expect(interval).toHaveValue("30");
  await page.getByRole("button", { name: /Check in by text/i }).click();
  await expect(page.getByText(/Add a phone number/i)).toBeVisible();
  await page.getByRole("button", { name: /Email allowed/i }).click();
  await page.getByRole("button", { name: /Check in by email/i }).click();
  await expect(page.getByText(/Add an email/i)).toBeVisible();
  await page.getByRole("button", { name: /Check in by web/i }).click();
  await expect(page.getByText(/Checked in by web/i)).toBeVisible();
  await page.getByRole("button", { name: /Web allowed/i }).click();
  await page.getByRole("button", { name: /Check in by web/i }).click();
  await expect(page.getByText(/Web check-in is off/i)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /Set your schedule/i })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("button", { name: /Web allowed/i })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: /Texting allowed/i }).click();
  await page.getByRole("button", { name: /Email allowed/i }).click();
  await expect(page.getByText(/No check-in method is on/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Check in by text \(off\)/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Check in by email \(off\)/i })).toBeVisible();
  await page.getByRole("button", { name: /Texting allowed/i }).click();
  await page.getByRole("button", { name: /Email allowed/i }).click();

  await openAppRoute(page, "/#/register");
  await page.getByLabel(/Phone/i).fill("(503) 555-0199");
  await page.getByLabel(/Email/i).fill("abby-checkin@example.org");
  await openAppRoute(page, "/#/check-in");
  await expect(page.getByRole("heading", { name: /Set your schedule/i })).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: /Check in by text/i }).click();
  await expect(page.getByText(/Checked in by text/i)).toBeVisible();
  await page.getByRole("button", { name: /Check in by email/i }).click();
  await expect(page.getByText(/Checked in by email/i)).toBeVisible();
});

test("hash navigation updates the active screen without a full reload", async ({ page }) => {
  await openAppRoute(page, "/");
  await expect(page.getByRole("heading", { name: /Welcome to your safety plan!/i })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "#/contacts";
  });
  await expect(page.getByRole("heading", { name: /People who can help/i })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "#/analytics";
  });
  await expect(page.getByRole("heading", { name: /Share group facts/i })).toBeVisible();
});

test("mobile menu opens navigation and routes to contacts", async ({ page }, testInfo) => {
  test.skip(!/Mobile/i.test(testInfo.project.name), "Mobile navigation is hidden on desktop layouts");
  await openAppRoute(page, "/");
  await page.getByRole("button", { name: /Open menu/i }).click();
  const mobileNav = page.getByRole("navigation", { name: /Mobile navigation/i });
  await expect(mobileNav).toBeVisible();
  await mobileNav.getByRole("button", { name: /Contacts/i }).click();
  await expect(page.getByRole("heading", { name: /People who can help/i })).toBeVisible();
  await expect(mobileNav).not.toBeVisible();
});

test("analytics consent shows privacy controls and safe details", async ({ page }) => {
  await openAppRoute(page, "/#/analytics");
  await expect(page.getByRole("heading", { name: /Share group facts/i })).toBeVisible();
  const housingStudy = page.getByRole("article", { name: /Housing service gaps/i });
  await expect(housingStudy.getByLabel(/Allow this choice/i)).toBeChecked();
  await expect(housingStudy.locator(".privacy-metrics").getByText(/Group size/i)).toBeVisible();
  await expect(housingStudy.locator(".privacy-metrics").getByText(/Privacy left/i)).toBeVisible();
  await expect(housingStudy.getByText("county", { exact: true })).toBeVisible();
  await expect(housingStudy.getByText("need type", { exact: true })).toBeVisible();
  await expect(housingStudy.getByText("need_category", { exact: true })).toHaveCount(0);
  const preview = housingStudy.getByLabel(/Housing service gaps analytics capability preview/i);
  await expect(preview.getByText(/share group facts/i)).toBeVisible();
  await expect(preview.getByText(/open file contents/i)).toBeVisible();
  await expect(preview.getByText(/ask group questions/i)).toBeVisible();
});

test("analytics consent preserves opt-out after refresh", async ({ page }) => {
  await openAppRoute(page, "/#/analytics");
  const housingStudy = page.getByRole("article", { name: /Housing service gaps/i });
  const studyOptIn = housingStudy.getByLabel(/Allow this choice/i);
  await studyOptIn.uncheck();
  await expect(studyOptIn).not.toBeChecked();
  await page.reload();
  const reloadedStudy = page.getByRole("article", { name: /Housing service gaps/i });
  await expect(reloadedStudy.getByLabel(/Allow this choice/i)).not.toBeChecked();
});

test("removed standalone sharing, benefits, and recipient routes fall back home", async ({ page }) => {
  for (const route of ["/#/sharing-rules", "/#/benefits-protection", "/#/recipient-access"]) {
    await openAppRoute(page, route);
    await expect(page.getByRole("heading", { name: /Welcome to your safety plan!/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: /Benefits notice|Requests to see my info/i })).toHaveCount(0);
  }
});

test("contacts add flow saves sharing choices and opens edit panel by keyboard", async ({ page }) => {
  await openAppRoute(page, "/#/contacts");
  await expect(page.getByRole("heading", { name: /People who can help/i })).toBeVisible({ timeout: 10000 });
  const addPersonSection = page.locator('section[aria-labelledby="Add-person"]');
  await expectFirstAboveSecond(
    addPersonSection.getByLabel(/Type/i),
    addPersonSection.getByText(/Sharing choices for this person/i)
  );
  await addPersonSection.getByLabel(/Name or group/i).fill("Morgan Caseworker");
  await addPersonSection.getByLabel(/Relationship or role/i).fill("Outreach case worker");
  await addPersonSection.getByLabel("Phone", { exact: true }).fill("(503) 555-0188");
  await addPersonSection.getByLabel("Email", { exact: true }).fill("morgan@example.org");
  await addPersonSection.getByLabel(/Type/i).selectOption("social_worker");
  await addPersonSection.getByLabel(/Medical notes/i).uncheck();
  await addPersonSection.getByLabel(/Found permanent housing/i).uncheck();
  await addPersonSection.getByRole("button", { name: /^Add person$/i }).click();

  const savedContacts = page.locator('section[aria-labelledby="Saved-contacts"]');
  const savedMorgan = savedContacts.locator(".recipient-list-item").filter({ hasText: "Morgan Caseworker" });
  await expect(savedMorgan.getByText("9 items", { exact: true })).toBeVisible();
  await savedMorgan.locator(".recipient-open-button").focus();
  await page.keyboard.press("Enter");
  const editPanel = savedMorgan.getByRole("region", { name: /Edit sharing for Morgan Caseworker/i });
  await expect(editPanel).toBeVisible();
  await expect(editPanel.getByLabel(/Minimum identity/i)).toBeChecked();
  await expect(editPanel.getByLabel(/Medical notes/i)).not.toBeChecked();
  await expect(editPanel.getByLabel(/Found permanent housing/i)).not.toBeChecked();
  await editPanel.getByLabel(/Benefits information/i).uncheck();
  await editPanel.getByRole("button", { name: /Save sharing/i }).click();

  await page.reload();
  const reloadedMorgan = page.locator('section[aria-labelledby="Saved-contacts"] .recipient-list-item').filter({
    hasText: "Morgan Caseworker"
  });
  await expect(reloadedMorgan.getByText("8 items", { exact: true })).toBeVisible();
  await reloadedMorgan.locator(".recipient-open-button").focus();
  await page.keyboard.press("Space");
  const reloadedPanel = reloadedMorgan.getByRole("region", { name: /Edit sharing for Morgan Caseworker/i });
  await expect(reloadedPanel.getByLabel(/Benefits information/i)).not.toBeChecked();
});

test("contact list shelter nudge requires user approval before adding contact", async ({ page }) => {
  await openAppRoute(page, "/#/contacts");
  const addShelterSection = page.locator('section[aria-labelledby="Add-shelter-or-group"]');
  const addPersonSection = page.locator('section[aria-labelledby="Add-person"]');
  const savedContacts = page.locator('section[aria-labelledby="Saved-contacts"]');
  await expect(addShelterSection).toBeVisible();
  await expect(savedContacts.locator(".recipient-list-item").filter({ hasText: "Maya Johnson" })).toBeVisible();
  await expect(addPersonSection.locator(".centered-action").getByRole("button", { name: /^Add person$/i })).toBeVisible();
  expect(await addPersonSection.locator(".centered-action").evaluate((node) => getComputedStyle(node).justifyContent)).toBe("center");
  await expect(addPersonSection.locator('option[value="benefits_agency"]')).toHaveText("Benefits agency");
  await expect(addPersonSection.getByLabel(/Minimum identity/i)).toBeChecked();
  await expect(addPersonSection.getByText("name, birthdate and contact status").first()).toBeVisible();
  const nudge = page.locator(".access-request-item").filter({ hasText: "Downtown Outreach Shelter" });
  await expect(nudge.getByText(/asked to be added to your contacts/i)).toBeVisible();
  await expect(nudge.getByRole("button", { name: /^Approve$/i })).toBeVisible();
  await expect(nudge.getByRole("button", { name: /^Deny$/i })).toBeVisible();
  await nudge.getByRole("button", { name: /^Approve$/i }).click();
  await expect(page.locator(".recipient-list-item").filter({ hasText: "Downtown Outreach Shelter" })).toBeVisible();
  const shelterRules = page.locator(".recipient-list-item").filter({ hasText: "Downtown Outreach Shelter" });
  await expect(shelterRules.getByText("1 items", { exact: true })).toBeVisible();
  await shelterRules.getByRole("button", { name: /^Edit sharing$/i }).click();
  const shelterPanel = shelterRules.getByRole("region", { name: /Edit sharing for Downtown Outreach Shelter/i });
  await expect(shelterPanel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(shelterPanel.getByLabel(/Minimum identity/i)).toBeChecked();
  await expect(shelterPanel.getByLabel(/Profile/i)).not.toBeChecked();
});

test("user can request a shelter contact and shelter staff can approve it", async ({ page }) => {
  await openAppRoute(page, "/#/contacts");
  await expect(page.getByRole("heading", { name: /People who can help/i })).toBeVisible({ timeout: 10000 });
  const shelterRequests = page.locator('section[aria-labelledby="Add-shelter-or-group"]');
  await expect(shelterRequests.getByRole("button", { name: /Ask to add shelter/i })).toBeDisabled();
  await expect(shelterRequests.getByText(/already waiting/i)).toBeVisible();
  await shelterRequests.locator("select").selectOption("Downtown Outreach Shelter");
  await expect(shelterRequests.getByRole("button", { name: /Ask to add shelter/i })).toBeDisabled();
  await shelterRequests.locator("select").selectOption("Harbor Night Shelter");
  await expect(shelterRequests.getByRole("button", { name: /Ask to add shelter/i })).toBeEnabled();
  await shelterRequests.getByRole("button", { name: /Ask to add shelter/i }).click();
  await expect(page.locator(".list-item").filter({ hasText: "Harbor Night Shelter" }).getByText(/pending/i)).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/shelter";
  });
  await page.getByLabel("Shelter").first().selectOption("Harbor Night Shelter");
  await page.getByLabel(/Verified staff operator/i).selectOption({ label: "Riley Chen" });
  const request = page.locator(".access-request-item").filter({ hasText: "Harbor Night Shelter" }).filter({ hasText: "User asked" });
  await request.getByRole("button", { name: /^Approve$/i }).click();
  await expect(request.getByText(/approved/i)).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "#/contacts";
  });
  await expect(page.locator(".recipient-list-item").filter({ hasText: "Harbor Night Shelter" })).toBeVisible();
});

test("user can cancel a pending shelter contact request", async ({ page }) => {
  await openAppRoute(page, "/#/contacts");
  const shelterRequests = page.locator('section[aria-labelledby="Add-shelter-or-group"]');
  await shelterRequests.locator("select").selectOption("Harbor Night Shelter");
  await shelterRequests.getByRole("button", { name: /Ask to add shelter/i }).click();
  const request = page.locator(".list-item").filter({ hasText: "Harbor Night Shelter" }).filter({ hasText: "You asked this shelter." });
  await expect(request.getByText(/pending/i)).toBeVisible();
  await expect(shelterRequests.getByRole("button", { name: /Ask to add shelter/i })).toBeDisabled();
  await request.getByRole("button", { name: /^Cancel$/i }).click();
  await expect(request.getByText(/canceled/i)).toBeVisible();
  await expect(shelterRequests.getByRole("button", { name: /Ask to add shelter/i })).toBeEnabled();
});

test("verified shelter staff can send a contact-list nudge", async ({ page }) => {
  await openAppRoute(page, "/#/shelter");
  await page.getByLabel("Shelter").first().selectOption("Rose City Shelter");
  await page.getByLabel(/Verified staff operator/i).selectOption({ label: "Avery Patel" });
  await expect(page.getByRole("button", { name: /Send contact request/i })).toBeDisabled();
  await expect(page.getByText(/already waiting/i)).toBeVisible();
  const createUser = page.locator('section[aria-labelledby="Create-user-account"]');
  await expect(createUser.getByPlaceholder(/call me she\/her, he\/him, they\/them/i)).toBeVisible();
  await expect(createUser.getByText("Used for text reminders.", { exact: true })).toBeVisible();
  await expect(createUser.getByText("Used for email reminders.", { exact: true })).toBeVisible();
  const staffHelperStyles = await createUser
    .locator(".field")
    .filter({ hasText: /Used for (text|email) reminders/ })
    .evaluateAll((fields) =>
      fields.map((field) => {
        const title = field.querySelector(".field-title");
        const helper = field.querySelector(".field-help-text");
        if (!title || !helper) return false;
        const titleSize = parseFloat(window.getComputedStyle(title).fontSize);
        const helperSize = parseFloat(window.getComputedStyle(helper).fontSize);
        return helperSize >= 15 && helperSize < titleSize;
      })
    );
  expect(staffHelperStyles).toEqual([true, true]);
  const staffPhotoOrPhotoId = createUser.getByLabel(/Photo or photo ID/i);
  await expect(staffPhotoOrPhotoId).toHaveAttribute("accept", /pdf/i);
  expect(await staffPhotoOrPhotoId.getAttribute("capture")).toBeNull();
  await staffPhotoOrPhotoId.setInputFiles({
    name: "client-id.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not accepted")
  });
  await expect(createUser.getByText(/We can't use this file/i)).toBeVisible();
  await expect(createUser.getByText(/Selected file: client-id\.txt/i)).toHaveCount(0);
  await staffPhotoOrPhotoId.setInputFiles({
    name: "client-id.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n")
  });
  await expect(createUser.getByText(/Selected file: client-id\.pdf \(PDF\)/i)).toBeVisible();
  await expect(createUser.locator("img, object, embed, canvas")).toHaveCount(0);
  await page.getByLabel(/Person name/i).fill("Casey Example");
  await page.getByLabel(/Phone or email/i).fill("casey@example.org");
  await page.getByRole("button", { name: /Send contact request/i }).click();
  const nudge = page.locator(".access-request-item").filter({ hasText: "Casey Example" });
  await expect(nudge.getByText(/Shelter asked this user/i)).toBeVisible();
  await expect(nudge.getByText(/pending/i)).toBeVisible();
});

test("provider-assisted intake can create a client from World ID verification without the demo bot check", async ({ page }) => {
  await page.route("**/wallets/**", (route) => fulfillWorldIdSurfaceWalletRoute(route, { verified: true }));

  await openAppRoute(page, walletRoute("shelter", "did:key:owner"));
  await page.getByLabel("Shelter").first().selectOption("Rose City Shelter");
  await page.getByLabel(/Verified staff operator/i).selectOption({ label: "Avery Patel" });

  const createUser = page.locator('section[aria-labelledby="Create-user-account"]');
  await expect(createUser.getByLabel(/World ID proof-of-human verified for assisted intake/i)).toBeChecked();
  await expect(createUser.getByLabel(/Bot check complete/i)).toBeDisabled();
  await expect(createUser.getByLabel(/Assisted intake verification status/i)).toContainText(
    /World ID proof-of-human satisfies intake without the demo bot check/i
  );

  await createUser.getByLabel(/Legal or full name/i).fill("World ID Client");
  await createUser.getByLabel(/Photo or photo ID/i).setInputFiles({
    name: "world-id-client.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n")
  });
  await expect(createUser.getByRole("button", { name: /Create user account/i })).toBeEnabled();
  await createUser.getByRole("button", { name: /Create user account/i }).click();

  const createdUser = page.locator(".list-item").filter({ hasText: "World ID Client" }).first();
  await expect(createdUser).toBeVisible();
  await expect(createdUser.getByText(/Demo bot check|Manual fallback/i)).toHaveCount(0);
});

test("provider staff verification uses a separate World ID action after admin policy checks", async ({ page }) => {
  await openAppRoute(page, "/#/shelter");
  await page.getByLabel("Shelter").first().selectOption("Rose City Shelter");
  await page.getByLabel(/Verified staff operator/i).selectOption({ label: "Avery Patel" });

  const createStaff = page.locator('section[aria-labelledby="Create-staff-account"]');
  await createStaff.getByLabel(/Staff name/i).fill("Morgan Staff");
  await createStaff.getByLabel(/Staff email/i).fill("morgan@rose.example");
  await createStaff.getByRole("button", { name: /Create staff account/i }).click();

  await page.getByLabel(/I am shelter administrator/i).check();
  await page
    .getByRole("region", { name: /Shelter administrator/i })
    .getByRole("combobox", { name: /^Shelter/ })
    .selectOption("Rose City Shelter");
  const staffCard = page.locator(".list-item").filter({ hasText: "Morgan Staff" }).first();
  await expect(staffCard.getByText(/Revoked/i)).toBeVisible();
  await expect(staffCard.getByText(/provider-staff-world-id-v1/i)).toBeVisible();

  await staffCard.getByRole("button", { name: /Verify with provider staff World ID/i }).click();
  await expect(staffCard.getByText(/Verified/i)).toBeVisible();
  await expect(staffCard.getByText(/World ID staff proof/i)).toBeVisible();
});

test("proof center shows public proof inputs without private coordinates", async ({ page }) => {
  await openAppRoute(page, "/#/proof-center");
  await expect(page.getByRole("heading", { name: /Verified wallet claims/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Create location-region proof/i })).toBeVisible();
  await expect(page.getByLabel(/Create proof capability preview/i).getByText(/location\/prove_region/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Create proof/i })).toBeDisabled();
  const regionProof = page.getByRole("article", { name: /Location is in service region/i });
  const preview = regionProof.getByLabel(/Location is in service region proof capability preview/i);
  await expect(regionProof.getByText(/multnomah_county/i)).toBeVisible();
  await expect(regionProof.getByText(/location_in_region/i)).toBeVisible();
  await expect(regionProof.getByText("Simulated", { exact: true })).toBeVisible();
  await expect(preview.getByText(/proof\/verify/i)).toBeVisible();
  await expect(preview.getByText(/precise location read/i)).toBeVisible();
  await expect(regionProof.getByText(/^lat$/i)).not.toBeVisible();
  await expect(regionProof.getByText(/^lon$/i)).not.toBeVisible();
});

test("proof center integrates World ID status, launch, and proof-of-human receipt", async ({ page }) => {
  let signatureRequests = 0;

  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

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
      expect(url.searchParams.get("actor_did")).toBe("did:key:owner");
      await route.fulfill({
        json: {
          verified: true,
          binding_id: "world-id-binding-demo",
          proof_id: "proof-world-id-human",
          verified_at: "2026-06-14T16:00:00Z",
          action: "wallet-attach-world-id-v1",
          credential_policy: "proof_of_human",
          active_binding_count: 1
        }
      });
      return;
    }
    if (path.endsWith("/world-id/rp-signature")) {
      signatureRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:owner",
        action: "wallet-attach-world-id-v1",
        signal_context: "wallet_binding"
      });
      const now = Math.floor(Date.now() / 1000);
      await route.fulfill({
        json: {
          app_id: "app_staging_demo",
          action: "wallet-attach-world-id-v1",
          signal: "211-ai:wallet-world-id:v1:wallet-demo:did:key:owner",
          environment: "staging",
          allow_legacy_proofs: false,
          require_user_presence: true,
          rp_context: {
            rp_id: "rp_demo",
            nonce: "nonce-proof-center-demo",
            created_at: now,
            expires_at: now + 300,
            signature: "0xsignature"
          }
        }
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({
        json: {
          proofs: [
            {
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
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call", path } });
  });

  await openAppRoute(page, walletRoute("proof-center", "did:key:owner"));
  const worldIdStatus = page.getByLabel(/World ID wallet status/i);
  await expect(worldIdStatus.getByRole("heading", { name: /Verified proof-of-human/i })).toBeVisible();
  await expect(worldIdStatus.getByText(/does not disclose or prove legal name, age, citizenship, address/i)).toBeVisible();

  const worldIdPanel = page.getByRole("article", { name: /World ID verification/i });
  await expect(worldIdPanel.getByText(/World ID verified/i)).toBeVisible();
  await expect(worldIdPanel.getByText(/Proof-of-human wallet binding/i)).toBeVisible();

  const worldIdProof = page.getByRole("article", { name: /World ID proof of human is bound to this wallet/i });
  await expect(worldIdProof).toHaveClass(/proof-card/);
  await expect(worldIdProof).toContainText("world_id_proof_of_human");
  await expect(worldIdProof).toContainText("world_id_idkit_v4");
  await expect(worldIdProof).toContainText("proof_of_human");
  await expect(worldIdProof).toContainText("not legal identity");
  await expect(worldIdProof).toContainText(/does not disclose or prove legal name, age, citizenship, address/i);
  await expect(worldIdProof.getByText(/raw_nullifier|idkit_proof|developer_portal_response|rp_signature/i)).toHaveCount(0);

  await worldIdPanel.getByRole("button", { name: /Verify with World ID/i }).click();
  await expect(worldIdPanel.getByRole("button", { name: /Opening IDKit/i })).toBeVisible();
  await expect(worldIdPanel.getByText(/needs @worldcoin\/idkit/i)).toBeVisible();
  expect(signatureRequests).toBe(1);
});

test("World ID status is consistent on register, uploads, and security surfaces", async ({ page }) => {
  await page.route("**/wallets/**", (route) => fulfillWorldIdSurfaceWalletRoute(route, { verified: true }));

  await openAppRoute(page, walletRoute("register", "did:key:owner"));
  const registerStatus = page.getByLabel(/Register World ID status/i);
  await expect(registerStatus.getByText(/World ID verified/i)).toBeVisible();
  await expect(registerStatus.getByText(/Verified proof-of-human/i)).toBeVisible();
  await expect(registerStatus.getByText(/Emergency and essential-service flows remain available/i)).toBeVisible();
  await expect(registerStatus.getByRole("button", { name: /Verify with World ID/i })).toBeVisible();
  await expect(page.getByLabel(/Legal or full name/i)).toBeEnabled();

  await openAppRoute(page, walletRoute("uploads", "did:key:owner"));
  const uploadsStatus = page.getByLabel(/Uploads World ID status/i);
  await expect(uploadsStatus.getByText(/World ID verified/i)).toBeVisible();
  await expect(uploadsStatus.getByText(/Verified proof-of-human/i)).toBeVisible();
  await expect(uploadsStatus.getByText(/Emergency and essential-service flows remain available/i)).toBeVisible();
  await expect(uploadsStatus.getByRole("button", { name: /Verify with World ID/i })).toBeVisible();
  await expect(page.getByLabel(/Choose file to upload/i)).toBeEnabled();

  await openAppRoute(page, walletRoute("security", "did:key:owner"));
  const securityStatus = page.getByLabel(/Security World ID status/i);
  await expect(securityStatus.getByText(/World ID verified/i)).toBeVisible();
  await expect(securityStatus.getByText(/Verified proof-of-human/i)).toBeVisible();
  await expect(securityStatus.getByText(/Emergency and essential-service flows remain available/i)).toBeVisible();
  await expect(securityStatus.getByRole("button", { name: /Verify with World ID/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Save backup/i })).toBeEnabled();
});

test("World ID verification is not offered without an actor DID", async ({ page }) => {
  await page.route("**/wallets/**", (route) => fulfillWorldIdSurfaceWalletRoute(route, { verified: false }));

  await openAppRoute(page, walletRoute("register", ""));
  const registerStatus = page.getByLabel(/Register World ID status/i);
  await expect(registerStatus.getByText(/World ID unverified/i)).toBeVisible();
  await expect(registerStatus.getByText(/Actor DID required/i)).toBeVisible();
  await expect(registerStatus.getByText(/Emergency and essential-service flows remain available/i)).toBeVisible();
  await expect(registerStatus.getByRole("button", { name: /Verify with World ID/i })).toHaveCount(0);
  await expect(page.getByLabel(/Legal or full name/i)).toBeEnabled();
});

test("proof center can create an API-backed location region proof", async ({ page }) => {
  let createRequests = 0;
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/access-requests")) {
      await route.fulfill({ json: { requests: [] } });
      return;
    }
    if (path.endsWith("/grant-receipts")) {
      await route.fulfill({ json: { receipts: [] } });
      return;
    }
    if (path.endsWith("/records") && url.searchParams.get("data_type") === "document") {
      await route.fulfill({ json: { records: [] } });
      return;
    }
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: [] } });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    if (path.endsWith("/locations/rec-location-current/region-proofs")) {
      createRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:owner",
        region_id: "multnomah_county"
      });
      await route.fulfill({
        json: {
          proof_id: "proof-deterministic-location",
          wallet_id: "wallet-demo",
          proof_type: "location_region",
          statement: {
            claim: "location_in_region",
            region_id: "multnomah_county",
            witness_commitment: "commitment"
          },
          verifier_id: "deterministic-location-region-v0.1",
          public_inputs: {
            claim: "location_in_region",
            region_id: "multnomah_county",
            region_policy_hash: "425551d64c5b78caa09fd67d24b099c1ca8749bc9747daa0ae84a69cf3507e3e"
          },
          proof_hash: "proofhash",
          witness_record_ids: ["rec-location-current"],
          is_simulated: false,
          proof_system: "deterministic-test-proof",
          circuit_id: "deterministic-location-region-v0.1",
          verifier_digest: "digest1234567890abcdef",
          proof_artifact_ref: "deterministic-proof://proofhash",
          verification_status: "verified",
          created_at: "2026-05-03T18:04:00Z"
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call" } });
  });

  await openAppRoute(page, walletRoute("proof-center", "did:key:owner"));
  await page.getByRole("button", { name: /Create proof/i }).click();
  await expect(page.getByText(/Proof receipt created/i)).toBeVisible();
  const createdProof = page.getByRole("article", { name: /location_in_region/i }).first();
  await expect(createdProof.getByText(/deterministic-test-proof/i)).toBeVisible();
  await expect(createdProof.locator(".scope-header").getByText("verified", { exact: true })).toBeVisible();
  await expect(createdProof.getByText(/multnomah_county/i)).toBeVisible();
  await expect(createdProof.getByText(/^lat$/i)).not.toBeVisible();
  await expect(createdProof.getByText(/^lon$/i)).not.toBeVisible();
  expect(createRequests).toBe(1);
});

test("ProveKit proof states render across wallet surfaces without private witness leakage", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/wallets/snapshots") {
      await route.fulfill({ json: { wallet_ids: ["wallet-demo"] } });
      return;
    }
    if (path.endsWith("/snapshot") && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          wallet_id: "wallet-demo",
          path: "/tmp/wallet-demo.json",
          exists: true,
          valid: true,
          format: "envelope",
          snapshot_hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abcd",
          computed_hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abcd"
        }
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: buildProveKitWalletProofsApiResponse() });
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
    if (path.endsWith("/audit")) {
      await route.fulfill({
        json: {
          events: [
            {
              event_id: "audit-provekit-fixture",
              created_at: "2026-06-14T09:01:00Z",
              actor_did: "did:key:provekit-ui-owner",
              action: "proof/verify",
              resource: "wallet://wallet-demo/proofs/proof-fixture-provekit-whir",
              decision: "allow",
              grant_id: null
            }
          ]
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call", path } });
  });

  await openAppRoute(page, walletRoute("proof-center", "did:key:owner"));

  await expect(page.getByText("Simulated proof, demo-only").first()).toBeVisible();
  await expect(page.getByText("Groth16 BN254").first()).toBeVisible();
  await expect(page.getByText("ProveKit WHIR").first()).toBeVisible();
  await expect(page.getByText("ProveKit recursive Groth16 wrapper").first()).toBeVisible();
  await expect(page.getByText("ProveKit artifact hash mismatch").first()).toBeVisible();
  await expect(page.getByText("Stale ProveKit verifier key").first()).toBeVisible();
  await expect(page.getByText("ProveKit verification failed").first()).toBeVisible();
  await expect(page.getByText("Not on-chain ready without recursive wrapper").first()).toBeVisible();
  await expect(page.getByText("Not counted as production proof coverage").first()).toBeVisible();

  const assertNoForbiddenWitnessText = async () => {
    for (const token of provekitForbiddenWitnessTokens) {
      await expect(page.getByText(token, { exact: false })).toHaveCount(0);
    }
  };
  await assertNoForbiddenWitnessText();

  await page.evaluate(() => {
    window.location.hash = "#/uploads";
  });
  await expect(page.getByRole("heading", { name: /Wallet proof receipts/i })).toBeVisible();
  await expect(page.getByText("Private witness and private axioms hidden").first()).toBeVisible();
  await assertNoForbiddenWitnessText();

  await page.evaluate(() => {
    window.location.hash = "#/social-services";
  });
  await expect(page.getByRole("heading", { name: /Provider proof review/i })).toBeVisible();
  await expect(page.getByText("Provider may review public proof metadata").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/analytics";
  });
  await expect(page.getByRole("heading", { name: /Public proof dashboard/i })).toBeVisible();
  await expect(page.getByText("Production proof evidence").first()).toBeVisible();
  await expect(page.getByText("Fail-closed receipts").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/exports";
  });
  await expect(page.getByRole("heading", { name: /QR proof review/i })).toBeVisible();
  await expect(page.getByText("QR review shows proof system, verifier, and public inputs only").first()).toBeVisible();
  await expect(page.getByText(/No on-chain claim in this export/i).first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/security";
  });
  await expect(page.getByRole("heading", { name: /Proof security review/i })).toBeVisible();
  await expect(page.getByText("Verifier state fails closed").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/audit";
  });
  await expect(page.getByRole("heading", { name: /Proof audit coverage/i })).toBeVisible();
  await expect(page.getByText(/proof\/verify/i)).toBeVisible();
  await assertNoForbiddenWitnessText();
});

test("Chainlink consensus states render across wallet surfaces without proof label confusion", async ({ page }) => {
  const receiptOnlyConsensus = fixtureConsensus("receipt-only");
  const libp2pConsensus = fixtureConsensus("libp2p");
  const creConsensus = fixtureConsensus("cre");
  const zkmlConsensus = fixtureConsensus("zkml");
  const teeConsensus = fixtureConsensus("tee");
  const proofFailureConsensus = fixtureConsensus("proof-failure");
  const sanitizerConsensus = fixtureConsensus("sanitizer-sentinel");
  const proofs = [
    consensusProofRecord({
      claim: "Document privacy profile",
      consensus: zkmlConsensus,
      id: "proof-zkml-consensus",
      proofSystem: "zkml-checker",
      type: "document_privacy_profile"
    }),
    consensusProofRecord({
      claim: "TEE eligibility claim",
      consensus: teeConsensus,
      id: "proof-tee-consensus",
      proofSystem: "tee-attested",
      type: "eligibility_attestation"
    }),
    consensusProofRecord({
      claim: "Public analytics release",
      consensus: creConsensus,
      id: "proof-cre-consensus",
      proofSystem: "chainlink-cre",
      type: "analytics_release"
    }),
    consensusProofRecord({
      claim: "Receipt-only upload profile",
      consensus: receiptOnlyConsensus,
      id: "proof-receipt-only-consensus",
      proofSystem: "consensus-receipt",
      type: "consensus_receipt"
    }),
    consensusProofRecord({
      claim: "Manual review proof failure",
      consensus: proofFailureConsensus,
      id: "proof-failure-consensus",
      proofSystem: "zkml-checker",
      status: "verification_failed",
      type: "document_privacy_profile"
    }),
    consensusProofRecord({
      claim: "Direct wallet proof",
      id: "proof-direct-wallet",
      proofSystem: "deterministic-test-proof",
      type: "location_region"
    }),
    consensusProofRecord({
      claim: "Sanitized consensus claim",
      consensus: sanitizerConsensus,
      id: "proof-sanitized-consensus",
      proofSystem: "tee-attested-cre",
      type: "consensus_receipt"
    })
  ];

  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/access-requests")) {
      await route.fulfill({
        json: {
          requests: [
            {
              request_id: "access-libp2p-consensus",
              requester_did: "did:key:provider",
              audience_did: "did:key:owner",
              resources: ["wallet://wallet-demo/records/rec-benefits-letter"],
              abilities: ["record/analyze"],
              purpose: "recipient access derived artifact",
              status: "pending",
              created_at: "2026-06-14T12:00:00Z",
              consensus: libp2pConsensus
            }
          ]
        }
      });
      return;
    }
    if (path.endsWith("/grant-receipts")) {
      await route.fulfill({ json: { receipts: [] } });
      return;
    }
    if (path.endsWith("/records") && url.searchParams.get("data_type") === "document") {
      await route.fulfill({
        json: {
          records: [
            {
              record_id: "rec-benefits-letter",
              data_type: "document",
              sensitivity: "high",
              public_descriptor: "Benefits letter",
              status: "active",
              created_at: "2026-06-14T12:00:00Z",
              metadata: { consensus: receiptOnlyConsensus }
            },
            {
              record_id: "rec-direct-upload",
              data_type: "document",
              sensitivity: "moderate",
              public_descriptor: "Direct upload profile",
              status: "active",
              created_at: "2026-06-14T12:02:00Z"
            }
          ]
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/storage") || path.endsWith("/records/rec-direct-upload/storage")) {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs } });
      return;
    }
    if (path.endsWith("/audit")) {
      await route.fulfill({
        json: {
          events: [
            {
              event_id: "audit-cre-consensus",
              created_at: "2026-06-14T12:03:00Z",
              actor_did: "did:key:owner",
              action: "analytics/release",
              resource: "wallet://wallet-demo/analytics/pilot_housing_gap_v1",
              decision: "allow",
              grant_id: null,
              consensus: creConsensus
            },
            {
              event_id: "audit-tee-consensus",
              created_at: "2026-06-14T12:04:00Z",
              actor_did: "did:key:owner",
              action: "hmis/validate",
              resource: "wallet://wallet-demo/hmis/referral-tee-eligibility",
              decision: "allow",
              grant_id: null,
              consensus: teeConsensus
            },
            {
              event_id: "audit-proof-failure-consensus",
              created_at: "2026-06-14T12:05:00Z",
              actor_did: "did:key:owner",
              action: "proof/verify",
              resource: "wallet://wallet-demo/proofs/proof-failure-consensus",
              decision: "deny",
              grant_id: null,
              consensus: proofFailureConsensus
            }
          ]
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected consensus wallet API call", path } });
  });

  await openAppRoute(page, walletRoute("home", "did:key:owner"));
  await expect(page.getByRole("heading", { name: /Recipient access artifacts/i })).toBeVisible();
  await expect(page.getByText("libp2p quorum receipt").first()).toBeVisible();
  await expect(page.getByText("Raw operator outputs hidden").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/uploads";
  });
  await expect(page.getByRole("heading", { name: /Wallet proof receipts/i })).toBeVisible();
  await expect(page.getByText("Consensus receipt").first()).toBeVisible();
  await expect(page.getByText("Direct upload profile").first()).toBeVisible();
  await expect(page.getByText("Consensus receipt, not ZK proof").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/proof-center";
  });
  await expect(page.getByText("ZKML checker verified").first()).toBeVisible();
  await expect(page.getByText("TEE attested").first()).toBeVisible();
  await expect(page.getByText("Chainlink CRE verified").first()).toBeVisible();
  await expect(page.getByText("Manual review required").first()).toBeVisible();
  await expect(page.getByText("Direct wallet proof").first()).toBeVisible();
  const teeCard = page.getByRole("article", { name: /TEE eligibility claim/i });
  await expect(teeCard.getByText("TEE attestation accepted").first()).toBeVisible();
  await expect(teeCard.getByText("TEE evidence, not ZK proof").first()).toBeVisible();
  await expect(teeCard.getByText("verified proof", { exact: true })).toHaveCount(0);
  const receiptCard = page.getByRole("article", { name: /Receipt-only upload profile/i });
  await expect(receiptCard.getByText("Receipt metadata accepted").first()).toBeVisible();
  await expect(receiptCard.getByText("ZKML proof coverage")).toHaveCount(0);

  await page.evaluate(() => {
    window.location.hash = "#/social-services";
  });
  await expect(page.getByRole("heading", { name: /Provider eligibility claims/i })).toBeVisible();
  await expect(page.getByText("TEE attestations").first()).toBeVisible();
  await expect(page.getByText("Provider may review TEE attestation metadata").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/analytics";
  });
  await expect(page.getByRole("heading", { name: /Public proof dashboard/i })).toBeVisible();
  await expect(page.getByText("CRE claims").first()).toBeVisible();
  await expect(page.getByText("ZKML claims").first()).toBeVisible();
  await expect(page.getByText("Manual review").first()).toBeVisible();
  await expect(page.getByText("CRE verification, not ZK proof").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/security";
  });
  await expect(page.getByRole("heading", { name: /Proof security review/i })).toBeVisible();
  await expect(page.getByText("TEE quote bytes hidden").first()).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/audit";
  });
  await expect(page.getByRole("heading", { name: /Proof audit coverage/i })).toBeVisible();
  await expect(page.getByText(/analytics\/release/i)).toBeVisible();
  await expect(page.getByText(/proof verification failed/i).first()).toBeVisible();

  for (const sentinel of SANITIZER_SENTINEL_STRINGS) {
    await expect(page.getByText(sentinel, { exact: false })).toHaveCount(0);
  }
});

test("Chainlink fail-closed proof creation exposes typed manual-review metadata", async ({ page }) => {
  let createRequests = 0;
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/locations/rec-location-current/region-proofs")) {
      createRequests += 1;
      await route.fulfill({
        status: chainlinkConsensusFixturesById["proof-failure"].apiError?.status ?? 422,
        json: chainlinkConsensusFixturesById["proof-failure"].apiError
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
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
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call", path } });
  });

  await openAppRoute(page, walletRoute("proof-center", "did:key:owner"));
  await page.getByRole("button", { name: /Create proof/i }).click();
  await expect(page.getByText(/Consensus failed closed because proof verification failed/i)).toBeVisible();
  await expect(page.getByText("Manual review required").first()).toBeVisible();
  await expect(page.getByText(/proof verification failed/i).first()).toBeVisible();
  await expect(page.getByText(/No simulated fallback was created/i)).toBeVisible();
  expect(createRequests).toBe(1);
});

test("ProveKit backend-disabled proof creation fails closed without minting a fallback", async ({ page }) => {
  let createRequests = 0;
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/locations/rec-location-current/region-proofs")) {
      createRequests += 1;
      await route.fulfill({
        status: 503,
        json: {
          code: "provekit_backend_disabled",
          detail: "ProveKit backend disabled; no simulated fallback was created."
        }
      });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
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
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call", path } });
  });

  await openAppRoute(page, walletRoute("proof-center", "did:key:owner"));
  await page.getByRole("button", { name: /Create proof/i }).click();
  await expect(page.getByText(/ProveKit backend disabled/i)).toBeVisible();
  await expect(page.getByText(/No simulated fallback was created/i)).toBeVisible();
  expect(createRequests).toBe(1);
});

test("exports show receipt hashes and storage status", async ({ page }) => {
  await openAppRoute(page, "/#/exports");
  await expect(page.getByRole("heading", { name: /Shareable wallet bundles/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Create export bundle/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create bundle/i })).toBeDisabled();
  const preview = page.getByLabel("Export capability preview");
  await expect(preview.getByText(/export\/create/i)).toBeVisible();
  await expect(preview.getByText(/Plaintext decrypt/i)).toBeVisible();
  const legalAidExport = page.getByRole("article", { name: /Legal Aid desk/i });
  await expect(legalAidExport.getByText(/Bundle hash/i)).toBeVisible();
  await expect(legalAidExport.getByText(/storage verified/i)).toBeVisible();
  await expect(legalAidExport.getByText(/import verified/i)).toBeVisible();
  await expect(legalAidExport.getByRole("button", { name: /Import descriptors/i })).toBeDisabled();
  const benefitsExport = page.getByRole("article", { name: /Benefits help clinic/i });
  await expect(benefitsExport.getByText(/storage missing/i)).toBeVisible();
});

test("configured exports create verify and import encrypted descriptors", async ({ page }) => {
  const calls: string[] = [];
  const bundle = {
    actor_did: "did:key:dispatch-clinic",
    bundle_id: "export-ui-live",
    bundle_hash: "ui-live-hash",
    bundle_type: "wallet_export_v1",
    created_at: "2026-05-05T12:00:00Z",
    records: [{ record_id: "rec-document-benefits", data_type: "document" }],
    proofs: [{ proof_id: "proof-ui-live", proof_type: "location_region" }],
    versions: [{ record_id: "rec-document-benefits", encrypted_payload_ref: { uri: "memory://payload" } }],
    wallet: { wallet_id: "wallet-demo", owner_did: "did:key:owner" }
  };

  const handleWalletApiRoute = async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/exports/grants")) {
      calls.push("grant");
      const request = route.request().postDataJSON();
      expect(request.record_ids).toEqual(["rec-document-benefits", "rec-location-current"]);
      await route.fulfill({
        json: {
          grant_id: "grant-ui-live",
          audience_did: "did:key:dispatch-clinic",
          resources: ["wallet://wallet-demo/exports"],
          abilities: ["export/create"],
          caveats: { output_types: ["encrypted_export_bundle"] },
          status: "active"
        }
      });
      return;
    }
    if (path.endsWith("/exports/invocations")) {
      calls.push("invocation");
      const request = route.request().postDataJSON();
      expect(request.grant_id).toBe("grant-ui-live");
      await route.fulfill({
        json: {
          invocation_id: "invocation-ui-live",
          grant_id: "grant-ui-live",
          actor_did: "did:key:dispatch-clinic",
          invocation_token: "wallet-ucan-v1.ui-live",
          caveats: { output_types: ["encrypted_export_bundle"] }
        }
      });
      return;
    }
    if (path.endsWith("/wallet-demo/exports")) {
      calls.push("bundle");
      const request = route.request().postDataJSON();
      expect(request.invocation_token).toBe("wallet-ucan-v1.ui-live");
      await route.fulfill({ json: bundle });
      return;
    }
    if (path === "/exports/verify") {
      calls.push("verify");
      await route.fulfill({
        json: {
          valid: true,
          hash_valid: true,
          schema_valid: true,
          bundle_id: bundle.bundle_id,
          bundle_hash: bundle.bundle_hash,
          computed_hash: bundle.bundle_hash
        }
      });
      return;
    }
    if (path === "/exports/storage") {
      calls.push("storage");
      await route.fulfill({
        json: {
          bundle_id: bundle.bundle_id,
          bundle_hash: bundle.bundle_hash,
          wallet_id: "wallet-demo",
          ok: true,
          record_count: 1,
          reports: []
        }
      });
      return;
    }
    if (path === "/exports/import") {
      calls.push("import");
      const request = route.request().postDataJSON();
      expect(request.bundle.bundle_id).toBe(bundle.bundle_id);
      await route.fulfill({
        json: {
          wallet_id: "wallet-demo",
          bundle_id: bundle.bundle_id,
          bundle_hash: bundle.bundle_hash,
          record_count: 1,
          version_count: 1,
          proof_count: 1,
          derived_artifact_count: 0
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
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: [] } });
      return;
    }
    if (path.endsWith("/proofs")) {
      await route.fulfill({ json: { proofs: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected export UI call", path } });
  };

  await page.route("**/wallets/**", handleWalletApiRoute);
  await page.route("**/exports/**", handleWalletApiRoute);

  await openAppRoute(page,
    walletRoute("exports", "did:key:owner", {
      audienceKeyHex: "22".repeat(32),
      issuerKeyHex: "11".repeat(32)
    })
  );
  await page.getByLabel(/Recipient DID/i).fill("did:key:dispatch-clinic");
  await page.getByLabel(/Recipient label/i).fill("Dispatch Clinic");
  await page.getByRole("button", { name: /Create bundle/i }).click();

  await expect(page.getByText(/Export bundle verified/i)).toBeVisible();
  const createdBundle = page.getByRole("article", { name: /Dispatch Clinic/i });
  await expect(createdBundle.getByText(/storage verified/i)).toBeVisible();
  await expect(createdBundle.getByText(/hash verified/i)).toBeVisible();
  await expect(createdBundle.getByText(/schema verified/i)).toBeVisible();
  await expect(createdBundle.getByText(/not imported/i)).toBeVisible();
  await createdBundle.getByRole("button", { name: /Import descriptors/i }).click();
  await expect(page.getByText(/Export descriptors imported/i)).toBeVisible();
  await expect(createdBundle.getByText(/import verified/i)).toBeVisible();
  expect(calls).toEqual(["grant", "invocation", "bundle", "verify", "storage", "import"]);
});

test("security screen saves and restores wallet snapshots", async ({ page }) => {
  let saved = false;
  let saveRequests = 0;
  let loadRequests = 0;
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/wallets/snapshots") {
      await route.fulfill({ json: { wallet_ids: saved ? ["wallet-demo"] : [] } });
      return;
    }
    if (path.endsWith("/snapshot/load")) {
      loadRequests += 1;
      expect(route.request().method()).toBe("POST");
      await route.fulfill({ json: { wallet_id: "wallet-demo", loaded: true } });
      return;
    }
    if (path.endsWith("/snapshot") && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          wallet_id: "wallet-demo",
          path: "/tmp/wallet-demo.json",
          exists: true,
          valid: true,
          format: "envelope",
          snapshot_hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abcd",
          computed_hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abcd"
        }
      });
      return;
    }
    if (path.endsWith("/snapshot")) {
      saveRequests += 1;
      saved = true;
      expect(route.request().method()).toBe("POST");
      await route.fulfill({ json: { wallet_id: "wallet-demo", path: "/tmp/wallet-demo.json" } });
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
    if (path.endsWith("/records") && url.searchParams.get("data_type") === "document") {
      await route.fulfill({ json: { records: [] } });
      return;
    }
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call" } });
  });
  await openAppRoute(page, walletRoute("security", "did:key:owner"));

  await expect(page.getByRole("heading", { name: /Account safety/i })).toBeVisible({ timeout: 15_000 });
  const walletBackups = page.getByRole("region", { name: /Wallet backups/i });
  await expect(page.getByText(/no backup/i)).toBeVisible();
  await page.getByRole("button", { name: /Save backup/i }).click();
  await expect(page.getByText(/Wallet backup saved/i)).toBeVisible();
  await expect(page.getByText(/backup ready/i)).toBeVisible();
  await expect(walletBackups.getByText("verified", { exact: true })).toBeVisible();
  await expect(walletBackups.getByText(/abc123def456/i)).toBeVisible();
  await page.getByRole("button", { name: /Load backup/i }).click();
  await expect(page.getByText(/Wallet backup loaded/i)).toBeVisible();
  expect(saveRequests).toBe(1);
  expect(loadRequests).toBe(1);
});

test("uploads can repair API-backed document storage", async ({ page }) => {
  let repairRequests = 0;
  const auditEvents: Array<Record<string, unknown>> = [];
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/access-requests")) {
      await route.fulfill({ json: { requests: [] } });
      return;
    }
    if (path.endsWith("/grant-receipts")) {
      await route.fulfill({ json: { receipts: [] } });
      return;
    }
    if (path.endsWith("/records") && url.searchParams.get("data_type") === "document") {
      await route.fulfill({
        json: {
          records: [
            {
              record_id: "rec-benefits-letter",
              data_type: "document",
              sensitivity: "high",
              public_descriptor: "Benefits letter",
              status: "active",
              created_at: "2026-05-03T18:00:00Z"
            }
          ]
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/storage/repair")) {
      repairRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({ actor_did: "did:key:owner" });
      auditEvents.push({
        event_id: "audit-storage-repair",
        created_at: "2026-05-03T18:03:00Z",
        actor_did: "did:key:owner",
        action: "storage/repair",
        resource: "wallet://wallet-demo/records/rec-benefits-letter",
        decision: "allow",
        grant_id: null
      });
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: auditEvents } });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/storage")) {
      await route.fulfill({ json: { ok: false } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call" } });
  });
  await openAppRoute(page, walletRoute("uploads", "did:key:owner"));
  const upload = page.locator(".upload-list-item").filter({ hasText: "Benefits letter" });
  await expect(upload.getByText(/save needs fix/i)).toBeVisible();
  await expect(upload.getByText(/^high$/i)).not.toBeVisible();
  await upload.getByRole("button", { name: /Fix save/i }).click();
  await expect(upload.getByText(/^saved$/i)).toBeVisible();
  await expect(upload.getByRole("button", { name: /Fix save/i })).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = "#/audit";
  });
  await expect(page.getByText(/storage\/repair/i)).toBeVisible();
  await expect(page.getByText(/wallet:\/\/wallet-demo\/records\/rec-benefits-letter/i)).toBeVisible();
  expect(repairRequests).toBe(1);
});

test.skip("recipient receipt can create an encrypted derived analysis artifact", async ({ page }) => {
  test.setTimeout(60_000);
  let analysisRequests = 0;
  let redactedAnalysisRequests = 0;
  let vectorProfileRequests = 0;
  let textExtractionRequests = 0;
  let formAnalysisRequests = 0;
  let graphRagRequests = 0;
  let analysisInvocationRequests = 0;
  let decryptRequests = 0;
  let decryptInvocationRequests = 0;
  let delegationRequests = 0;
  const documentPlaintext = "Delegate may view this identity document.";
  const receipts: Array<Record<string, unknown>> = [
    {
      receipt_id: "receipt-analysis",
      grant_id: "grant-analysis",
      audience_did: "did:key:delegate",
      resources: ["wallet://wallet-demo/records/rec-benefits-letter"],
      abilities: ["record/analyze", "record/decrypt", "record/share"],
      purpose: "service_matching",
      caveats: { purpose: "service_matching", user_presence_required: true },
      receipt_hash: "receipt-hash-analysis",
      status: "active",
      created_at: "2026-05-03T18:00:00Z"
    }
  ];
  const auditEvents: Array<Record<string, unknown>> = [];
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/access-requests")) {
      await route.fulfill({ json: { requests: [] } });
      return;
    }
    if (path.endsWith("/grant-receipts")) {
      await route.fulfill({
        json: {
          receipts
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/analysis-invocations")) {
      analysisInvocationRequests += 1;
      expect(route.request().method()).toBe("POST");
      const request = await route.request().postDataJSON();
      expect(request).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        user_present: true
      });
      await route.fulfill({
        json: {
          invocation: {
            invocation_id: `invocation-analysis-${analysisInvocationRequests}`,
            grant_id: "grant-analysis",
            audience_did: "did:key:delegate",
            resource: "wallet://wallet-demo/records/rec-benefits-letter",
            ability: "record/analyze",
            caveats: { output_types: request.output_types, purpose: "service_matching", user_present: true },
            issued_at: "2026-05-03T18:01:00Z",
            expires_at: null,
            nonce: `nonce-analysis-${analysisInvocationRequests}`,
            signature: `sig-analysis-${analysisInvocationRequests}`
          },
          token: `wallet-ucan-v1.analysis-${analysisInvocationRequests}`
        }
      });
      return;
    }
    if (path.endsWith("/grants/grant-analysis/delegate")) {
      delegationRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        issuer_did: "did:key:delegate",
        audience_did: "did:key:case-worker",
        resources: ["wallet://wallet-demo/records/rec-benefits-letter"],
        abilities: ["record/analyze"],
        caveats: { purpose: "warm_handoff" }
      });
      receipts.push({
        receipt_id: "receipt-child",
        grant_id: "grant-child",
        audience_did: "did:key:case-worker",
        resources: ["wallet://wallet-demo/records/rec-benefits-letter"],
        abilities: ["record/analyze"],
        purpose: "warm_handoff",
        receipt_hash: "receipt-hash-child",
        status: "active",
        created_at: "2026-05-03T18:03:00Z"
      });
      auditEvents.push({
        event_id: "audit-grant-delegate",
        created_at: "2026-05-03T18:03:00Z",
        actor_did: "did:key:delegate",
        action: "grant/create",
        resource: "wallet://wallet-demo/records/rec-benefits-letter",
        decision: "allow",
        grant_id: "grant-child"
      });
      await route.fulfill({
        json: {
          grant_id: "grant-child",
          issuer_did: "did:key:delegate",
          audience_did: "did:key:case-worker",
          resources: ["wallet://wallet-demo/records/rec-benefits-letter"],
          abilities: ["record/analyze"],
          caveats: { purpose: "warm_handoff" },
          proof_chain: ["grant-analysis"],
          status: "active",
          created_at: "2026-05-03T18:03:00Z"
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter")) {
      await route.fulfill({ status: 404, json: { error: "unexpected record detail call" } });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/analyze/redacted")) {
      redactedAnalysisRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        max_chars: 500
      });
      await route.fulfill({
        json: {
          artifact: {
            artifact_id: "artifact-redacted-analysis",
            source_record_ids: ["rec-benefits-letter"],
            artifact_type: "redacted_document_analysis",
            output_policy: "redacted_derived_only",
            encrypted_payload_ref: {
              uri: "mem://redacted-analysis",
              storage_type: "memory",
              digest: "sha256:redacted-analysis"
            },
            created_at: "2026-05-03T18:01:05Z"
          },
          output: {
            summary: "Detected need categories across authorized text: housing, food.",
            output_policy: "redacted_derived_only",
            derived_facts: { need_categories: ["housing", "food"] }
          }
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/vector-profile")) {
      vectorProfileRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        chunk_size_words: 80
      });
      await route.fulfill({
        json: {
          artifact: {
            artifact_id: "artifact-vector-profile",
            source_record_ids: ["rec-benefits-letter"],
            artifact_type: "redacted_document_vector_profile",
            output_policy: "encrypted_vector_profile",
            encrypted_payload_ref: {
              uri: "mem://vector-profile",
              storage_type: "memory",
              digest: "sha256:vector-profile"
            },
            created_at: "2026-05-03T18:01:10Z"
          },
          output: {
            output_policy: "encrypted_vector_profile",
            profile: {
              profile_type: "redacted_lexical_hash_vector",
              chunk_count: 2
            }
          }
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/extract-text/redacted")) {
      textExtractionRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        max_chars: 20_000,
        max_bytes: 200_000,
        use_ocr: true
      });
      await route.fulfill({
        json: {
          artifact: {
            artifact_id: "artifact-text-extraction",
            source_record_ids: ["rec-benefits-letter"],
            artifact_type: "redacted_document_text_extraction",
            output_policy: "redacted_extracted_text",
            encrypted_payload_ref: {
              uri: "mem://redacted-text",
              storage_type: "memory",
              digest: "sha256:redacted-text"
            },
            created_at: "2026-05-03T18:01:15Z"
          },
          output: {
            text: "Full name: [REDACTED_PERSON]\nEmail: [REDACTED_EMAIL]",
            output_policy: "redacted_extracted_text",
            redaction_counts: { email: 1, person: 1 }
          }
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/forms/analyze/redacted")) {
      formAnalysisRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        max_fields: 100,
        use_ocr: false
      });
      await route.fulfill({
        json: {
          artifact: {
            artifact_id: "artifact-form-analysis",
            source_record_ids: ["rec-benefits-letter"],
            artifact_type: "redacted_document_form_analysis",
            output_policy: "redacted_form_analysis",
            encrypted_payload_ref: {
              uri: "mem://form-analysis",
              storage_type: "memory",
              digest: "sha256:form-analysis"
            },
            created_at: "2026-05-03T18:01:20Z"
          },
          output: {
            output_policy: "redacted_form_analysis",
            form: { field_count: 2, data_type_counts: { email: 1, person: 1 } },
            fields: [
              { label: "Full name", data_type: "person", required: false },
              { label: "Email", data_type: "email", required: false }
            ]
          }
        }
      });
      return;
    }
    if (path.endsWith("/records/graphrag/redacted")) {
      graphRagRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        record_ids: ["rec-benefits-letter"],
        max_chars_per_record: 20_000,
        max_bytes_per_record: 200_000,
        use_ocr: true
      });
      await route.fulfill({
        json: {
          artifact: {
            artifact_id: "artifact-graphrag",
            source_record_ids: ["rec-benefits-letter"],
            artifact_type: "redacted_document_graphrag",
            output_policy: "redacted_graphrag",
            encrypted_payload_ref: {
              uri: "mem://redacted-graphrag",
              storage_type: "memory",
              digest: "sha256:redacted-graphrag"
            },
            created_at: "2026-05-03T18:01:25Z"
          },
          output: {
            output_policy: "redacted_graphrag",
            graph: {
              graph_type: "redacted_category_entity_graph",
              node_count: 4,
              edge_count: 3,
              category_record_counts: { housing: 1, food: 1 },
              redaction_counts: { email: 1, person: 1 }
            },
            source_record_ids: ["rec-benefits-letter"],
            source_record_count: 1
          }
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/analyze")) {
      analysisRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        max_chars: 200
      });
      auditEvents.push({
        event_id: "audit-record-analyze",
        created_at: "2026-05-03T18:02:00Z",
        actor_did: "did:key:delegate",
        action: "record/analyze",
        resource: "wallet://wallet-demo/records/rec-benefits-letter",
        decision: "allow",
        grant_id: "grant-analysis"
      });
      await route.fulfill({
        json: {
          artifact_id: "artifact-analysis",
          source_record_ids: ["rec-benefits-letter"],
          artifact_type: "summary",
          output_policy: "derived_only",
          encrypted_payload_ref: {
            uri: "mem://derived-artifact",
            storage_type: "memory",
            digest: "sha256:derived"
          },
          created_at: "2026-05-03T18:01:00Z"
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/decrypt-invocations")) {
      decryptInvocationRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        grant_id: "grant-analysis",
        user_present: true
      });
      await route.fulfill({
        json: {
          invocation: {
            invocation_id: "invocation-presence",
            grant_id: "grant-analysis",
            audience_did: "did:key:delegate",
            resource: "wallet://wallet-demo/records/rec-benefits-letter",
            ability: "record/decrypt",
            caveats: { purpose: "service_matching", user_present: true },
            issued_at: "2026-05-03T18:02:20Z",
            expires_at: null,
            nonce: "nonce-presence",
            signature: "sig-presence"
          },
          token: "wallet-ucan-v1.presence"
        }
      });
      return;
    }
    if (path.endsWith("/records/rec-benefits-letter/decrypt")) {
      decryptRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        actor_did: "did:key:delegate",
        actor_key_hex: "delegate-key",
        invocation_token: "wallet-ucan-v1.presence"
      });
      auditEvents.push({
        event_id: "audit-record-decrypt",
        created_at: "2026-05-03T18:02:30Z",
        actor_did: "did:key:delegate",
        action: "record/decrypt",
        resource: "wallet://wallet-demo/records/rec-benefits-letter",
        decision: "allow",
        grant_id: "grant-analysis"
      });
      await route.fulfill({
        json: {
          record_id: "rec-benefits-letter",
          text: documentPlaintext,
          size_bytes: documentPlaintext.length
        }
      });
      return;
    }
    if (path.endsWith("/grants/grant-analysis/delegate")) {
      delegationRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        abilities: ["record/analyze"],
        audience_did: "did:key:case-worker",
        issuer_did: "did:key:delegate",
        issuer_key_hex: "delegate-key",
        resources: ["wallet://wallet-demo/records/rec-benefits-letter"]
      });
      receipts.push({
        receipt_id: "receipt-child",
        grant_id: "grant-child",
        audience_did: "did:key:case-worker",
        resources: ["wallet://wallet-demo/records/rec-benefits-letter"],
        abilities: ["record/analyze"],
        purpose: "warm_handoff",
        receipt_hash: "receipt-hash-child",
        status: "active",
        created_at: "2026-05-03T18:03:00Z"
      });
      auditEvents.push({
        event_id: "audit-grant-delegate",
        created_at: "2026-05-03T18:03:00Z",
        actor_did: "did:key:delegate",
        action: "grant/delegate",
        resource: "wallet://wallet-demo/records/rec-benefits-letter",
        decision: "allow",
        grant_id: "grant-analysis"
      });
      await route.fulfill({
        json: {
          grant_id: "grant-child",
          receipt_hash: "receipt-hash-child"
        }
      });
      return;
    }
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { events: auditEvents } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call" } });
  });

  await openAppRoute(page, walletRoute("recipient-access", "did:key:delegate", { audienceKeyHex: "delegate-key" }));
  await expect(page.getByRole("heading", { name: /Who can see your info/i })).toBeVisible({ timeout: 15_000 });
  const receipt = page.getByRole("article", { name: /delegate/i });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt.getByText(/service_matching/i)).toBeVisible();
  expect(analysisRequests).toBe(0);
  expect(redactedAnalysisRequests).toBe(0);
  expect(vectorProfileRequests).toBe(0);
  expect(textExtractionRequests).toBe(0);
  expect(formAnalysisRequests).toBe(0);
  expect(graphRagRequests).toBe(0);
  expect(analysisInvocationRequests).toBe(0);
  expect(decryptRequests).toBe(0);
  expect(decryptInvocationRequests).toBe(0);
  expect(delegationRequests).toBe(0);
});

test("audit screen loads wallet API event chain metadata", async ({ page }) => {
  await page.route("**/wallets/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/access-requests")) {
      await route.fulfill({ json: { requests: [] } });
      return;
    }
    if (path.endsWith("/grant-receipts")) {
      await route.fulfill({ json: { receipts: [] } });
      return;
    }
    if (path.endsWith("/records") && url.searchParams.get("data_type") === "document") {
      await route.fulfill({ json: { records: [] } });
      return;
    }
    if (path.endsWith("/audit")) {
      await route.fulfill({
        json: {
          events: [
            {
              event_id: "audit-record-analyze",
              created_at: "2026-05-03T18:02:00Z",
              actor_did: "did:key:delegate",
              action: "record/analyze",
              resource: "wallet://wallet-demo/records/rec-benefits-letter",
              decision: "allow",
              grant_id: "grant-analysis"
            },
            {
              event_id: "audit-storage-repair",
              created_at: "2026-05-03T18:03:00Z",
              actor_did: "did:key:owner",
              action: "storage/repair",
              resource: "wallet://wallet-demo/records/rec-benefits-letter",
              decision: "allow",
              grant_id: null
            }
          ]
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected wallet API call" } });
  });

  await openAppRoute(page, walletRoute("audit", "did:key:owner"));
  await expect(page.getByRole("heading", { name: /Consent and access history/i })).toBeVisible();
  await expect(page.getByText(/record\/analyze/i)).toBeVisible();
  await expect(page.getByText(/storage\/repair/i)).toBeVisible();
  await expect(page.getByText(/wallet:\/\/wallet-demo\/records\/rec-benefits-letter/i).first()).toBeVisible();
  await expect(page.getByText(/grant-analysis/i)).toBeVisible();
});
