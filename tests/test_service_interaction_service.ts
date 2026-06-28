function registerServiceInteractionServiceTests(test: any, expect: any, serviceInteractions: any, serviceActions: any) {
  const {
    buildManualServiceInteractionIntent,
    buildServiceInteractionIntent,
    emitWalletServiceInteractionIntent,
  } = serviceInteractions;
  const {
    buildCalendarAction,
    buildCallAction,
    buildEmailAction,
    buildMapAction,
    buildShareAction,
    buildTextAction,
  } = serviceActions;

  const context = {
    serviceDocId: "svc-food-1",
    serviceTitle: "Food Pantry",
    providerName: "Neighborhood Help",
    programName: "Pantry appointments",
    sourceUrl: "https://211.example.test/services/svc-food-1",
    sourceContentCid: "bafy-service",
    sourcePageCid: "bafy-page",
  };

  test.describe("service interaction service", () => {
    test("builds wallet-ready call intents without claiming the call connected", () => {
      const action = buildCallAction({ phone: " (503) 555-0100 ext. 42 ", context });
      const result = buildServiceInteractionIntent(action, {
        userInitiated: true,
        observedStatus: "handoff_requested",
        timestamp: "2026-05-05T12:00:00.000Z",
      });

      expect(result.ok).toBe(true);
      expect(result.intent).toMatchObject({
        serviceDocId: "svc-food-1",
        sourceContentCid: "bafy-service",
        sourcePageCid: "bafy-page",
        providerName: "Neighborhood Help",
        programName: "Pantry appointments",
        interactionType: "called_provider",
        channel: "phone",
        counterpartyName: "Neighborhood Help",
        counterpartyContact: "5035550100;ext=42",
        timestamp: "2026-05-05T12:00:00.000Z",
        status: "handoff_requested",
        sourceActionUrl: "tel:5035550100;ext=42",
        privacyLevel: "private",
      });
      expect(result.intent?.outcome).toContain("cannot verify whether the call connected");
      expect(result.intent?.status).not.toBe("completed");
      expect(result.intent?.metadata).toMatchObject({
        recorded_by: "service_interaction_service",
        user_initiated: true,
        capture_kind: "service_action",
        action_kind: "call",
        action_handoff: "link",
        observed_status: "handoff_requested",
      });
      expect(result.intent?.metadata.browser_cannot_observe).toContain("Whether the call connected.");
    });

    test("requires user initiation, backing action data, and a wallet service id", () => {
      const action = buildCallAction({ phone: "(503) 555-0100", context });
      expect(buildServiceInteractionIntent(action, { userInitiated: false }).ok).toBe(false);

      const unavailableAction = buildCallAction({ phone: "not dialable", context });
      const unavailable = buildServiceInteractionIntent(unavailableAction, { userInitiated: true });
      expect(unavailable.ok).toBe(false);
      expect(unavailable.reason).toContain("Unavailable");

      const missingService = buildServiceInteractionIntent(
        buildCallAction({ phone: "(503) 555-0100" }),
        { userInitiated: true },
      );
      expect(missingService.ok).toBe(false);
      expect(missingService.reason).toContain("serviceDocId");
    });

    test("sanitizes message handoff URLs and avoids storing text payloads in metadata", () => {
      const privateBody = "I lost housing and need help";
      const textAction = buildTextAction({
        phone: "+1 (503) 555-0100",
        body: privateBody,
        context,
      });
      const textResult = buildServiceInteractionIntent(textAction, {
        userInitiated: true,
        observedStatus: "handoff_requested",
        timestamp: "2026-05-05T12:00:00.000Z",
      });

      expect(textResult.intent).toMatchObject({
        interactionType: "texted_provider",
        channel: "sms",
        counterpartyContact: "+15035550100",
        sourceActionUrl: "sms:+15035550100",
      });
      expect(JSON.stringify(textResult.intent?.metadata)).not.toContain(privateBody);
      expect(textResult.intent?.metadata.has_text_payload).toBe(true);

      const emailAction = buildEmailAction({
        email: "help@example.org",
        subject: "Intake",
        body: privateBody,
        context,
      });
      const emailResult = buildServiceInteractionIntent(emailAction, { userInitiated: true });
      expect(emailResult.intent).toMatchObject({
        interactionType: "emailed_provider",
        channel: "email",
        counterpartyContact: "help@example.org",
        sourceActionUrl: "mailto:help@example.org",
      });
      expect(JSON.stringify(emailResult.intent?.metadata)).not.toContain(privateBody);
    });

    test("captures map, share, and calendar handoffs as intent events, not OS permission assumptions", () => {
      const mapResult = buildServiceInteractionIntent(
        buildMapAction({ address: "123 Main St, Portland, OR", context }),
        { userInitiated: true, observedStatus: "handoff_requested" },
      );
      expect(mapResult.intent).toMatchObject({
        interactionType: "opened_map",
        channel: "map",
        status: "handoff_requested",
        sourceActionUrl: "https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20Portland%2C%20OR",
      });
      expect(mapResult.intent?.outcome).toContain("cannot verify whether the user visited");

      const shareResult = buildServiceInteractionIntent(
        buildShareAction({ title: "Food pantry", text: "Bring ID.", context }),
        { userInitiated: true, observedStatus: "navigator_share_resolved" },
      );
      expect(shareResult.intent).toMatchObject({
        interactionType: "shared_service",
        channel: "share",
        status: "handoff_resolved",
        sourceActionUrl: "https://211.example.test/services/svc-food-1",
      });
      expect(shareResult.intent?.metadata.has_share_payload).toBe(true);
      expect(shareResult.intent?.outcome).toContain("cannot verify who received");

      const calendarResult = buildServiceInteractionIntent(
        buildCalendarAction({
          title: "Call intake",
          startsAt: "2026-05-10T17:30:00-07:00",
          notes: "Ask about documents.",
          context,
        }),
        { userInitiated: true, observedStatus: "download_link_clicked" },
      );
      expect(calendarResult.intent).toMatchObject({
        interactionType: "created_calendar_reminder",
        channel: "calendar",
        status: "handoff_requested",
        sourceActionUrl: "https://211.example.test/services/svc-food-1",
      });
      expect(calendarResult.intent?.metadata.has_calendar_payload).toBe(true);
      expect(calendarResult.intent?.metadata.file_name).toBe("20260511-call-intake.ics");
      expect(calendarResult.intent?.outcome).toContain("cannot verify whether the event was imported");
    });

    test("builds manual wallet intents for non-OS service actions such as saving", () => {
      const result = buildManualServiceInteractionIntent({
        userInitiated: true,
        context,
        interactionType: "saved_service",
        channel: "wallet",
        timestamp: new Date("2026-05-05T12:00:00.000Z"),
        outcome: "User saved the service for follow-up.",
        relatedRecordIds: ["record-1", "record-1", "record-2"],
      });

      expect(result.ok).toBe(true);
      expect(result.intent).toMatchObject({
        serviceDocId: "svc-food-1",
        interactionType: "saved_service",
        channel: "wallet",
        timestamp: "2026-05-05T12:00:00.000Z",
        status: "intent_recorded",
        relatedRecordIds: ["record-1", "record-2"],
        sourceActionUrl: "https://211.example.test/services/svc-food-1",
      });
      expect(result.intent?.metadata).toMatchObject({
        recorded_by: "service_interaction_service",
        user_initiated: true,
        capture_kind: "manual",
      });
    });

    test("emits built intents through the wallet interaction client", async () => {
      const action = buildCallAction({ phone: "(503) 555-0100", context });
      const captured: any[] = [];
      const createInteraction = async (config: any, intent: any) => {
        captured.push({ config, intent });
        return {
          interaction_id: "interaction-1",
          wallet_id: config.walletId,
          service_doc_id: intent.serviceDocId,
          interaction_type: intent.interactionType,
          metadata: intent.metadata,
        };
      };

      const result = await emitWalletServiceInteractionIntent(
        { apiBaseUrl: "https://wallet.example.test", walletId: "wallet-1", actorDid: "did:key:owner" },
        action,
        { userInitiated: true, timestamp: "2026-05-05T12:00:00.000Z" },
        createInteraction,
      );

      expect(result.ok).toBe(true);
      expect(result.event).toMatchObject({
        interaction_id: "interaction-1",
        wallet_id: "wallet-1",
        service_doc_id: "svc-food-1",
        interaction_type: "called_provider",
      });
      expect(captured[0].intent).toMatchObject({
        serviceDocId: "svc-food-1",
        interactionType: "called_provider",
      });
    });
  });
}

module.exports = { registerServiceInteractionServiceTests };
