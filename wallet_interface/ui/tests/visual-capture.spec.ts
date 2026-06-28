import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

type CaptureScenario = {
  id: string;
  path: string;
  title: string;
  state: string;
  viewportOnly?: "desktop" | "mobile";
  goals: string[];
  prepare?: (page: Page) => Promise<void>;
};

type CaptureViewport = "desktop" | "mobile";

type ScreenshotManifestEntry = Omit<CaptureScenario, "prepare"> & {
  viewport: CaptureViewport;
  screenshotPath: string;
  screenshotPaths?: string[];
  multimodalPrompt: string;
};

const MAX_SCREENSHOT_DIMENSION = 32767;

const captureScenarios: CaptureScenario[] = [
  {
    id: "login",
    path: "/__login",
    title: "Login page",
    state: "signed out",
    goals: [
      "Client and service provider portal choices should be immediately visible under the Abby logo.",
      "The email or telephone login field and code/link action should be clear and reachable on mobile.",
      "The page should feel like the entry point to Abby without extra informational boxes."
    ]
  },
  {
    id: "home",
    path: "/",
    title: "Home safety plan screen",
    state: "default",
    goals: [
      "The welcome heading should be the first clear page signal.",
      "The old overview card row should stay removed.",
      "The next check-in and Check in now action should live in Quick actions."
    ]
  },
  {
    id: "mobile-navigation-open",
    path: "/",
    title: "Mobile navigation menu",
    state: "menu open",
    viewportOnly: "mobile",
    goals: [
      "The menu should expose all major routes without crowding.",
      "The current route should be visually indicated.",
      "Navigation labels should be clear enough for repeated mobile use."
    ],
    prepare: async (page) => {
      await page.getByRole("button", { name: /Open menu/i }).click();
    }
  },
  {
    id: "register",
    path: "/#/register",
    title: "Registration flow",
    state: "empty",
    goals: [
      "Required fields should be obvious without feeling punitive.",
      "Optional sensitive fields should feel clearly optional.",
      "The photo or photo ID field should allow image files and PDFs without promising a thumbnail preview.",
      "The government-services help entry point should be visible on the registration page."
    ]
  },
  {
    id: "register-filled",
    path: "/#/register",
    title: "Registration flow with profile draft",
    state: "filled form",
    goals: [
      "Filled required and optional fields should remain readable.",
      "The selected photo or photo ID file should be clear without showing an image or PDF thumbnail.",
      "Identity details should read as a separate group from later fill-in fields."
    ],
    prepare: async (page) => {
      const screen = page.locator(".screen");
      await page.getByLabel(/Legal or full name/i).fill("Abby Example");
      await page.getByLabel(/Preferred name/i).fill("Abby");
      await page.getByLabel(/Pronouns/i).fill("they/them");
      await page.getByLabel(/Birth date/i).fill("1990-01-01");
      await page.getByLabel(/Photo or photo ID/i).setInputFiles({
        name: "abby-id.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n")
      });
      await page.getByLabel(/Phone/i).fill("(503) 555-0100");
      await page.getByLabel(/Email/i).fill("abby@example.org");
      await page.getByLabel(/Current safe location/i).fill("Downtown shelter area");
      await page.getByLabel(/Preferred shelter/i).fill("Rose City Shelter");
      await screen.getByRole("button", { name: "Shelter" }).click();
      await screen.getByRole("button", { name: "Benefits" }).click();
    }
  },
  {
    id: "register-invalid-file",
    path: "/#/register",
    title: "Registration unsupported photo or ID file",
    state: "unsupported file selected",
    goals: [
      "Unsupported file feedback should be clear and close to the file field.",
      "The form should not show a selected-file preview or thumbnail.",
      "The error state should not crowd required identity fields on mobile."
    ],
    prepare: async (page) => {
      await page.getByLabel(/Photo or photo ID/i).setInputFiles({
        name: "abby-id.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("not accepted")
      });
      await expect(page.getByText(/We can't use this file/i)).toBeVisible();
    }
  },
  {
    id: "client-settings",
    path: "/#/settings",
    title: "Client settings",
    state: "account preferences",
    goals: [
      "The settings page should make the profile form feel editable after registration.",
      "Privacy and account safety controls should read like saved settings without crowding the page.",
      "The Settings navigation item should feel like a bottom-of-client-menu destination, not onboarding."
    ]
  },
  {
    id: "check-in",
    path: "/#/check-in",
    title: "Check-in setup",
    state: "default",
    goals: [
      "The 30-day check-in limit should be clear.",
      "Reminder channels and next check-in date should be easy to scan.",
      "The primary check-in action should be reachable on mobile."
    ]
  },
  {
    id: "check-in-maximum-interval",
    path: "/#/check-in",
    title: "Check-in setup at 30 days",
    state: "30 day interval",
    goals: [
      "The longest allowed interval should still feel safe and understandable.",
      "The missed check-in help-step explanation should remain visible.",
      "The next check-in preview should update without visual confusion."
    ],
    prepare: async (page) => {
      await page.getByLabel(/Days between check-ins/i).fill("30");
      await page.getByLabel(/Extra hours after a missed check-in/i).fill("12");
    }
  },
  {
    id: "check-in-email-warning",
    path: "/#/check-in",
    title: "Check-in unavailable method warning",
    state: "email check-in unavailable",
    goals: [
      "The warning should tell the user what to do next.",
      "Disabled or unavailable methods should be understandable without relying on color.",
      "Check-in controls should remain reachable after the warning appears."
    ],
    prepare: async (page) => {
      await page.getByRole("button", { name: /Check in by email/i }).click();
      await expect(page.getByText(/Email is off|Add an email/i)).toBeVisible();
    }
  },
  {
    id: "interactions-history",
    path: "/#/interactions",
    title: "Interaction history",
    state: "seeded interaction timeline",
    goals: [
      "Wallet interaction history should read like one unified flow instead of a split sidebar layout.",
      "Summary cards, filters, calendar handoff, audit details, and the grouped timeline should all remain visible without crowding.",
      "Follow-up due events should stand out without exposing sensitive note content."
    ]
  },
  {
    id: "calendar-scheduled-services",
    path: "/#/calendar",
    title: "Calendar schedule",
    state: "scheduled service appointment and follow-up",
    goals: [
      "Upcoming appointments, follow-ups, and check-ins should be easy to distinguish.",
      "Travel and reminder details should be visible without crowding the row actions.",
      "The schedule should remain readable on mobile with action buttons wrapping cleanly."
    ]
  },
  {
    id: "contacts",
    path: "/#/contacts",
    title: "Emergency contacts",
    state: "default",
    goals: [
      "The add shelter or group area should appear before saved contacts.",
      "The add person form should show sharing choices before saving.",
      "Saved contacts should appear underneath the add controls and stay easy to scan."
    ]
  },
  {
    id: "contacts-add-recipient-draft",
    path: "/#/contacts",
    title: "Emergency contacts add-recipient form",
    state: "draft recipient",
    goals: [
      "The add-recipient form should be easy to complete on mobile.",
      "Contact method fields should fit and remain labeled.",
      "The new-person sharing checkboxes should be visible and readable before save."
    ],
    prepare: async (page) => {
      await page.getByLabel(/First name/i).fill("Morgan");
      await page.getByLabel(/Last name/i).fill("Caseworker");
      await page.getByLabel(/Relationship or role/i).fill("Outreach case worker");
      await page.getByLabel("Phone", { exact: true }).fill("(503) 555-0188");
      await page.getByLabel("Email", { exact: true }).fill("morgan@example.org");
      await page.getByLabel(/Type/i).selectOption("social_worker");
    }
  },
  {
    id: "contacts-add-person-sharing-some-off",
    path: "/#/contacts",
    title: "Emergency contacts add-recipient form with sharing off",
    state: "draft recipient with medical and housing sharing off",
    goals: [
      "Unchecked sharing choices should be visible without feeling scary.",
      "The form should still fit cleanly on mobile after several fields are filled.",
      "The user should be able to review choices before adding the person."
    ],
    prepare: async (page) => {
      await page.getByLabel(/First name/i).fill("Morgan");
      await page.getByLabel(/Last name/i).fill("Caseworker");
      await page.getByLabel(/Relationship or role/i).fill("Outreach case worker");
      await page.getByLabel("Phone", { exact: true }).fill("(503) 555-0188");
      await page.getByLabel("Email", { exact: true }).fill("morgan@example.org");
      await page.getByLabel(/Type/i).selectOption("social_worker");
      await page.getByLabel(/Medical notes/i).uncheck();
      await page.getByLabel(/Found permanent housing/i).uncheck();
    }
  },
  {
    id: "contacts-edit-sharing",
    path: "/#/contacts",
    title: "Emergency contacts edit sharing panel",
    state: "saved contact sharing editor open",
    goals: [
      "A saved contact should open into an obvious full-width sharing edit panel below the list.",
      "Checkboxes should have a clear group heading and readable labels.",
      "Save and cancel actions should be reachable without horizontal scrolling."
    ],
    prepare: async (page) => {
      const savedMaya = page.locator(".recipient-list-item").filter({ hasText: "Maya Johnson" });
      await savedMaya.getByRole("button", { name: /^Edit sharing$/i }).click();
      await expect(page.getByRole("region", { name: /Edit sharing for Maya Johnson/i })).toBeVisible();
    }
  },
  {
    id: "contacts-edit-sharing-some-off",
    path: "/#/contacts",
    title: "Emergency contacts edit sharing panel with choices off",
    state: "saved contact medical and housing sharing off",
    goals: [
      "Unchecked saved-contact sharing choices should be visually clear.",
      "The selected-count badge should update near the panel heading.",
      "The edit panel should remain compact enough for mobile review."
    ],
    prepare: async (page) => {
      const savedMaya = page.locator(".recipient-list-item").filter({ hasText: "Maya Johnson" });
      await savedMaya.getByRole("button", { name: /^Edit sharing$/i }).click();
      const editPanel = page.getByRole("region", { name: /Edit sharing for Maya Johnson/i });
      await editPanel.getByLabel(/Medical notes/i).uncheck();
      await editPanel.getByLabel(/Found permanent housing/i).uncheck();
      await expect(editPanel.getByText("9 selected", { exact: true })).toBeVisible();
    }
  },
  {
    id: "contacts-shelter-nudge-approved",
    path: "/#/contacts",
    title: "Emergency contacts after shelter nudge approval",
    state: "shelter nudge approved",
    goals: [
      "Approving a shelter nudge should add the shelter without implying broad sharing.",
      "The added shelter should be easy to find in the contact list.",
      "The request history should remain understandable after approval."
    ],
    prepare: async (page) => {
      const addContactSection = page.getByRole("region", { name: "Add contact" });
      await addContactSection.getByText("Shelter or group", { exact: true }).click();
      await expect(addContactSection.getByRole("button", { name: /Ask to add shelter/i })).toBeVisible({
        timeout: 5000
      });
      const nudge = addContactSection.locator(".access-request-item").filter({ hasText: "Downtown Outreach Shelter" }).first();
      const approveButton = nudge.getByRole("button", { name: /^Approve$/i });
      await expect(approveButton).toBeVisible({ timeout: 5000 });
      await approveButton.click();
      await expect(page.locator(".recipient-list-item").filter({ hasText: "Downtown Outreach Shelter" })).toBeVisible();
    }
  },
  {
    id: "uploads",
    path: "/#/uploads",
    title: "Wallet",
    state: "default",
    goals: [
      "Wallet export and import controls should sit cleanly beside proof sharing and file upload tools.",
      "The wallet upload affordance should work for camera/mobile and desktop file upload.",
      "Per-file sharing controls should make private versus selected-contact access visually distinct.",
      "The wallet should show IPFS/Filecoin backend readiness without exposing credentials."
    ]
  },
  {
    id: "uploads-new-file",
    path: "/#/uploads",
    title: "Wallet after adding a file",
    state: "new file added",
    goals: [
      "The newly added file should be visible without exposing document contents.",
      "Private versus selected-contact sharing status should remain easy to scan.",
      "The wallet upload area should still be available after a file is added."
    ],
    prepare: async (page) => {
      await page.getByLabel(/Choose file to upload/i).setInputFiles({
        name: "benefits-update.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n")
      });
      await expect(page.getByText(/benefits-update\.pdf/i)).toBeVisible();
    }
  },
  {
    id: "social-services",
    path: "/#/social-services",
    title: "Social services",
    state: "default",
    goals: [
      "Service categories should be dense enough to scan but not cramped.",
      "Saved and matched services should remain easy to scan without the government-help panel.",
      "Matched services should be easy to compare on mobile and desktop."
    ]
  },
  {
    id: "shelter",
    path: "/#/shelter",
    title: "Provider overview",
    state: "default",
    goals: [
      "Provider staff workflows should feel separate from personal account controls.",
      "Operational metrics should be easy to scan.",
      "The portal should support low-bandwidth, repeated-use contexts."
    ]
  },
  {
    id: "shelter-shared-device-checklist",
    path: "/#/provider-operations",
    title: "Shelter portal shared-device checklist",
    state: "safety checklist checked",
    goals: [
      "Checked safety steps should be visually clear.",
      "Staff audit responsibility should remain visible.",
      "The workflow should still feel usable on a shared device."
    ],
    prepare: async (page) => {
      const checklist = page.locator(".checklist input");
      await checklist.nth(0).check();
      await checklist.nth(1).check();
    }
  },
  {
    id: "provider-case-management",
    path: "/#/provider-cases",
    title: "Provider case management",
    state: "default caseload",
    goals: [
      "Case rows should show next steps, status, priority, and eligibility requirements without crowding.",
      "Messaging and eligibility-proof actions should be visually available for each served client.",
      "US citizenship and other criteria should read as proof requirements, not raw document disclosure."
    ]
  },
  {
    id: "shelter-create-user-draft",
    path: "/#/provider-operations",
    title: "Shelter portal create-user draft",
    state: "staff-created user draft",
    goals: [
      "Staff-created user fields should stay separate from shared-device safety controls.",
      "Photo or ID PDF support should be clear without a preview.",
      "Contact reminder helper copy should remain readable in the staff flow."
    ],
    prepare: async (page) => {
      await page.getByLabel(/Staff identity/i).selectOption({ label: "Avery Patel" });
      const createUser = page.locator('section[aria-labelledby="Create-user-account"]');
      await createUser.getByLabel(/Legal or full name/i).fill("Casey Example");
      await createUser.getByLabel(/Preferred name/i).fill("Casey");
      await createUser.getByLabel(/Email/i).fill("casey@example.org");
      await createUser.getByLabel(/Photo or photo ID/i).setInputFiles({
        name: "casey-id.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n")
      });
      await expect(createUser.getByText(/Selected file: casey-id\.pdf/i)).toBeVisible();
    }
  },
  {
    id: "analytics",
    path: "/#/analytics",
    title: "Public analytics dashboard review",
    state: "default",
    goals: [
      "The screen should read like a public dashboard instead of an internal consent tool.",
      "Population and provider sections should surface high-level homelessness and service capacity metrics.",
      "Zero-knowledge and privacy guardrails should be prominent and easy to understand.",
      "Published measure controls should clearly distinguish live, withheld, and paused releases.",
      "Metric cards should remain scannable on mobile and desktop."
    ]
  },
  {
    id: "analytics-consented",
    path: "/#/analytics",
    title: "Public analytics dashboard with measure included",
    state: "one choice on",
    goals: [
      "The included measure should read as part of the public release workflow.",
      "Live, withheld, and paused states should stay visually distinct.",
      "Privacy and publication details should remain visible after interaction."
    ],
    prepare: async (page) => {
      const releaseMeasure = page.getByRole("article", { name: /Provider capacity gap alerts/i });
      await releaseMeasure.getByRole("checkbox").check();
    }
  },
  {
    id: "analytics-one-choice-off",
    path: "/#/analytics",
    title: "Public analytics dashboard with measure withheld",
    state: "one choice off",
    goals: [
      "Withholding a measure should be visually clear without hiding privacy guardrails.",
      "Live and paused measures should remain easy to compare.",
      "Publication workflow controls should stay understandable."
    ],
    prepare: async (page) => {
      const releaseMeasure = page.getByRole("article", { name: /Unsheltered residents seeking beds/i });
      await releaseMeasure.getByRole("checkbox").uncheck();
    }
  },
  {
    id: "proof-center",
    path: "/#/proof-center",
    title: "Proof center",
    state: "default",
    goals: [
      "Proof creation controls should not imply private data is shown.",
      "Public proof inputs should be scannable.",
      "API-required state should be clear but not alarming."
    ]
  },
  {
    id: "audit",
    path: "/#/audit",
    title: "Audit history",
    state: "default",
    goals: [
      "Consent and access history should be easy to scan.",
      "Audit entries should show actor and timestamp clearly.",
      "The screen should not expose more sensitive detail than needed."
    ]
  }
];

