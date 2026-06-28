# Abby UI Multimodal Review

Generated: 2026-05-11T00:28:04.746410+00:00
Dry run: True
Entries: 29

## desktop · Login page

- Route: `/__login`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/login.png`
- State: `signed out`

### Goals

- Client and service provider portal choices should be immediately visible under the Abby logo.
- The email or telephone login field and code/link action should be clear and reachable on mobile.
- The page should feel like the entry point to Abby without extra informational boxes.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Login page
Viewport: desktop
State: signed out
Screenshot: artifacts/ui-screenshots/latest/desktop/login.png

Goals:
- Client and service provider portal choices should be immediately visible under the Abby logo.
- The email or telephone login field and code/link action should be clear and reachable on mobile.
- The page should feel like the entry point to Abby without extra informational boxes.

## desktop · Home safety plan screen

- Route: `/`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/home.png`
- State: `default`

### Goals

- The welcome heading should be the first clear page signal.
- The old overview card row should stay removed.
- The next check-in and Check in now action should live in Quick actions.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Home safety plan screen
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/home.png

Goals:
- The welcome heading should be the first clear page signal.
- The old overview card row should stay removed.
- The next check-in and Check in now action should live in Quick actions.

## desktop · Registration flow

- Route: `/#/register`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/register.png`
- State: `empty`

### Goals

- Required fields should be obvious without feeling punitive.
- Optional sensitive fields should feel clearly optional.
- The photo or photo ID field should allow image files and PDFs without promising a thumbnail preview.
- The government-services help entry point should be visible on the registration page.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Registration flow
Viewport: desktop
State: empty
Screenshot: artifacts/ui-screenshots/latest/desktop/register.png

Goals:
- Required fields should be obvious without feeling punitive.
- Optional sensitive fields should feel clearly optional.
- The photo or photo ID field should allow image files and PDFs without promising a thumbnail preview.
- The government-services help entry point should be visible on the registration page.

## desktop · Registration flow with profile draft

- Route: `/#/register`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/register-filled.png`
- State: `filled form`

### Goals

- Filled required and optional fields should remain readable.
- The selected photo or photo ID file should be clear without showing an image or PDF thumbnail.
- Identity details should read as a separate group from later fill-in fields.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Registration flow with profile draft
Viewport: desktop
State: filled form
Screenshot: artifacts/ui-screenshots/latest/desktop/register-filled.png

Goals:
- Filled required and optional fields should remain readable.
- The selected photo or photo ID file should be clear without showing an image or PDF thumbnail.
- Identity details should read as a separate group from later fill-in fields.

## desktop · Registration unsupported photo or ID file

- Route: `/#/register`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/register-invalid-file.png`
- State: `unsupported file selected`

### Goals

- Unsupported file feedback should be clear and close to the file field.
- The form should not show a selected-file preview or thumbnail.
- The error state should not crowd required identity fields on mobile.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Registration unsupported photo or ID file
Viewport: desktop
State: unsupported file selected
Screenshot: artifacts/ui-screenshots/latest/desktop/register-invalid-file.png

Goals:
- Unsupported file feedback should be clear and close to the file field.
- The form should not show a selected-file preview or thumbnail.
- The error state should not crowd required identity fields on mobile.

## desktop · Client settings

- Route: `/#/settings`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/client-settings.png`
- State: `account preferences`

### Goals

- The settings page should make the profile form feel editable after registration.
- Privacy and account safety controls should read like saved settings without crowding the page.
- The Settings navigation item should feel like a bottom-of-client-menu destination, not onboarding.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Client settings
Viewport: desktop
State: account preferences
Screenshot: artifacts/ui-screenshots/latest/desktop/client-settings.png

Goals:
- The settings page should make the profile form feel editable after registration.
- Privacy and account safety controls should read like saved settings without crowding the page.
- The Settings navigation item should feel like a bottom-of-client-menu destination, not onboarding.

## desktop · Check-in setup

- Route: `/#/check-in`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/check-in.png`
- State: `default`

### Goals

- The 30-day check-in limit should be clear.
- Reminder channels and next check-in date should be easy to scan.
- The primary check-in action should be reachable on mobile.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Check-in setup
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/check-in.png

Goals:
- The 30-day check-in limit should be clear.
- Reminder channels and next check-in date should be easy to scan.
- The primary check-in action should be reachable on mobile.

## desktop · Check-in setup at 30 days

- Route: `/#/check-in`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/check-in-maximum-interval.png`
- State: `30 day interval`

### Goals

- The longest allowed interval should still feel safe and understandable.
- The missed check-in help-step explanation should remain visible.
- The next check-in preview should update without visual confusion.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Check-in setup at 30 days
Viewport: desktop
State: 30 day interval
Screenshot: artifacts/ui-screenshots/latest/desktop/check-in-maximum-interval.png

