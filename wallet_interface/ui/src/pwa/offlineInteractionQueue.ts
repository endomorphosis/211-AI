import type { ServiceInteractionEvent } from "../models/abby";
import type { ServiceInteractionIntent, ServiceInteractionIntentCreator } from "../services/serviceInteractionService";
import { createWalletServiceInteraction, type WalletApiConfig } from "../services/walletApi";

export type OfflineInteractionQueueStatus = "pending" | "replaying" | "synced" | "failed" | "discarded";

export type OfflineInteractionAuditAction =
  | "offline_interaction_queued"
  | "offline_interaction_replay_started"
  | "offline_interaction_replay_succeeded"
  | "offline_interaction_replay_failed"
  | "offline_interaction_discarded";

export interface OfflineInteractionAuditEntry {
  action: OfflineInteractionAuditAction;
  actorDid: string;
  details: Record<string, unknown>;
  id: string;
  interactionType: string;
  queueId: string;
  serviceDocId: string;
  timestamp: string;
  walletId: string;
}

export interface OfflineQueuedInteraction {
  actorDid: string;
  attemptCount: number;
  auditTrail: OfflineInteractionAuditEntry[];
  createdAt: string;
  intent: ServiceInteractionIntent;
  lastAttemptAt?: string;
  lastError?: string;
  queueId: string;
  remoteInteractionId?: string;
  replayedAt?: string;
  status: OfflineInteractionQueueStatus;
  updatedAt: string;
  walletId: string;
}

export interface OfflineInteractionQueueStorage {
  load(): Promise<OfflineQueuedInteraction[]>;
  save(interactions: OfflineQueuedInteraction[]): Promise<void>;
}

export interface EnqueueOfflineInteractionInput {
  actorDid?: string;
  intent: ServiceInteractionIntent;
  now?: Date | string;
  queueId?: string;
  walletId: string;
}

export interface OfflineInteractionQueueFilter {
  includeSynced?: boolean;
  statuses?: OfflineInteractionQueueStatus[];
  walletId?: string;
}

export interface ReplayOfflineInteractionQueueOptions {
  createInteraction?: ServiceInteractionIntentCreator;
  includeFailed?: boolean;
  includeReplaying?: boolean;
  now?: Date | string;
  onlyQueueIds?: string[];
  stopOnError?: boolean;
}

export interface OfflineInteractionReplaySuccess {
  event: ServiceInteractionEvent;
  item: OfflineQueuedInteraction;
  queueId: string;
}

export interface OfflineInteractionReplayFailure {
  error: string;
  item: OfflineQueuedInteraction;
  queueId: string;
}

export interface OfflineInteractionReplayReport {
  auditTrail: OfflineInteractionAuditEntry[];
  failed: OfflineInteractionReplayFailure[];
  pending: OfflineQueuedInteraction[];
  replayed: OfflineInteractionReplaySuccess[];
}

export interface OfflineInteractionQueueSummary {
  failed: number;
  pending: number;
  replaying: number;
  synced: number;
  total: number;
  visible: number;
}

const DEFAULT_DATABASE_NAME = "abby-offline-interaction-queue-v1";
const DEFAULT_STORE_NAME = "queuedInteractions";
const VISIBLE_QUEUE_STATUSES = new Set<OfflineInteractionQueueStatus>(["pending", "replaying", "failed"]);

let fallbackMemoryStorage: OfflineInteractionQueueStorage | undefined;

export class OfflineInteractionQueue {
  private readonly storage: OfflineInteractionQueueStorage;

  constructor(storage: OfflineInteractionQueueStorage = createBrowserOfflineInteractionQueueStorage()) {
    this.storage = storage;
  }

  async enqueue(input: EnqueueOfflineInteractionInput): Promise<OfflineQueuedInteraction> {
    assertReplayableIntent(input.intent);
    const timestamp = timestampString(input.now);
    const queueId = clean(input.queueId) || createQueueId(input.intent, timestamp);
    const existing = (await this.storage.load()).find((item) => item.queueId === queueId);
    if (existing) {
      return cloneQueuedInteraction(existing);
    }

    const item: OfflineQueuedInteraction = {
      actorDid: clean(input.actorDid) || "unknown_actor",
      attemptCount: 0,
      auditTrail: [],
      createdAt: timestamp,
      intent: cloneIntent(input.intent),
      queueId,
      status: "pending",
      updatedAt: timestamp,
      walletId: clean(input.walletId),
    };
    item.auditTrail = [
      buildAuditEntry(item, "offline_interaction_queued", timestamp, {
        status: item.status,
        offlineQueueVersion: 1,
      }),
    ];

    const nextItems = sortQueueItems([item, ...(await this.storage.load())]);
    await this.storage.save(nextItems);
    return cloneQueuedInteraction(item);
  }