const artifactRoot = path.resolve(process.cwd(), "artifacts/ui-screenshots/latest");
const appSessionKey = "abby-ui-session-v1";
const routeReadyHeadings: Record<string, RegExp> = {
  "/": /Welcome to your safety plan!/i,
  "/#/analytics": /Homelessness and service capacity dashboard/i,
  "/#/calendar": /^Calendar$/i,
  "/#/check-in": /Set your schedule/i,
  "/#/contacts": /People who can help/i,
  "/#/exports": /^Wallet$/i,
  "/#/interactions": /Interaction history/i,
  "/#/proof-center": /Verified wallet claims/i,
  "/#/register": /Create your Abby profile/i,
  "/#/settings": /^Settings$/i,
  "/#/messages": /^Messages$/i,
  "/#/shelter": /Provider overview/i,
  "/#/provider-cases": /Case management/i,
  "/#/provider-operations": /Staff operations/i,
  "/#/social-services": /Find support/i,
  "/#/uploads": /^Wallet$/i,
  "/#/audit": /Consent and access history/i
};

function projectSlug(projectName: string): CaptureViewport {
  return projectName.toLowerCase().includes("mobile") ? "mobile" : "desktop";
}

function scenarioMatchesViewport(route: CaptureScenario, viewport: CaptureViewport) {
  if (!route.viewportOnly) return true;
  return viewport === route.viewportOnly;
}

