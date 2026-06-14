function registerOfflineInteractionQueueTests(test: any, expect: any, offlineQueue: any) {
  const {
    OfflineInteractionQueue,
    createMemoryOfflineInteractionQueueStorage,
    createOfflineInteractionEvent,
    getOfflineInteractionQueueSummary,
  } = offlineQueue;

  const baseIntent = {
    serviceDocId: "svc-food-1",
    sourceContentCid: "bafy-service",
    sourcePageCid: "bafy-page",
    providerName: "Neighborhood Help",
    programName: "Pantry appointments",
    interactionType: "called_provider",
    channel: "phone",
    counterpartyName: "Neighborhood Help",
    counterpartyContact: "5035550100",
    timestamp: "2026-05-05T12:00:00.000Z",
    status: "handoff_requested",
    outcome: "User requested a call handoff. The browser cannot verify whether the call connected.",
    relatedGrantIds: [],
    relatedRecordIds: [],
    privacyLevel: "private",
    metadata: {
      recorded_by: "service_interaction_service",
      capture_kind: "service_action",
    },
  };

  test.describe("offline interaction queue", () => {
    test("stores pending offline interactions as visible timeline events with safe sync metadata", async () => {
      const storage = createMemoryOfflineInteractionQueueStorage();
      const queue = new OfflineInteractionQueue(storage);
      const item = await queue.enqueue({
        actorDid: "did:key:owner",
        intent: baseIntent,
        now: "2026-05-05T12:01:00.000Z",
        queueId: "offline-queue-1",
        walletId: "wallet-1",
      });

      expect(item).toMatchObject({
        actorDid: "did:key:owner",
        attemptCount: 0,
        queueId: "offline-queue-1",
        status: "pending",
        walletId: "wallet-1",
      });
      expect(item.auditTrail).toHaveLength(1);
      expect(item.auditTrail[0]).toMatchObject({
        action: "offline_interaction_queued",
        queueId: "offline-queue-1",
        serviceDocId: "svc-food-1",
        walletId: "wallet-1",
      });

      const visibleEvents = await queue.listVisibleEvents("wallet-1");
      expect(visibleEvents).toHaveLength(1);
      expect(visibleEvents[0]).toMatchObject({
        interaction_id: "offline-queue-1",
        wallet_id: "wallet-1",
        service_doc_id: "svc-food-1",
        interaction_type: "called_provider",
        status: "pending_sync",
        metadata: {
          offline_queue: true,
          offline_queue_id: "offline-queue-1",
          offline_queue_status: "pending",
          offline_attempt_count: 0,
        },
      });
      expect(visibleEvents[0].metadata.offline_audit_actions).toContain("offline_interaction_queued");
      expect(getOfflineInteractionQueueSummary(await queue.list({ includeSynced: true }))).toMatchObject({
        pending: 1,
        synced: 0,
        visible: 1,
      });
    });

    test("replays pending interactions once and preserves an auditable success trail", async () => {
      const storage = createMemoryOfflineInteractionQueueStorage();
      const queue = new OfflineInteractionQueue(storage);
      await queue.enqueue({
        actorDid: "did:key:owner",
        intent: baseIntent,
        now: "2026-05-05T12:01:00.000Z",
        queueId: "offline-queue-1",
        walletId: "wallet-1",
      });

      const createdPayloads: any[] = [];
      const report = await queue.replay(
        { apiBaseUrl: "https://wallet.example.test", walletId: "wallet-1", actorDid: "did:key:owner" },
        {
          createInteraction: async (config: any, intent: any) => {
            createdPayloads.push({ config, intent });
            return {
              interaction_id: "interaction-remote-1",
              wallet_id: config.walletId,
              service_doc_id: intent.serviceDocId,
              source_content_cid: intent.sourceContentCid || "",
              source_page_cid: intent.sourcePageCid || "",
              provider_name: intent.providerName || "",
              program_name: intent.programName || "",
              interaction_type: intent.interactionType,
              channel: intent.channel || "",
              actor_did: config.actorDid,
              counterparty_name: intent.counterpartyName || "",
              counterparty_contact: intent.counterpartyContact || "",
              timestamp: intent.timestamp,
              status: intent.status,
              outcome: intent.outcome,
              notes_record_id: intent.notesRecordId || "",
              next_action: intent.nextAction || "",
              next_follow_up_at: intent.nextFollowUpAt || "",
              source_action_url: intent.sourceActionUrl || "",
              related_grant_ids: intent.relatedGrantIds || [],
              related_record_ids: intent.relatedRecordIds || [],
              privacy_level: intent.privacyLevel || "private",
              created_at: "2026-05-05T12:02:00.000Z",
              updated_at: "2026-05-05T12:02:00.000Z",
              metadata: intent.metadata,
            };
          },
          now: "2026-05-05T12:02:00.000Z",
        },
      );

      expect(report.failed).toHaveLength(0);
      expect(report.replayed).toHaveLength(1);
      expect(report.replayed[0].queueId).toBe("offline-queue-1");
      expect(createdPayloads).toHaveLength(1);
      expect(createdPayloads[0].intent.metadata).toMatchObject({
        offline_queue: true,
        offline_queue_id: "offline-queue-1",
        offline_queued_at: "2026-05-05T12:01:00.000Z",
        offline_replay_attempt: 1,
        offline_replayed_at: "2026-05-05T12:02:00.000Z",
      });
      expect(createdPayloads[0].intent.metadata.offline_audit_actions).toContain("offline_interaction_replay_started");

      const allItems = await queue.list({ includeSynced: true });
      expect(allItems[0]).toMatchObject({
        attemptCount: 1,
        remoteInteractionId: "interaction-remote-1",
        replayedAt: "2026-05-05T12:02:00.000Z",
        status: "synced",
      });
      expect(allItems[0].auditTrail.map((entry: any) => entry.action)).toEqual([
        "offline_interaction_queued",
        "offline_interaction_replay_started",
        "offline_interaction_replay_succeeded",
      ]);
      expect(await queue.listVisibleEvents("wallet-1")).toEqual([]);

      await queue.replay(
        { apiBaseUrl: "https://wallet.example.test", walletId: "wallet-1", actorDid: "did:key:owner" },
        {
          createInteraction: async (config: any, intent: any) => {
            createdPayloads.push({ config, intent });
            throw new Error("Synced items should not replay.");
          },
          now: "2026-05-05T12:03:00.000Z",
        },
      );
      expect(createdPayloads).toHaveLength(1);
    });

    test("keeps failed replays visible and replayable with failure audit details", async () => {
      const storage = createMemoryOfflineInteractionQueueStorage();
      const queue = new OfflineInteractionQueue(storage);
      await queue.enqueue({
        actorDid: "did:key:owner",
        intent: { ...baseIntent, interactionType: "needs_follow_up", channel: "web" },
        now: "2026-05-05T12:01:00.000Z",
        queueId: "offline-queue-2",
        walletId: "wallet-1",
      });

      const failedReport = await queue.replay(
        { apiBaseUrl: "https://wallet.example.test", walletId: "wallet-1", actorDid: "did:key:owner" },
        {
          createInteraction: async () => {
            throw new Error("Network unavailable");
          },
          now: "2026-05-05T12:02:00.000Z",
        },
      );

      expect(failedReport.replayed).toHaveLength(0);
      expect(failedReport.failed).toHaveLength(1);
      const failedItem = (await queue.listVisible("wallet-1"))[0];
      expect(failedItem).toMatchObject({
        attemptCount: 1,
        lastError: "Network unavailable",
        status: "failed",
      });
      expect(createOfflineInteractionEvent(failedItem)).toMatchObject({
        status: "sync_failed",
        metadata: {
          offline_last_error: "Network unavailable",
          offline_queue_status: "failed",
        },
      });
      expect(failedItem.auditTrail.map((entry: any) => entry.action)).toContain("offline_interaction_replay_failed");

      const recovered = await queue.replay(
        { apiBaseUrl: "https://wallet.example.test", walletId: "wallet-1", actorDid: "did:key:owner" },
        {
          createInteraction: async (_config: any, intent: any) => ({
            interaction_id: "interaction-recovered",
            wallet_id: "wallet-1",
            service_doc_id: intent.serviceDocId,
            source_content_cid: "",
            source_page_cid: "",
            provider_name: "",
            program_name: "",
            interaction_type: intent.interactionType,
            channel: intent.channel || "",
            actor_did: "did:key:owner",
            counterparty_name: "",
            counterparty_contact: "",
            timestamp: intent.timestamp,
            status: intent.status,
            outcome: intent.outcome,
            notes_record_id: "",
            next_action: "",
            next_follow_up_at: "",
            source_action_url: "",
            related_grant_ids: [],
            related_record_ids: [],
            privacy_level: "private",
            created_at: "2026-05-05T12:04:00.000Z",
            updated_at: "2026-05-05T12:04:00.000Z",
            metadata: intent.metadata,
          }),
          now: "2026-05-05T12:04:00.000Z",
        },
      );

      expect(recovered.replayed).toHaveLength(1);
      const synced = (await queue.list({ includeSynced: true }))[0];
      expect(synced).toMatchObject({
        attemptCount: 2,
        remoteInteractionId: "interaction-recovered",
        status: "synced",
      });
      expect(synced.lastError).toBeUndefined();
    });

    test("validates required intent fields and supports explicit discard audit", async () => {
      const storage = createMemoryOfflineInteractionQueueStorage();
      const queue = new OfflineInteractionQueue(storage);

      await expect(
        queue.enqueue({
          intent: { ...baseIntent, serviceDocId: "" },
          queueId: "bad-queue",
          walletId: "wallet-1",
        }),
      ).rejects.toThrow(/serviceDocId/);

      await queue.enqueue({
        actorDid: "did:key:owner",
        intent: baseIntent,
        now: "2026-05-05T12:01:00.000Z",
        queueId: "offline-queue-3",
        walletId: "wallet-1",
      });
      const discarded = await queue.discard("offline-queue-3", {
        actorDid: "did:key:owner",
        now: "2026-05-05T12:02:00.000Z",
      });

      expect(discarded).toMatchObject({
        queueId: "offline-queue-3",
        status: "discarded",
      });
      expect(discarded?.auditTrail.map((entry: any) => entry.action)).toEqual([
        "offline_interaction_queued",
        "offline_interaction_discarded",
      ]);
      expect(await queue.listVisible("wallet-1")).toEqual([]);
      expect(await queue.list({ statuses: ["discarded"], walletId: "wallet-1" })).toHaveLength(1);
    });
  });
}

module.exports = { registerOfflineInteractionQueueTests };
