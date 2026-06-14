import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

type CaptureViewport = "desktop" | "mobile";

type IterationScenario = {
  id: string;
  path: string;
  title: string;
  state: string;
  viewportOnly?: CaptureViewport;
  goals: string[];
  prepare?: (page: Page) => Promise<void>;
};

type IterationManifestEntry = Omit<IterationScenario, "prepare"> & {
  viewport: CaptureViewport;
  screenshotPath: string;
  previousScreenshotPath?: string;
  multimodalPrompt: string;
};

const iterationRoot = path.resolve(process.cwd(), "artifacts/ui-iterations/latest");
const previousRoot = process.env.UI_REFINEMENT_BASELINE_ROOT
  ? path.resolve(process.cwd(), process.env.UI_REFINEMENT_BASELINE_ROOT)
  : "";
const iterationId = process.env.UI_REFINEMENT_ITERATION_ID || new Date().toISOString().replace(/[:.]/g, "-");
const appSessionKey = "abby-ui-session-v1";

const iterationScenarios: IterationScenario[] = [
  {
    id: "home",
    path: "/",
    title: "Home safety plan screen",
    state: "default",
    goals: [
      "The welcome heading should stay prominent.",
      "The old overview action row should stay removed.",
      "Next check-in information should remain easy to find in Quick actions."
    ]
  },
  {
    id: "mobile-navigation-open",
    path: "/",
    title: "Mobile navigation menu",
    state: "menu open",
    viewportOnly: "mobile",
    goals: [
      "All major routes should be reachable with one hand.",
      "The current route should be visible.",
      "Menu text should fit without truncation or overlap."
    ],
    prepare: async (page) => {
      await page.getByRole("button", { name: /Open menu/i }).click();
    }
  },
  {
    id: "register-filled",
    path: "/#/register",
    title: "Registration flow with profile draft",
    state: "filled form",
    goals: [
      "Required and optional fields should remain readable.",
      "The profile review should summarize the draft clearly.",
      "Sensitive optional details should still feel optional."
    ],
    prepare: async (page) => {
      const screen = page.locator(".screen");
      await page.getByLabel(/Legal or full name/i).fill("Abby Example");
      await page.getByLabel(/Preferred name/i).fill("Abby");
      await page.getByLabel(/Birth date/i).fill("1990-01-01");
      await page.getByLabel(/Phone/i).fill("(503) 555-0100");
      await page.getByLabel(/Email/i).fill("abby@example.org");
      await page.getByLabel(/Current safe location/i).fill("Downtown shelter area");
      await page.getByLabel(/Preferred shelter/i).fill("Rose City Shelter");
      await screen.getByRole("button", { name: "Shelter" }).click();
      await screen.getByRole("button", { name: "Benefits" }).click();
    }
  },
  {
    id: "contacts-add-recipient-draft",
    path: "/#/contacts",
    title: "Emergency contacts add-recipient form",
    state: "draft recipient",
    goals: [
      "The form should be easy to complete on mobile.",
      "Contact method fields should remain labeled and fit their containers.",
      "Recipient type selection should clearly support people, shelters, government help, and benefits agencies."
    ],
    prepare: async (page) => {
      await page.getByLabel(/First name/i).fill("Morgan");
      await page.getByLabel(/Last name/i).fill("Caseworker");
      await page.getByLabel(/Relationship or role/i).fill("Outreach case worker");
      await page.getByLabel(/Phone/i).fill("(503) 555-0188");
      await page.getByLabel(/Email/i).fill("morgan@example.org");
      await page.getByLabel(/Type/i).selectOption("social_worker");
    }
  },
  {
    id: "proof-center",
    path: "/#/proof-center",
    title: "Proof center",
    state: "public proof receipts",
    goals: [
      "Public proof inputs should be easy to inspect.",
      "Precise coordinates, raw documents, and private source data should not appear.",
      "Simulated proof receipts should be clearly distinguishable from verified receipts."
    ]
  }
];

function projectSlug(projectName: string): CaptureViewport {
  return projectName.toLowerCase().includes("mobile") ? "mobile" : "desktop";
}

function scenarioMatchesViewport(scenario: IterationScenario, viewport: CaptureViewport) {
  return !scenario.viewportOnly || scenario.viewportOnly === viewport;
}

function buildPrompt(scenario: IterationScenario, viewport: CaptureViewport, previousScreenshotPath?: string) {
  return [
    `Review the Abby UI refinement screenshot for: ${scenario.title}.`,
    `Viewport: ${viewport}.`,
    `State: ${scenario.state}.`,
    `Iteration: ${iterationId}.`,
    previousScreenshotPath
      ? `Compare against previous screenshot: ${previousScreenshotPath}.`
      : "No previous screenshot is available for this iteration.",
    "Prioritize privacy clarity, emergency/safety comprehension, mobile ergonomics, accessibility, text fit, and visual hierarchy.",
    "Return concise findings grouped as: critical issues, UI/UX improvements, accessibility concerns, and suggested implementation changes.",
    "Route-specific goals:",
    ...scenario.goals.map((goal) => `- ${goal}`)
  ].join("\n");
}

async function previousScreenshotFor(viewport: CaptureViewport, scenarioId: string) {
  if (!previousRoot) return undefined;
  const candidate = path.join(previousRoot, viewport, `${scenarioId}.png`);
  try {
    await fs.access(candidate);
    return path.relative(process.cwd(), candidate);
  } catch {
    return undefined;
  }
}

async function resetMobileNavigation(page: Page, scenarioId: string) {
  if (scenarioId === "mobile-navigation-open") return;
  const mobileNavigation = page.locator("#mobile-navigation");
  if (await mobileNavigation.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /Close menu/i }).click();
  }
}

test("capture Abby UI refinement iteration screenshots for multimodal agents", async ({ page }, testInfo) => {
  const viewport = projectSlug(testInfo.project.name);
  const viewportDir = path.join(iterationRoot, viewport);
  await fs.rm(viewportDir, { force: true, recursive: true });
  await fs.mkdir(viewportDir, { recursive: true });

  const manifest: IterationManifestEntry[] = [];

  for (const scenario of iterationScenarios) {
    if (!scenarioMatchesViewport(scenario, viewport)) {
      continue;
    }

    await page.goto("/");
    await page.evaluate(
      (key) => window.localStorage.setItem(key, JSON.stringify({ username: "iteration-reviewer" })),
      appSessionKey
    );
    await page.goto(scenario.path);
    await resetMobileNavigation(page, scenario.id);
    await expect(page.locator(".screen")).toBeVisible();
    if (scenario.prepare) {
      await scenario.prepare(page);
    }

    const screenshotPath = path.join(viewportDir, `${scenario.id}.png`);
    const previousScreenshotPath = await previousScreenshotFor(viewport, scenario.id);
    await page.screenshot({ fullPage: true, path: screenshotPath });

    manifest.push({
      id: scenario.id,
      path: scenario.path,
      title: scenario.title,
      state: scenario.state,
      goals: scenario.goals,
      viewport,
      screenshotPath: path.relative(process.cwd(), screenshotPath),
      previousScreenshotPath,
      multimodalPrompt: buildPrompt(scenario, viewport, previousScreenshotPath)
    });
  }

  await fs.writeFile(
    path.join(viewportDir, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        iterationId,
        previousRoot: previousRoot ? path.relative(process.cwd(), previousRoot) : null,
        screenshots: manifest
      },
      null,
      2
    )}\n`
  );
});