  async list(filter: OfflineInteractionQueueFilter = {}): Promise<OfflineQueuedInteraction[]> {
    const statuses = filter.statuses ? new Set(filter.statuses) : undefined;
    const items = await this.storage.load();
    return sortQueueItems(
      items.filter((item) => {
        if (filter.walletId && item.walletId !== filter.walletId) return false;
        if (!filter.includeSynced && item.status === "synced") return false;
        if (item.status === "discarded" && !statuses?.has("discarded")) return false;
        return statuses ? statuses.has(item.status) : true;
      })
    ).map(cloneQueuedInteraction);
  }

  async listVisible(walletId?: string): Promise<OfflineQueuedInteraction[]> {
    return this.list({
      statuses: [...VISIBLE_QUEUE_STATUSES],
      walletId,
    });
  }

  async listVisibleEvents(walletId?: string): Promise<ServiceInteractionEvent[]> {
    const visible = await this.listVisible(walletId);
    return visible.map(createOfflineInteractionEvent);
  }

  async listAuditTrail(walletId?: string): Promise<OfflineInteractionAuditEntry[]> {
    const items = await this.storage.load();
    return items
      .filter((item) => !walletId || item.walletId === walletId)
      .flatMap((item) => item.auditTrail)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
      .map((entry) => cloneJson(entry));
  }

  async summary(walletId?: string): Promise<OfflineInteractionQueueSummary> {
    return getOfflineInteractionQueueSummary(await this.list({ includeSynced: true, walletId }));
  }

  async discard(queueId: string, options: { actorDid?: string; now?: Date | string } = {}): Promise<OfflineQueuedInteraction | null> {
    const timestamp = timestampString(options.now);
    const items = await this.storage.load();
    const item = items.find((candidate) => candidate.queueId === queueId);
    if (!item) return null;

    const nextItem: OfflineQueuedInteraction = {
      ...item,
      actorDid: clean(options.actorDid) || item.actorDid,
      auditTrail: [
        ...item.auditTrail,
        buildAuditEntry(
          { ...item, actorDid: clean(options.actorDid) || item.actorDid },
          "offline_interaction_discarded",
          timestamp,
          { previousStatus: item.status }
        ),
      ],
      status: "discarded",
      updatedAt: timestamp,
    };
    await this.storage.save(replaceQueueItem(items, nextItem));
    return cloneQueuedInteraction(nextItem);
  }

  async replay(
    config: WalletApiConfig,
    options: ReplayOfflineInteractionQueueOptions = {}
  ): Promise<OfflineInteractionReplayReport> {
    const createInteraction = options.createInteraction ?? createWalletServiceInteraction;
    const replayed: OfflineInteractionReplaySuccess[] = [];
    const failed: OfflineInteractionReplayFailure[] = [];
    const replayableStatuses = new Set<OfflineInteractionQueueStatus>(["pending"]);
    if (options.includeFailed !== false) replayableStatuses.add("failed");
    if (options.includeReplaying !== false) replayableStatuses.add("replaying");
    const onlyQueueIds = options.onlyQueueIds ? new Set(options.onlyQueueIds.map(clean).filter(Boolean)) : undefined;

    let items = await this.storage.load();
    const candidates = sortQueueItems(
      items.filter((item) => {
        if (item.walletId !== config.walletId) return false;
        if (!replayableStatuses.has(item.status)) return false;
        return onlyQueueIds ? onlyQueueIds.has(item.queueId) : true;
      })
    );

    for (const candidate of candidates) {
      const startedAt = timestampString(options.now);
      const startedItem = markReplayStarted(candidate, config, startedAt);
      items = replaceQueueItem(items, startedItem);
      await this.storage.save(items);

      try {
        const event = await createInteraction(config, intentForReplay(startedItem, startedAt));
        const completedAt = timestampString(options.now);
        const syncedItem = markReplaySucceeded(startedItem, event, completedAt);
        items = replaceQueueItem(items, syncedItem);
        await this.storage.save(items);
        replayed.push({ event, item: cloneQueuedInteraction(syncedItem), queueId: syncedItem.queueId });
      } catch (error) {
        const failedAt = timestampString(options.now);
        const message = safeErrorMessage(error);
        const failedItem = markReplayFailed(startedItem, message, failedAt);
        items = replaceQueueItem(items, failedItem);
        await this.storage.save(items);
        failed.push({ error: message, item: cloneQueuedInteraction(failedItem), queueId: failedItem.queueId });
        if (options.stopOnError) break;
      }
    }

    const pending = sortQueueItems(
      items.filter((item) => item.walletId === config.walletId && VISIBLE_QUEUE_STATUSES.has(item.status))
    ).map(cloneQueuedInteraction);

    return {
      auditTrail: pending.flatMap((item) => item.auditTrail).concat(replayed.flatMap((item) => item.item.auditTrail)),
      failed,
      pending,
      replayed,
    };
  }
}