function buildPrompt(route: CaptureScenario, viewport: CaptureViewport) {
  return [
    `Review the Abby UI screenshot for: ${route.title}.`,
    `Viewport: ${viewport}.`,
    `State: ${route.state}.`,
    "Prioritize mobile/desktop usability, accessibility, safety, privacy clarity, visual hierarchy, and text fit.",
    "Return concise findings grouped as: critical issues, UI/UX improvements, accessibility concerns, and suggested implementation changes.",
    "Route-specific goals:",
    ...route.goals.map((goal) => `- ${goal}`)
  ].join("\n");
}

async function openCaptureScenario(page: Page, scenarioPath: string) {
  if (scenarioPath === "/__login") {
    await page.goto("/");
    await page.evaluate((key) => window.localStorage.removeItem(key), appSessionKey);
    await page.reload();
    await expect(page.locator(".login-page")).toBeVisible();
    await expect(page.getByRole("group", { name: /Choose portal/i })).toBeVisible();
    await expect(page.getByLabel(/Email address or telephone/i)).toBeVisible();
    return;
  }

  await page.goto("/");
  await page.evaluate(
    (key) => window.localStorage.setItem(key, JSON.stringify({ username: "visual-reviewer" })),
    appSessionKey
  );

  if (scenarioPath === "/#/interactions") {
    await seedInteractionsCaptureState(page);
  }

  if (scenarioPath === "/#/calendar") {
    await seedCalendarCaptureState(page);
  }

  if (scenarioPath === "/#/shelter" || scenarioPath === "/#/provider-cases" || scenarioPath === "/#/provider-operations") {
    await verifyShelterStaffForCapture(page);
    if (scenarioPath !== "/#/shelter") {
      await page.goto(scenarioPath);
      await page.reload();
      if (scenarioPath === "/#/provider-cases") {
        await expect(page.locator("h1", { hasText: routeReadyHeadings[scenarioPath] })).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: routeReadyHeadings[scenarioPath] })).toBeVisible();
      }
    }
    return;
  }
  await page.goto(scenarioPath);
  await page.reload();
  await expect(page.locator(".screen")).toBeVisible();
  if (scenarioPath === "/#/shelter" || scenarioPath === "/#/provider-cases") {
    await expect(page.locator("h1", { hasText: routeReadyHeadings[scenarioPath] })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: routeReadyHeadings[scenarioPath] })).toBeVisible();
  }
}