Goals:
- The longest allowed interval should still feel safe and understandable.
- The missed check-in help-step explanation should remain visible.
- The next check-in preview should update without visual confusion.

## desktop · Check-in unavailable method warning

- Route: `/#/check-in`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/check-in-email-warning.png`
- State: `email check-in unavailable`

### Goals

- The warning should tell the user what to do next.
- Disabled or unavailable methods should be understandable without relying on color.
- Check-in controls should remain reachable after the warning appears.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Check-in unavailable method warning
Viewport: desktop
State: email check-in unavailable
Screenshot: artifacts/ui-screenshots/latest/desktop/check-in-email-warning.png

Goals:
- The warning should tell the user what to do next.
- Disabled or unavailable methods should be understandable without relying on color.
- Check-in controls should remain reachable after the warning appears.

## desktop · Interaction history

- Route: `/#/interactions`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/interactions-history.png`
- State: `seeded interaction timeline`

### Goals

- Wallet interaction history should read like one unified flow instead of a split sidebar layout.
- Summary cards, filters, calendar handoff, audit details, and the grouped timeline should all remain visible without crowding.
- Follow-up due events should stand out without exposing sensitive note content.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Interaction history
Viewport: desktop
State: seeded interaction timeline
Screenshot: artifacts/ui-screenshots/latest/desktop/interactions-history.png

Goals:
- Wallet interaction history should read like one unified flow instead of a split sidebar layout.
- Summary cards, filters, calendar handoff, audit details, and the grouped timeline should all remain visible without crowding.
- Follow-up due events should stand out without exposing sensitive note content.

## desktop · Calendar schedule

- Route: `/#/calendar`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/calendar-scheduled-services.png`
- State: `scheduled service appointment and follow-up`

### Goals

- Upcoming appointments, follow-ups, and check-ins should be easy to distinguish.
- Travel and reminder details should be visible without crowding the row actions.
- The schedule should remain readable on mobile with action buttons wrapping cleanly.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Calendar schedule
Viewport: desktop
State: scheduled service appointment and follow-up
Screenshot: artifacts/ui-screenshots/latest/desktop/calendar-scheduled-services.png

Goals:
- Upcoming appointments, follow-ups, and check-ins should be easy to distinguish.
- Travel and reminder details should be visible without crowding the row actions.
- The schedule should remain readable on mobile with action buttons wrapping cleanly.

## desktop · Emergency contacts

- Route: `/#/contacts`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/contacts.png`
- State: `default`

### Goals

- The add shelter or group area should appear before saved contacts.
- The add person form should show sharing choices before saving.
- Saved contacts should appear underneath the add controls and stay easy to scan.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Emergency contacts
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/contacts.png

Goals:
- The add shelter or group area should appear before saved contacts.
- The add person form should show sharing choices before saving.
- Saved contacts should appear underneath the add controls and stay easy to scan.

## desktop · Emergency contacts add-recipient form

- Route: `/#/contacts`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/contacts-add-recipient-draft.png`
- State: `draft recipient`

### Goals

- The add-recipient form should be easy to complete on mobile.
- Contact method fields should fit and remain labeled.
- The new-person sharing checkboxes should be visible and readable before save.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Emergency contacts add-recipient form
Viewport: desktop
State: draft recipient
Screenshot: artifacts/ui-screenshots/latest/desktop/contacts-add-recipient-draft.png

Goals:
- The add-recipient form should be easy to complete on mobile.
- Contact method fields should fit and remain labeled.
- The new-person sharing checkboxes should be visible and readable before save.

## desktop · Emergency contacts add-recipient form with sharing off

- Route: `/#/contacts`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/contacts-add-person-sharing-some-off.png`
- State: `draft recipient with medical and housing sharing off`

### Goals

- Unchecked sharing choices should be visible without feeling scary.
- The form should still fit cleanly on mobile after several fields are filled.
- The user should be able to review choices before adding the person.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Emergency contacts add-recipient form with sharing off
Viewport: desktop
State: draft recipient with medical and housing sharing off
Screenshot: artifacts/ui-screenshots/latest/desktop/contacts-add-person-sharing-some-off.png

Goals:
- Unchecked sharing choices should be visible without feeling scary.
- The form should still fit cleanly on mobile after several fields are filled.
- The user should be able to review choices before adding the person.

## desktop · Emergency contacts edit sharing panel