export function createMemoryOfflineInteractionQueueStorage(
  initialInteractions: OfflineQueuedInteraction[] = []
): OfflineInteractionQueueStorage {
  let interactions = initialInteractions.map(cloneQueuedInteraction);
  return {
    async load() {
      return interactions.map(cloneQueuedInteraction);
    },
    async save(nextInteractions: OfflineQueuedInteraction[]) {
      interactions = nextInteractions.map(cloneQueuedInteraction);
    },
  };
}

export function createIndexedDbOfflineInteractionQueueStorage(
  options: { databaseName?: string; storeName?: string } = {}
): OfflineInteractionQueueStorage {
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const storeName = options.storeName ?? DEFAULT_STORE_NAME;

  return {
    async load() {
      const database = await openQueueDatabase(databaseName, storeName);
      try {
        return await requestAllQueuedInteractions(database, storeName);
      } finally {
        database.close();
      }
    },
    async save(interactions: OfflineQueuedInteraction[]) {
      const database = await openQueueDatabase(databaseName, storeName);
      try {
        await replaceAllQueuedInteractions(database, storeName, interactions);
      } finally {
        database.close();
      }
    },
  };
}

export function createBrowserOfflineInteractionQueueStorage(): OfflineInteractionQueueStorage {
  if (typeof indexedDB !== "undefined") {
    return createIndexedDbOfflineInteractionQueueStorage();
  }
  if (!fallbackMemoryStorage) {
    fallbackMemoryStorage = createMemoryOfflineInteractionQueueStorage();
  }
  return fallbackMemoryStorage;
}

export async function enqueueOfflineServiceInteraction(
  input: EnqueueOfflineInteractionInput,
  storage?: OfflineInteractionQueueStorage
): Promise<OfflineQueuedInteraction> {
  return new OfflineInteractionQueue(storage).enqueue(input);
}

export async function listVisibleOfflineServiceInteractions(
  storage?: OfflineInteractionQueueStorage,
  walletId?: string
): Promise<ServiceInteractionEvent[]> {
  return new OfflineInteractionQueue(storage).listVisibleEvents(walletId);
}

export async function replayOfflineServiceInteractions(
  config: WalletApiConfig,
  options: ReplayOfflineInteractionQueueOptions & { storage?: OfflineInteractionQueueStorage } = {}
): Promise<OfflineInteractionReplayReport> {
  const { storage, ...replayOptions } = options;
  return new OfflineInteractionQueue(storage).replay(config, replayOptions);
}

export const enqueueOfflineInteraction = enqueueOfflineServiceInteraction;
export const listVisibleOfflineInteractions = listVisibleOfflineServiceInteractions;
export const replayOfflineInteractionQueue = replayOfflineServiceInteractions;