async function seedCalendarCaptureState(page: Page) {
  const now = Date.now();
  const appointmentAt = new Date(now + 26 * 60 * 60 * 1000).toISOString();
  const reminderAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const followUpAt = new Date(now + 54 * 60 * 60 * 1000).toISOString();
  const lastCheckInAt = new Date(now).toISOString();

  await page.evaluate(
    ({ appointmentAt, followUpAt, lastCheckInAt, reminderAt }) => {
      window.localStorage.setItem(
        "abby-ui-state-v1",
        JSON.stringify({
          policy: {
            intervalDays: 2,
            reminderChannels: ["email", "sms"],
            gracePeriodHours: 12,
            escalationEnabled: true,
            lastCheckInAt
          },
          servicePlans: [
            {
              plan_id: "plan-calendar-capture",
              wallet_id: "wallet-demo",
              service_doc_id: "svc-food-pantry-1",
              source_content_cid: "cid-food",
              source_page_cid: "page-food",
              service_title: "Food pantry intake",
              provider_name: "Neighborhood Food Pantry",
              goal: "Attend pantry appointment and confirm next pickup window.",
              steps: ["Bring photo ID"],
              documents_needed: ["Photo ID"],
              questions_to_ask: ["What documents are needed next?"],
              appointment_at: appointmentAt,
              reminder_at: reminderAt,
              travel_target: "Bus 12 to 4th Ave",
              assigned_worker_recipient_id: "",
              status: "active",
              related_interaction_ids: [],
              private_notes_record_id: "",
              created_at: lastCheckInAt,
              updated_at: lastCheckInAt
            }
          ],
          serviceInteractions: [
            {
              interaction_id: "int-calendar-capture",
              wallet_id: "wallet-demo",
              service_doc_id: "svc-clinic-1",
              source_content_cid: "cid-clinic",
              source_page_cid: "page-clinic",
              provider_name: "Health Clinic",
              program_name: "Clinic intake",
              interaction_type: "appointment_scheduled",
              channel: "phone",
              actor_did: "did:example:user",
              counterparty_name: "Clinic desk",
              counterparty_contact: "503-555-0100",
              timestamp: lastCheckInAt,
              status: "active",
              outcome: "Call confirmed",
              notes_record_id: "",
              next_action: "Bring paperwork",
              next_follow_up_at: followUpAt,
              source_action_url: "",
              related_grant_ids: [],
              related_record_ids: [],
              privacy_level: "private",
              created_at: lastCheckInAt,
              updated_at: lastCheckInAt,
              metadata: {}
            }
          ]
        })
      );
    },
    { appointmentAt, followUpAt, lastCheckInAt, reminderAt }
  );
}