- Route: `/#/contacts`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/contacts-edit-sharing.png`
- State: `saved contact sharing editor open`

### Goals

- A saved contact should open into an obvious full-width sharing edit panel below the list.
- Checkboxes should have a clear group heading and readable labels.
- Save and cancel actions should be reachable without horizontal scrolling.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Emergency contacts edit sharing panel
Viewport: desktop
State: saved contact sharing editor open
Screenshot: artifacts/ui-screenshots/latest/desktop/contacts-edit-sharing.png

Goals:
- A saved contact should open into an obvious full-width sharing edit panel below the list.
- Checkboxes should have a clear group heading and readable labels.
- Save and cancel actions should be reachable without horizontal scrolling.

## desktop · Emergency contacts edit sharing panel with choices off

- Route: `/#/contacts`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/contacts-edit-sharing-some-off.png`
- State: `saved contact medical and housing sharing off`

### Goals

- Unchecked saved-contact sharing choices should be visually clear.
- The selected-count badge should update near the panel heading.
- The edit panel should remain compact enough for mobile review.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Emergency contacts edit sharing panel with choices off
Viewport: desktop
State: saved contact medical and housing sharing off
Screenshot: artifacts/ui-screenshots/latest/desktop/contacts-edit-sharing-some-off.png

Goals:
- Unchecked saved-contact sharing choices should be visually clear.
- The selected-count badge should update near the panel heading.
- The edit panel should remain compact enough for mobile review.

## desktop · Emergency contacts after shelter nudge approval

- Route: `/#/contacts`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/contacts-shelter-nudge-approved.png`
- State: `shelter nudge approved`

### Goals

- Approving a shelter nudge should add the shelter without implying broad sharing.
- The added shelter should be easy to find in the contact list.
- The request history should remain understandable after approval.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Emergency contacts after shelter nudge approval
Viewport: desktop
State: shelter nudge approved
Screenshot: artifacts/ui-screenshots/latest/desktop/contacts-shelter-nudge-approved.png

Goals:
- Approving a shelter nudge should add the shelter without implying broad sharing.
- The added shelter should be easy to find in the contact list.
- The request history should remain understandable after approval.

## desktop · Wallet

- Route: `/#/uploads`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/uploads.png`
- State: `default`

### Goals

- Wallet export and import controls should sit cleanly beside proof sharing and file upload tools.
- The wallet upload affordance should work for camera/mobile and desktop file upload.
- Per-file sharing controls should make private versus selected-contact access visually distinct.
- The wallet should show IPFS/Filecoin backend readiness without exposing credentials.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Wallet
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/uploads.png

Goals:
- Wallet export and import controls should sit cleanly beside proof sharing and file upload tools.
- The wallet upload affordance should work for camera/mobile and desktop file upload.
- Per-file sharing controls should make private versus selected-contact access visually distinct.
- The wallet should show IPFS/Filecoin backend readiness without exposing credentials.

## desktop · Wallet after adding a file

- Route: `/#/uploads`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/uploads-new-file.png`
- State: `new file added`

### Goals

- The newly added file should be visible without exposing document contents.
- Private versus selected-contact sharing status should remain easy to scan.
- The wallet upload area should still be available after a file is added.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Wallet after adding a file
Viewport: desktop
State: new file added
Screenshot: artifacts/ui-screenshots/latest/desktop/uploads-new-file.png

Goals:
- The newly added file should be visible without exposing document contents.
- Private versus selected-contact sharing status should remain easy to scan.
- The wallet upload area should still be available after a file is added.

## desktop · Social services

- Route: `/#/social-services`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/social-services.png`
- State: `default`

### Goals

- Service categories should be dense enough to scan but not cramped.
- Saved and matched services should remain easy to scan without the government-help panel.
- Matched services should be easy to compare on mobile and desktop.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Social services
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/social-services.png

Goals:
- Service categories should be dense enough to scan but not cramped.
- Saved and matched services should remain easy to scan without the government-help panel.
- Matched services should be easy to compare on mobile and desktop.

## desktop · Provider overview

- Route: `/#/shelter`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/shelter.png`
- State: `default`

### Goals

- Provider staff workflows should feel separate from personal account controls.
- Operational metrics should be easy to scan.
- The portal should support low-bandwidth, repeated-use contexts.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Provider overview
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/shelter.png

Goals:
- Provider staff workflows should feel separate from personal account controls.
- Operational metrics should be easy to scan.
- The portal should support low-bandwidth, repeated-use contexts.

## desktop · Shelter portal shared-device checklist

- Route: `/#/provider-operations`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/shelter-shared-device-checklist.png`
- State: `safety checklist checked`

### Goals

- Checked safety steps should be visually clear.
- Staff audit responsibility should remain visible.
- The workflow should still feel usable on a shared device.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Shelter portal shared-device checklist
Viewport: desktop
State: safety checklist checked
Screenshot: artifacts/ui-screenshots/latest/desktop/shelter-shared-device-checklist.png