export function createOfflineInteractionEvent(item: OfflineQueuedInteraction): ServiceInteractionEvent {
  const intent = item.intent;
  const createdAt = item.createdAt;
  const updatedAt = item.updatedAt;
  return {
    interaction_id: item.remoteInteractionId || item.queueId,
    wallet_id: item.walletId,
    service_doc_id: intent.serviceDocId,
    source_content_cid: intent.sourceContentCid || "",
    source_page_cid: intent.sourcePageCid || "",
    provider_name: intent.providerName || "",
    program_name: intent.programName || "",
    interaction_type: intent.interactionType,
    channel: intent.channel || "",
    actor_did: item.actorDid,
    counterparty_name: intent.counterpartyName || "",
    counterparty_contact: intent.counterpartyContact || "",
    timestamp: intent.timestamp || createdAt,
    status: visibleStatusForQueueStatus(item.status, intent.status),
    outcome: intent.outcome || "",
    notes_record_id: intent.notesRecordId || "",
    next_action: intent.nextAction || "",
    next_follow_up_at: intent.nextFollowUpAt || "",
    source_action_url: intent.sourceActionUrl || "",
    related_grant_ids: intent.relatedGrantIds ?? [],
    related_record_ids: intent.relatedRecordIds ?? [],
    privacy_level: intent.privacyLevel || "private",
    created_at: createdAt,
    updated_at: updatedAt,
    metadata: {
      ...intent.metadata,
      offline_queue: true,
      offline_queue_id: item.queueId,
      offline_queue_status: item.status,
      offline_queued_at: item.createdAt,
      offline_attempt_count: item.attemptCount,
      offline_last_attempt_at: item.lastAttemptAt,
      offline_replayed_at: item.replayedAt,
      offline_remote_interaction_id: item.remoteInteractionId,
      offline_last_error: item.lastError,
      offline_audit_actions: item.auditTrail.map((entry) => entry.action),
    },
  };
}

export const createOfflineServiceInteractionEvent = createOfflineInteractionEvent;

export function getOfflineInteractionQueueSummary(items: OfflineQueuedInteraction[]): OfflineInteractionQueueSummary {
  const summary: OfflineInteractionQueueSummary = {
    failed: 0,
    pending: 0,
    replaying: 0,
    synced: 0,
    total: items.length,
    visible: 0,
  };
  for (const item of items) {
    if (item.status === "pending") summary.pending += 1;
    if (item.status === "failed") summary.failed += 1;
    if (item.status === "replaying") summary.replaying += 1;
    if (item.status === "synced") summary.synced += 1;
    if (VISIBLE_QUEUE_STATUSES.has(item.status)) summary.visible += 1;
  }
  return summary;
}

function assertReplayableIntent(intent: ServiceInteractionIntent): void {
  if (!clean(intent.serviceDocId)) {
    throw new Error("Offline interaction queue entries require serviceDocId.");
  }
  if (!clean(intent.interactionType)) {
    throw new Error("Offline interaction queue entries require interactionType.");
  }
}

function markReplayStarted(
  item: OfflineQueuedInteraction,
  config: WalletApiConfig,
  timestamp: string
): OfflineQueuedInteraction {
  const nextItem: OfflineQueuedInteraction = {
    ...item,
    actorDid: clean(config.actorDid) || item.actorDid,
    attemptCount: item.attemptCount + 1,
    lastAttemptAt: timestamp,
    lastError: undefined,
    status: "replaying",
    updatedAt: timestamp,
  };
  return {
    ...nextItem,
    auditTrail: [
      ...item.auditTrail,
      buildAuditEntry(nextItem, "offline_interaction_replay_started", timestamp, {
        attemptCount: nextItem.attemptCount,
      }),
    ],
  };
}

function markReplaySucceeded(
  item: OfflineQueuedInteraction,
  event: ServiceInteractionEvent,
  timestamp: string
): OfflineQueuedInteraction {
  const nextItem: OfflineQueuedInteraction = {
    ...item,
    lastError: undefined,
    remoteInteractionId: event.interaction_id,
    replayedAt: timestamp,
    status: "synced",
    updatedAt: timestamp,
  };
  return {
    ...nextItem,
    auditTrail: [
      ...item.auditTrail,
      buildAuditEntry(nextItem, "offline_interaction_replay_succeeded", timestamp, {
        attemptCount: nextItem.attemptCount,
        remoteInteractionId: event.interaction_id,
      }),
    ],
  };
}