async function seedInteractionsCaptureState(page: Page) {
  const now = Date.now();
  const dueFollowUpAt = new Date(now - 6 * 60 * 60 * 1000).toISOString();
  const upcomingFollowUpAt = new Date(now + 42 * 60 * 60 * 1000).toISOString();
  const recordedAt = new Date(now - 12 * 60 * 60 * 1000).toISOString();

  await page.evaluate(
    ({ dueFollowUpAt, recordedAt, upcomingFollowUpAt }) => {
      window.localStorage.setItem(
        "abby-ui-state-v1",
        JSON.stringify({
          savedServices: [
            {
              saved_service_id: "saved-food-pantry",
              service_doc_id: "svc-food-pantry-1",
              source_content_cid: "cid-food",
              source_page_cid: "page-food",
              title: "Food pantry intake",
              label: "Food pantry intake",
              provider_name: "Neighborhood Food Pantry",
              program_name: "Food pantry intake",
              notes: "",
              saved_at: recordedAt,
              updated_at: recordedAt
            }
          ],
          servicePlans: [],
          serviceInteractions: [
            {
              interaction_id: "int-capture-1",
              wallet_id: "wallet-demo",
              service_doc_id: "svc-food-pantry-1",
              source_content_cid: "cid-food",
              source_page_cid: "page-food",
              provider_name: "Neighborhood Food Pantry",
              program_name: "Food pantry intake",
              interaction_type: "appointment_scheduled",
              channel: "phone",
              actor_did: "did:example:user",
              counterparty_name: "Pantry intake desk",
              counterparty_contact: "503-555-0100",
              timestamp: recordedAt,
              status: "active",
              outcome: "Appointment confirmed.",
              notes_record_id: "",
              next_action: "Bring paperwork",
              next_follow_up_at: upcomingFollowUpAt,
              source_action_url: "",
              related_grant_ids: [],
              related_record_ids: [],
              privacy_level: "private",
              created_at: recordedAt,
              updated_at: recordedAt,
              metadata: {}
            },
            {
              interaction_id: "int-capture-2",
              wallet_id: "wallet-demo",
              service_doc_id: "svc-clinic-1",
              source_content_cid: "cid-clinic",
              source_page_cid: "page-clinic",
              provider_name: "Health Clinic",
              program_name: "Clinic intake",
              interaction_type: "called_provider",
              channel: "phone",
              actor_did: "did:example:user",
              counterparty_name: "Clinic desk",
              counterparty_contact: "503-555-0199",
              timestamp: recordedAt,
              status: "needs_follow_up",
              outcome: "Left a voicemail.",
              notes_record_id: "",
              next_action: "Call back if no response",
              next_follow_up_at: dueFollowUpAt,
              source_action_url: "",
              related_grant_ids: [],
              related_record_ids: [],
              privacy_level: "restricted",
              created_at: recordedAt,
              updated_at: recordedAt,
              metadata: {}
            }
          ]
        })
      );
    },
    { dueFollowUpAt, recordedAt, upcomingFollowUpAt }
  );
}