Goals:
- Checked safety steps should be visually clear.
- Staff audit responsibility should remain visible.
- The workflow should still feel usable on a shared device.

## desktop · Provider case management

- Route: `/#/provider-cases`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/provider-case-management.png`
- State: `default caseload`

### Goals

- Case rows should show next steps, status, priority, and eligibility requirements without crowding.
- Messaging and eligibility-proof actions should be visually available for each served client.
- US citizenship and other criteria should read as proof requirements, not raw document disclosure.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Provider case management
Viewport: desktop
State: default caseload
Screenshot: artifacts/ui-screenshots/latest/desktop/provider-case-management.png

Goals:
- Case rows should show next steps, status, priority, and eligibility requirements without crowding.
- Messaging and eligibility-proof actions should be visually available for each served client.
- US citizenship and other criteria should read as proof requirements, not raw document disclosure.

## desktop · Shelter portal create-user draft

- Route: `/#/provider-operations`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/shelter-create-user-draft.png`
- State: `staff-created user draft`

### Goals

- Staff-created user fields should stay separate from shared-device safety controls.
- Photo or ID PDF support should be clear without a preview.
- Contact reminder helper copy should remain readable in the staff flow.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Shelter portal create-user draft
Viewport: desktop
State: staff-created user draft
Screenshot: artifacts/ui-screenshots/latest/desktop/shelter-create-user-draft.png

Goals:
- Staff-created user fields should stay separate from shared-device safety controls.
- Photo or ID PDF support should be clear without a preview.
- Contact reminder helper copy should remain readable in the staff flow.

## desktop · Public analytics dashboard review

- Route: `/#/analytics`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/analytics.png`
- State: `default`

### Goals

- The screen should read like a public dashboard instead of an internal consent tool.
- Population and provider sections should surface high-level homelessness and service capacity metrics.
- Zero-knowledge and privacy guardrails should be prominent and easy to understand.
- Published measure controls should clearly distinguish live, withheld, and paused releases.
- Metric cards should remain scannable on mobile and desktop.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Public analytics dashboard review
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/analytics.png

Goals:
- The screen should read like a public dashboard instead of an internal consent tool.
- Population and provider sections should surface high-level homelessness and service capacity metrics.
- Zero-knowledge and privacy guardrails should be prominent and easy to understand.
- Published measure controls should clearly distinguish live, withheld, and paused releases.
- Metric cards should remain scannable on mobile and desktop.

## desktop · Public analytics dashboard with measure included

- Route: `/#/analytics`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/analytics-consented.png`
- State: `one choice on`

### Goals

- The included measure should read as part of the public release workflow.
- Live, withheld, and paused states should stay visually distinct.
- Privacy and publication details should remain visible after interaction.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Public analytics dashboard with measure included
Viewport: desktop
State: one choice on
Screenshot: artifacts/ui-screenshots/latest/desktop/analytics-consented.png

Goals:
- The included measure should read as part of the public release workflow.
- Live, withheld, and paused states should stay visually distinct.
- Privacy and publication details should remain visible after interaction.

## desktop · Public analytics dashboard with measure withheld

- Route: `/#/analytics`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/analytics-one-choice-off.png`
- State: `one choice off`

### Goals

- Withholding a measure should be visually clear without hiding privacy guardrails.
- Live and paused measures should remain easy to compare.
- Publication workflow controls should stay understandable.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Public analytics dashboard with measure withheld
Viewport: desktop
State: one choice off
Screenshot: artifacts/ui-screenshots/latest/desktop/analytics-one-choice-off.png

Goals:
- Withholding a measure should be visually clear without hiding privacy guardrails.
- Live and paused measures should remain easy to compare.
- Publication workflow controls should stay understandable.

## desktop · Proof center

- Route: `/#/proof-center`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/proof-center.png`
- State: `default`

### Goals

- Proof creation controls should not imply private data is shown.
- Public proof inputs should be scannable.
- API-required state should be clear but not alarming.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Proof center
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/proof-center.png

Goals:
- Proof creation controls should not imply private data is shown.
- Public proof inputs should be scannable.
- API-required state should be clear but not alarming.

## desktop · Audit history

- Route: `/#/audit`
- Screenshot: `artifacts/ui-screenshots/latest/desktop/audit.png`
- State: `default`

### Goals

- Consent and access history should be easy to scan.
- Audit entries should show actor and timestamp clearly.
- The screen should not expose more sensitive detail than needed.

### Feedback

DRY RUN: router call skipped.

This target is ready for multimodal review.

Screen: Audit history
Viewport: desktop
State: default
Screenshot: artifacts/ui-screenshots/latest/desktop/audit.png

Goals:
- Consent and access history should be easy to scan.
- Audit entries should show actor and timestamp clearly.
- The screen should not expose more sensitive detail than needed.