function markReplayFailed(item: OfflineQueuedInteraction, error: string, timestamp: string): OfflineQueuedInteraction {
  const nextItem: OfflineQueuedInteraction = {
    ...item,
    lastError: error,
    status: "failed",
    updatedAt: timestamp,
  };
  return {
    ...nextItem,
    auditTrail: [
      ...item.auditTrail,
      buildAuditEntry(nextItem, "offline_interaction_replay_failed", timestamp, {
        attemptCount: nextItem.attemptCount,
        error,
      }),
    ],
  };
}

function intentForReplay(item: OfflineQueuedInteraction, replayedAt: string): ServiceInteractionIntent {
  const intent = cloneIntent(item.intent);
  return {
    ...intent,
    metadata: {
      ...intent.metadata,
      offline_queue: true,
      offline_queue_id: item.queueId,
      offline_queued_at: item.createdAt,
      offline_replay_attempt: item.attemptCount,
      offline_replayed_at: replayedAt,
      offline_audit_actions: item.auditTrail.map((entry) => entry.action),
    },
  };
}

function buildAuditEntry(
  item: OfflineQueuedInteraction,
  action: OfflineInteractionAuditAction,
  timestamp: string,
  details: Record<string, unknown> = {}
): OfflineInteractionAuditEntry {
  return {
    action,
    actorDid: item.actorDid,
    details: compactMetadata(details),
    id: `${item.queueId}:${action}:${item.auditTrail.length + 1}`,
    interactionType: item.intent.interactionType,
    queueId: item.queueId,
    serviceDocId: item.intent.serviceDocId,
    timestamp,
    walletId: item.walletId,
  };
}

async function openQueueDatabase(databaseName: string, storeName: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable for the offline interaction queue.");
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: "queueId" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Offline interaction queue database could not open."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function requestAllQueuedInteractions(database: IDBDatabase, storeName: string): Promise<OfflineQueuedInteraction[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onerror = () => reject(request.error ?? new Error("Offline interaction queue could not be read."));
    request.onsuccess = () => resolve(sortQueueItems((request.result ?? []).map(normalizeQueuedInteraction)));
  });
}

async function replaceAllQueuedInteractions(
  database: IDBDatabase,
  storeName: string,
  interactions: OfflineQueuedInteraction[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    store.clear();
    for (const item of interactions) {
      store.put(cloneQueuedInteraction(item));
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline interaction queue could not be saved."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline interaction queue save was aborted."));
  });
}

function normalizeQueuedInteraction(value: unknown): OfflineQueuedInteraction {
  const record = isRecord(value) ? value : {};
  const intent = normalizeIntent(record.intent);
  const createdAt = stringValue(record.createdAt) || intent.timestamp || new Date().toISOString();
  const queueId = stringValue(record.queueId) || createQueueId(intent, createdAt);
  const status = normalizeQueueStatus(record.status);
  const item: OfflineQueuedInteraction = {
    actorDid: stringValue(record.actorDid) || "unknown_actor",
    attemptCount: numberValue(record.attemptCount),
    auditTrail: Array.isArray(record.auditTrail)
      ? record.auditTrail.map(normalizeAuditEntry).filter(isAuditEntry)
      : [],
    createdAt,
    intent,
    lastAttemptAt: stringValue(record.lastAttemptAt) || undefined,
    lastError: stringValue(record.lastError) || undefined,
    queueId,
    remoteInteractionId: stringValue(record.remoteInteractionId) || undefined,
    replayedAt: stringValue(record.replayedAt) || undefined,
    status,
    updatedAt: stringValue(record.updatedAt) || createdAt,
    walletId: stringValue(record.walletId),
  };
  return item.auditTrail.length
    ? item
    : {
        ...item,
        auditTrail: [
          buildAuditEntry(item, "offline_interaction_queued", createdAt, {
            status,
            restoredWithoutAuditTrail: true,
          }),
        ],
      };
}