async function verifyShelterStaffForCapture(page: Page) {
  await page.goto("/#/shelter");
  await page.reload();
  await expect(page.locator(".screen")).toBeVisible();
  await expect(page.locator("h1", { hasText: routeReadyHeadings["/#/shelter"] })).toBeVisible({ timeout: 15000 });
  const staffIdentity = page.getByRole("combobox", { name: /Staff identity/i });
  await expect(staffIdentity).toBeVisible({ timeout: 15000 });
  await staffIdentity.selectOption("staff-demo-rose");
}

async function captureScenarioScreenshot(page: Page, outputPath: string): Promise<string[]> {
  try {
    await page.screenshot({
      fullPage: true,
      scale: "css",
      path: outputPath,
    });
    return [outputPath];
  } catch (error) {
    if (!isScreenshotDimensionLimitError(error)) {
      throw error;
    }
  }

  return captureScenarioScreenshotTiles(page, outputPath);
}

async function captureScenarioScreenshotTiles(page: Page, outputPath: string): Promise<string[]> {
  const viewportSize = page.viewportSize();
  const viewportHeight = viewportSize?.height ?? await page.evaluate(() => window.innerHeight);
  const totalHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    document.documentElement.clientHeight,
  ));
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const scrollStep = Math.max(1, viewportHeight - 120);
  const positions = new Set<number>();
  for (let top = 0; top <= maxScrollTop; top += scrollStep) {
    positions.add(Math.min(top, maxScrollTop));
  }
  positions.add(maxScrollTop);

  const ext = path.extname(outputPath);
  const base = outputPath.slice(0, outputPath.length - ext.length);
  const partPaths: string[] = [];

  let index = 0;
  for (const top of [...positions].sort((left, right) => left - right)) {
    index += 1;
    await page.evaluate((value) => window.scrollTo(0, value), top);
    await page.waitForTimeout(50);
    const partPath = `${base}-part-${String(index).padStart(2, "0")}${ext}`;
    await page.screenshot({
      fullPage: false,
      scale: "css",
      path: partPath,
    });
    partPaths.push(partPath);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(50);
  return partPaths;
}

function isScreenshotDimensionLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot take screenshot larger than 32767 pixels on any dimension/i.test(message) ||
    new RegExp(String(MAX_SCREENSHOT_DIMENSION)).test(message);
}

test("capture Abby UI screenshots for multimodal UX review", async ({ page }, testInfo) => {
  test.setTimeout(240000);
  const viewport = projectSlug(testInfo.project.name);
  const viewportDir = path.join(artifactRoot, viewport);
  await fs.rm(viewportDir, { force: true, recursive: true });
  await fs.mkdir(viewportDir, { recursive: true });

  const manifest: ScreenshotManifestEntry[] = [];

  for (const route of captureScenarios) {
    if (!scenarioMatchesViewport(route, viewport)) {
      continue;
    }
    await openCaptureScenario(page, route.path);
    if (route.prepare) {
      await route.prepare(page);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    const screenshotPaths = await captureScenarioScreenshot(page, path.join(viewportDir, `${route.id}.png`));
    const relativeScreenshotPaths = screenshotPaths.map((screenshotPath) => path.relative(process.cwd(), screenshotPath));

    manifest.push({
      id: route.id,
      path: route.path,
      title: route.title,
      state: route.state,
      goals: route.goals,
      viewport,
      screenshotPath: relativeScreenshotPaths[0],
      screenshotPaths: relativeScreenshotPaths.length > 1 ? relativeScreenshotPaths : undefined,
      multimodalPrompt: buildPrompt(route, viewport)
    });
  }

  const manifestPath = path.join(viewportDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), screenshots: manifest }, null, 2)}\n`);
});