function normalizeIntent(value: unknown): ServiceInteractionIntent {
  const record = isRecord(value) ? value : {};
  return {
    serviceDocId: stringValue(record.serviceDocId),
    sourceContentCid: stringValue(record.sourceContentCid) || undefined,
    sourcePageCid: stringValue(record.sourcePageCid) || undefined,
    providerName: stringValue(record.providerName) || undefined,
    programName: stringValue(record.programName) || undefined,
    interactionType: stringValue(record.interactionType),
    channel: stringValue(record.channel) || undefined,
    counterpartyName: stringValue(record.counterpartyName) || undefined,
    counterpartyContact: stringValue(record.counterpartyContact) || undefined,
    timestamp: stringValue(record.timestamp) || new Date().toISOString(),
    status: stringValue(record.status) || "pending_sync",
    outcome: stringValue(record.outcome),
    notesRecordId: stringValue(record.notesRecordId) || undefined,
    nextAction: stringValue(record.nextAction) || undefined,
    nextFollowUpAt: stringValue(record.nextFollowUpAt) || undefined,
    sourceActionUrl: stringValue(record.sourceActionUrl) || undefined,
    relatedGrantIds: stringArray(record.relatedGrantIds),
    relatedRecordIds: stringArray(record.relatedRecordIds),
    privacyLevel: stringValue(record.privacyLevel) || "private",
    metadata: isRecord(record.metadata) ? record.metadata : {},
  };
}

function normalizeAuditEntry(value: unknown): OfflineInteractionAuditEntry | null {
  if (!isRecord(value)) return null;
  const action = normalizeAuditAction(value.action);
  if (!action) return null;
  return {
    action,
    actorDid: stringValue(value.actorDid),
    details: isRecord(value.details) ? value.details : {},
    id: stringValue(value.id),
    interactionType: stringValue(value.interactionType),
    queueId: stringValue(value.queueId),
    serviceDocId: stringValue(value.serviceDocId),
    timestamp: stringValue(value.timestamp),
    walletId: stringValue(value.walletId),
  };
}

function isAuditEntry(value: OfflineInteractionAuditEntry | null): value is OfflineInteractionAuditEntry {
  return Boolean(value);
}

function normalizeQueueStatus(value: unknown): OfflineInteractionQueueStatus {
  if (
    value === "pending" ||
    value === "replaying" ||
    value === "synced" ||
    value === "failed" ||
    value === "discarded"
  ) {
    return value;
  }
  return "pending";
}

function normalizeAuditAction(value: unknown): OfflineInteractionAuditAction | null {
  if (
    value === "offline_interaction_queued" ||
    value === "offline_interaction_replay_started" ||
    value === "offline_interaction_replay_succeeded" ||
    value === "offline_interaction_replay_failed" ||
    value === "offline_interaction_discarded"
  ) {
    return value;
  }
  return null;
}

function visibleStatusForQueueStatus(status: OfflineInteractionQueueStatus, fallbackStatus: string): string {
  if (status === "pending") return "pending_sync";
  if (status === "replaying") return "syncing";
  if (status === "failed") return "sync_failed";
  if (status === "discarded") return "sync_discarded";
  return fallbackStatus || "synced";
}

function replaceQueueItem(
  items: OfflineQueuedInteraction[],
  replacement: OfflineQueuedInteraction
): OfflineQueuedInteraction[] {
  let replaced = false;
  const nextItems = items.map((item) => {
    if (item.queueId !== replacement.queueId) return item;
    replaced = true;
    return replacement;
  });
  if (!replaced) nextItems.push(replacement);
  return sortQueueItems(nextItems);
}

function sortQueueItems(items: OfflineQueuedInteraction[]): OfflineQueuedInteraction[] {
  return [...items].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created || left.queueId.localeCompare(right.queueId);
  });
}

function createQueueId(intent: ServiceInteractionIntent, timestamp: string): string {
  const randomPart =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `offline-${stableSuffix([intent.serviceDocId, intent.interactionType, timestamp, randomPart].join("|"))}`;
}

function timestampString(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  const trimmed = clean(value);
  return trimmed || new Date().toISOString();
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "Offline replay failed.";
  return raw.replace(/\s+/g, " ").trim().slice(0, 240) || "Offline replay failed.";
}

function compactMetadata(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    })
  );
}

function cloneIntent(intent: ServiceInteractionIntent): ServiceInteractionIntent {
  return cloneJson(intent);
}

function cloneQueuedInteraction(item: OfflineQueuedInteraction): OfflineQueuedInteraction {
  return cloneJson(item);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => stringValue(item)).filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableSuffix(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
