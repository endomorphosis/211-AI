import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarClock, ExternalLink, Plus, Save, Trash2 } from "lucide-react";
import { Badge, Button, Field, Section, StatusBanner } from "../components/ui";
import { ServicePlanSharingPanel } from "../components/services/ServicePlanSharingPanel";
import { load211DocumentsByReference, type CorpusDocument } from "../lib/graphrag";
import type { DisclosureRecipientDraft, SavedService, ServicePlan, WalletGrantReceipt } from "../models/abby";
import {
  addTextDocument,
  createWalletServicePlan,
  decryptRecordWithGrant,
  saveWalletService,
  updateWalletServicePlan,
  type WalletApiConfig
} from "../services/walletApi";

const servicePlanPrefix = "#/services/";
const localNotesStorageKey = "abby-local-service-plan-notes-v1";

type ChecklistName = "steps" | "documents_needed" | "questions_to_ask";

type ChecklistItem = {
  id: string;
  done: boolean;
  label: string;
};

type PlanDraft = {
  assignedWorkerRecipientId: string;
  appointmentAt: string;
  documents_needed: ChecklistItem[];
  goal: string;
  questions_to_ask: ChecklistItem[];
  reminderAt: string;
  status: string;
  steps: ChecklistItem[];
  travelTarget: string;
};

type ServiceReference = {
  providerName: string;
  serviceDocId: string;
  sourceContentCid: string;
  sourcePageCid: string;
  sourceUrl: string;
  title: string;
};

type PlanPersistenceInput = {
  assignedWorkerRecipientId: string;
  appointmentAt: string;
  documentsNeeded: string[];
  goal: string;
  privateNotesRecordId: string;
  providerName: string;
  questionsToAsk: string[];
  reminderAt: string;
  serviceTitle: string;
  sourceContentCid: string;
  sourcePageCid: string;
  status: string;
  steps: string[];
  travelTarget: string;
};

const checklistSections: Array<{ name: ChecklistName; title: string; addLabel: string }> = [
  { name: "steps", title: "Steps", addLabel: "step" },
  { name: "documents_needed", title: "Documents needed", addLabel: "document" },
  { name: "questions_to_ask", title: "Questions to ask", addLabel: "question" }
];

export function getServicePlanDocIdFromHash(
  hash = typeof window === "undefined" ? "" : window.location.hash
): string | null {
  if (!hash.startsWith(servicePlanPrefix)) return null;
  const parts = hash.slice(servicePlanPrefix.length).split("/");
  if (parts[1] !== "plan" || !parts[0]) return null;
  try {
    return decodeURIComponent(parts[0]);
  } catch {
    return parts[0];
  }
}

export function servicePlanRouteHash(docId: string): string {
  return `${servicePlanPrefix}${encodeURIComponent(docId.trim())}/plan`;
}

export function setLocationServicePlanHash(docId: string): void {
  if (typeof window === "undefined") return;
  window.location.hash = servicePlanRouteHash(docId);
}

export function ServicePlanScreen({
  apiConfig,
  docId,
  grantReceipts,
  onBack,
  onOpenDetail,
  recipients,
  refreshWalletPortalState,
  savedServices,
  servicePlans,
  setGrantReceipts,
  setSavedServices,
  setServicePlans
}: {
  apiConfig?: WalletApiConfig;
  docId: string;
  grantReceipts?: WalletGrantReceipt[];
  onBack: () => void;
  onOpenDetail: (docId: string) => void;
  recipients?: DisclosureRecipientDraft[];
  refreshWalletPortalState?: () => Promise<void>;
  savedServices: SavedService[];
  servicePlans: ServicePlan[];
  setGrantReceipts?: (receipts: WalletGrantReceipt[]) => void;
  setSavedServices: (services: SavedService[]) => void;
  setServicePlans: (plans: ServicePlan[]) => void;
}) {
  const [document, setDocument] = useState<CorpusDocument | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const currentPlan = useMemo(() => latestPlanForService(servicePlans, docId), [docId, servicePlans]);
  const savedService = useMemo(
    () => savedServices.find((service) => service.service_doc_id === docId),
    [docId, savedServices]
  );
  const reference = useMemo(() => toServiceReference(docId, document, savedService, currentPlan), [
    currentPlan,
    docId,
    document,
    savedService
  ]);
  const [draft, setDraft] = useState<PlanDraft>(() => draftFromPlan(currentPlan));
  const [newItems, setNewItems] = useState<Record<ChecklistName, string>>({
    documents_needed: "",
    questions_to_ask: "",
    steps: ""
  });
  const [privateNotes, setPrivateNotes] = useState("");
  const [notesDirty, setNotesDirty] = useState(false);
  const [noteRecordId, setNoteRecordId] = useState("");
  const [busyAction, setBusyAction] = useState<"plan" | "service" | "notes" | "">("");
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "info"; text: string } | null>(null);

  useEffect(() => {
    let canceled = false;
    setLoadState("loading");
    setLoadError("");
    load211DocumentsByReference(docId, { limit: 4 })
      .then((documentsState) => {
        if (canceled) return;
        const match =
          documentsState.documentById.get(docId) ??
          documentsState.documentByContentCid.get(docId) ??
          documentsState.documents.find((item) => item.source_page_cid === docId) ??
          null;
        setDocument(match);
        setLoadState("ready");
      })
      .catch((error) => {
        if (canceled) return;
        setDocument(null);
        setLoadState("error");
        setLoadError(error instanceof Error ? error.message : "Service record unavailable");
      });
    return () => {
      canceled = true;
    };
  }, [docId]);

  useEffect(() => {
    setDraft(draftFromPlan(currentPlan));
  }, [currentPlan?.plan_id]);

  useEffect(() => {
    let canceled = false;
    const recordId = currentPlan?.private_notes_record_id || savedService?.private_notes_record_id || "";
    setNoteRecordId(recordId);
    setNotesDirty(false);
    setMessage(null);

    if (!recordId) {
      setPrivateNotes("");
      return;
    }

    setBusyAction("notes");
    if (apiConfig?.actorDid) {
      decryptRecordWithGrant(apiConfig, { recordId })
        .then((record) => {
          if (canceled) return;
          setPrivateNotes(record.text);
          setMessage({ tone: "info", text: "Encrypted notes restored from the wallet." });
        })
        .catch(() => {
          if (canceled) return;
          setPrivateNotes("");
          setMessage({ tone: "warning", text: "Encrypted notes are saved, but this session cannot decrypt them." });
        })
        .finally(() => {
          if (!canceled) setBusyAction("");
        });
      return () => {
        canceled = true;
      };
    }

    setPrivateNotes(readLocalNote(recordId));
    setMessage({ tone: "info", text: "Local demo notes restored on this browser." });
    setBusyAction("");
    return () => {
      canceled = true;
    };
  }, [
    apiConfig?.actorDid,
    apiConfig?.apiBaseUrl,
    apiConfig?.audienceKeyHex,
    apiConfig?.issuerKeyHex,
    apiConfig?.walletId,
    currentPlan?.private_notes_record_id,
    savedService?.private_notes_record_id
  ]);

  function updateDraft(patch: Partial<PlanDraft>) {
    setDraft({ ...draft, ...patch });
    setMessage(null);
  }

  function addChecklistItem(name: ChecklistName) {
    const label = newItems[name].trim();
    if (!label) return;
    const current = draft[name];
    if (current.some((item) => item.label.toLowerCase() === label.toLowerCase())) {
      setNewItems({ ...newItems, [name]: "" });
      return;
    }
    updateDraft({ [name]: [...current, toChecklistItem(label, false)] } as Partial<PlanDraft>);
    setNewItems({ ...newItems, [name]: "" });
  }

  function toggleChecklistItem(name: ChecklistName, itemId: string) {
    updateDraft({
      [name]: draft[name].map((item) => (item.id === itemId ? { ...item, done: !item.done } : item))
    } as Partial<PlanDraft>);
  }

  function removeChecklistItem(name: ChecklistName, itemId: string) {
    updateDraft({ [name]: draft[name].filter((item) => item.id !== itemId) } as Partial<PlanDraft>);
  }

  async function saveService() {
    setBusyAction("service");
    setMessage(null);
    try {
      const nextSaved =
        apiConfig?.actorDid
          ? await saveWalletService(apiConfig, {
              serviceDocId: reference.serviceDocId,
              sourceContentCid: reference.sourceContentCid,
              sourcePageCid: reference.sourcePageCid,
              sourceUrl: reference.sourceUrl,
              label: reference.title,
              providerName: reference.providerName,
              title: reference.title,
              privateNotesRecordId: noteRecordId || undefined,
              priority: savedService?.priority || "normal",
              reason: savedService?.reason || "",
              status: savedService?.status || "saved"
            })
          : createLocalSavedService(reference, noteRecordId, apiConfig?.walletId);
      setSavedServices(upsertSavedService(savedServices, nextSaved));
      await refreshWalletPortalState?.().catch(() => undefined);
      setMessage({ tone: "success", text: "Service saved." });
    } catch (error) {
      setMessage({ tone: "warning", text: error instanceof Error ? error.message : "Service could not be saved." });
    } finally {
      setBusyAction("");
    }
  }

  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("plan");
    setMessage(null);
    try {
      const nextNoteRecordId = await persistPrivateNotes(reference, privateNotes, notesDirty, currentPlan, savedService, apiConfig);
      const planInput = {
        assignedWorkerRecipientId: draft.assignedWorkerRecipientId.trim(),
        appointmentAt: draft.appointmentAt.trim(),
        documentsNeeded: serializeChecklist(draft.documents_needed),
        goal: draft.goal.trim(),
        privateNotesRecordId: nextNoteRecordId,
        providerName: reference.providerName,
        questionsToAsk: serializeChecklist(draft.questions_to_ask),
        reminderAt: draft.reminderAt.trim(),
        serviceTitle: reference.title,
        sourceContentCid: reference.sourceContentCid,
        sourcePageCid: reference.sourcePageCid,
        status: draft.status || "active",
        steps: serializeChecklist(draft.steps),
        travelTarget: draft.travelTarget.trim()
      };
      const nextPlan =
        apiConfig?.actorDid
          ? currentPlan
            ? await updateWalletServicePlan(apiConfig, currentPlan.plan_id, planInput)
            : await createWalletServicePlan(apiConfig, {
                serviceDocId: reference.serviceDocId,
                ...planInput
              })
          : currentPlan
            ? updateLocalServicePlan(currentPlan, planInput, reference)
            : createLocalServicePlan(reference, planInput, apiConfig?.walletId);
      setServicePlans(upsertServicePlan(servicePlans, nextPlan));
      setDraft(draftFromPlan(nextPlan));
      setNoteRecordId(nextNoteRecordId);
      setNotesDirty(false);

      if (savedService && nextNoteRecordId && nextNoteRecordId !== savedService.private_notes_record_id) {
        const updatedSaved =
          apiConfig?.actorDid
            ? await saveWalletService(apiConfig, {
                serviceDocId: savedService.service_doc_id,
                sourceContentCid: savedService.source_content_cid,
                sourcePageCid: savedService.source_page_cid,
                sourceUrl: savedService.source_url,
                label: savedService.label,
                providerName: savedService.provider_name,
                programName: savedService.program_name,
                title: savedService.title,
                privateNotesRecordId: nextNoteRecordId,
                priority: savedService.priority,
                reason: savedService.reason,
                status: savedService.status
              })
            : { ...savedService, private_notes_record_id: nextNoteRecordId, updated_at: new Date().toISOString() };
        setSavedServices(upsertSavedService(savedServices, updatedSaved));
      }

      await refreshWalletPortalState?.().catch(() => undefined);
      setMessage({ tone: "success", text: nextNoteRecordId ? "Plan and encrypted notes saved." : "Plan saved." });
    } catch (error) {
      setMessage({ tone: "warning", text: error instanceof Error ? error.message : "Plan could not be saved." });
    } finally {
      setBusyAction("");
    }
  }

  const planExists = Boolean(currentPlan);
  const checklistCount =
    draft.steps.length + draft.documents_needed.length + draft.questions_to_ask.length;
  const completedCount =
    draft.steps.filter((item) => item.done).length +
    draft.documents_needed.filter((item) => item.done).length +
    draft.questions_to_ask.filter((item) => item.done).length;

  return (
    <div className="screen">
      <div className="page-title">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          Services
        </Button>
        <p className="eyebrow">Service plan</p>
        <h1>{reference.title}</h1>
      </div>

      {loadState === "error" ? <StatusBanner tone="warning">Service source could not load: {loadError}</StatusBanner> : null}
      {message ? <StatusBanner tone={message.tone}>{message.text}</StatusBanner> : null}

      <Section title="Selected service">
        <article className="list-item">
          <div>
            <h3>{reference.providerName || "Provider not listed"}</h3>
            <p>{reference.serviceDocId}</p>
            <div className="badge-row">
              <Badge tone={savedService ? "success" : "neutral"}>{savedService ? "saved" : "not saved"}</Badge>
              <Badge tone={planExists ? "success" : "neutral"}>{planExists ? "plan ready" : "no plan yet"}</Badge>
              {noteRecordId ? <Badge tone="success">encrypted notes</Badge> : null}
            </div>
          </div>
          <div className="row-actions list-item-action">
            {reference.sourceUrl ? (
              <a className="button button-secondary" href={reference.sourceUrl} rel="noreferrer" target="_blank">
                <ExternalLink aria-hidden="true" size={18} />
                Source
              </a>
            ) : null}
            <Button onClick={() => onOpenDetail(reference.serviceDocId)} variant="secondary">
              Open detail
            </Button>
            <Button loading={busyAction === "service"} loadingLabel="Saving" onClick={() => void saveService()}>
              <Save aria-hidden="true" size={18} />
              Save service
            </Button>
          </div>
        </article>
      </Section>

      <form className="form-grid" onSubmit={savePlan}>
        <Section title="Plan details">
          <div className="form-grid">
            <Field label="Goal">
              <input
                placeholder="Call, apply, visit, or gather documents"
                value={draft.goal}
                onChange={(event) => updateDraft({ goal: event.target.value })}
              />
            </Field>
            <Field label="Travel or contact target">
              <input
                placeholder="Phone call, website, address, or transit note"
                value={draft.travelTarget}
                onChange={(event) => updateDraft({ travelTarget: event.target.value })}
              />
            </Field>
            <Field label="Appointment">
              <input
                type="datetime-local"
                value={draft.appointmentAt}
                onChange={(event) => updateDraft({ appointmentAt: event.target.value })}
              />
            </Field>
            <Field label="Reminder">
              <input
                type="datetime-local"
                value={draft.reminderAt}
                onChange={(event) => updateDraft({ reminderAt: event.target.value })}
              />
            </Field>
            <Field label="Plan status">
              <select value={draft.status} onChange={(event) => updateDraft({ status: event.target.value })}>
                <option value="active">Active</option>
                <option value="in_progress">In progress</option>
                <option value="waiting">Waiting</option>
                <option value="completed">Completed</option>
              </select>
            </Field>
            <Field label="Assigned worker or advocate">
              <input
                placeholder="Recipient ID or helper name"
                value={draft.assignedWorkerRecipientId}
                onChange={(event) => updateDraft({ assignedWorkerRecipientId: event.target.value })}
              />
            </Field>
          </div>
        </Section>

        <Section
          actions={
            checklistCount ? (
              <Badge tone={completedCount === checklistCount ? "success" : "info"}>
                {completedCount} of {checklistCount} done
              </Badge>
            ) : null
          }
          title="Checklist"
        >
          {checklistSections.map((section) => (
            <div className="review-panel" key={section.name}>
              <h3>{section.title}</h3>
              {draft[section.name].length ? (
                <div className="list-stack">
                  {draft[section.name].map((item) => (
                    <article className="list-item" key={item.id}>
                      <label style={{ alignItems: "center", display: "flex", flex: 1, gap: 12, minWidth: 0 }}>
                        <input
                          checked={item.done}
                          onChange={() => toggleChecklistItem(section.name, item.id)}
                          type="checkbox"
                        />
                        <span>
                          <strong>{item.label}</strong>
                        </span>
                      </label>
                      <Button
                        ariaLabel={`Remove ${item.label}`}
                        onClick={() => removeChecklistItem(section.name, item.id)}
                        variant="quiet"
                      >
                        <Trash2 aria-hidden="true" size={18} />
                      </Button>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="supporting-copy">No {section.addLabel}s added.</p>
              )}
              <div className="form-grid">
                <Field label={`Add ${section.addLabel}`}>
                  <input
                    value={newItems[section.name]}
                    onChange={(event) => setNewItems({ ...newItems, [section.name]: event.target.value })}
                  />
                </Field>
                <div className="row-actions">
                  <Button onClick={() => addChecklistItem(section.name)} variant="secondary">
                    <Plus aria-hidden="true" size={18} />
                    Add {section.addLabel}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </Section>

        <Section title="Encrypted private notes">
          <Field
            help={
              apiConfig?.actorDid
                ? "Notes are stored as restricted wallet records and linked by record ID."
                : "Local demo notes are stored in this browser. Connect a wallet API for encrypted wallet storage."
            }
            label="Notes"
          >
            <textarea
              value={privateNotes}
              onChange={(event) => {
                setPrivateNotes(event.target.value);
                setNotesDirty(true);
                setMessage(null);
              }}
            />
          </Field>
          {noteRecordId ? (
            <article className="list-item">
              <div>
                <h3>Notes record</h3>
                <p style={{ overflowWrap: "anywhere" }}>{noteRecordId}</p>
              </div>
              <Badge tone="success">restricted</Badge>
            </article>
          ) : null}
        </Section>

        <div className="row-actions">
          <Button loading={busyAction === "plan"} loadingLabel="Saving plan" type="submit">
            <CalendarClock aria-hidden="true" size={18} />
            {planExists ? "Save plan" : "Create plan"}
          </Button>
        </div>
      </form>

      <ServicePlanSharingPanel
        apiConfig={apiConfig}
        grantReceipts={grantReceipts}
        onShared={(result) => {
          if (result.plan) {
            setServicePlans(upsertServicePlan(servicePlans, result.plan));
          }
          if (result.receipt && setGrantReceipts) {
            setGrantReceipts([result.receipt, ...(grantReceipts || []).filter((item) => item.id !== result.receipt?.id)]);
          }
          setMessage({ tone: "success", text: "Worker grant created and logged." });
          void refreshWalletPortalState?.().catch(() => undefined);
        }}
        plan={currentPlan}
        recipients={recipients}
      />
    </div>
  );
}

function latestPlanForService(plans: ServicePlan[], docId: string): ServicePlan | undefined {
  return [...plans]
    .filter((plan) => plan.service_doc_id === docId)
    .sort((left, right) => (right.updated_at || right.created_at).localeCompare(left.updated_at || left.created_at))[0];
}

function toServiceReference(
  docId: string,
  document: CorpusDocument | null,
  savedService: SavedService | undefined,
  plan: ServicePlan | undefined
): ServiceReference {
  const title =
    document?.program_name ||
    document?.provider_name ||
    document?.title ||
    savedService?.program_name ||
    savedService?.title ||
    plan?.service_title ||
    docId;
  return {
    providerName: document?.provider_name || savedService?.provider_name || plan?.provider_name || "",
    serviceDocId: document?.doc_id || savedService?.service_doc_id || plan?.service_doc_id || docId,
    sourceContentCid:
      document?.source_content_cid ||
      savedService?.source_content_cid ||
      plan?.source_content_cid ||
      `ui-unresolved-${stableSuffix(docId)}`,
    sourcePageCid: document?.source_page_cid || savedService?.source_page_cid || plan?.source_page_cid || "",
    sourceUrl: document?.source_url || savedService?.source_url || "",
    title
  };
}

function draftFromPlan(plan: ServicePlan | undefined): PlanDraft {
  return {
    assignedWorkerRecipientId: plan?.assigned_worker_recipient_id || "",
    appointmentAt: toDatetimeLocalValue(plan?.appointment_at || ""),
    documents_needed: parseChecklist(plan?.documents_needed || []),
    goal: plan?.goal || "",
    questions_to_ask: parseChecklist(plan?.questions_to_ask || []),
    reminderAt: toDatetimeLocalValue(plan?.reminder_at || ""),
    status: plan?.status || "active",
    steps: parseChecklist(plan?.steps || []),
    travelTarget: plan?.travel_target || ""
  };
}

function parseChecklist(values: string[]): ChecklistItem[] {
  return values.map((value, index) => {
    const trimmed = value.trim();
    const done = /^\[x\]\s*/i.test(trimmed);
    const label = trimmed.replace(/^\[(x|\s)\]\s*/i, "").trim() || trimmed;
    return {
      done,
      id: `${index}-${stableSuffix(trimmed || label)}`,
      label
    };
  });
}

function serializeChecklist(items: ChecklistItem[]): string[] {
  return items
    .map((item) => item.label.trim())
    .filter(Boolean)
    .map((label, index) => {
      const item = items.filter((candidate) => candidate.label.trim())[index];
      return `${item?.done ? "[x]" : "[ ]"} ${label}`;
    });
}

function toChecklistItem(label: string, done: boolean): ChecklistItem {
  return {
    done,
    id: `${Date.now().toString(36)}-${stableSuffix(label)}`,
    label
  };
}

async function persistPrivateNotes(
  reference: ServiceReference,
  notes: string,
  notesDirty: boolean,
  currentPlan: ServicePlan | undefined,
  savedService: SavedService | undefined,
  apiConfig: WalletApiConfig | undefined
): Promise<string> {
  const existingRecordId = currentPlan?.private_notes_record_id || savedService?.private_notes_record_id || "";
  if (!notesDirty) return existingRecordId;
  const trimmedNotes = notes.trim();
  if (!trimmedNotes) return "";

  if (apiConfig?.actorDid) {
    const record = await addTextDocument(apiConfig, {
      filename: `service-plan-${stableSuffix(reference.serviceDocId)}-notes.txt`,
      text: notes,
      title: `Private notes for ${reference.title}`
    });
    return record.recordId || record.id;
  }

  const recordId = existingRecordId || `local-note-${Date.now().toString(36)}-${stableSuffix(reference.serviceDocId)}`;
  writeLocalNote(recordId, notes);
  return recordId;
}

function createLocalSavedService(
  reference: ServiceReference,
  privateNotesRecordId: string,
  walletId = "local-wallet"
): SavedService {
  const now = new Date().toISOString();
  return {
    created_at: now,
    label: reference.title,
    metadata: { staged_local: true },
    priority: "normal",
    private_notes_record_id: privateNotesRecordId,
    program_name: reference.title,
    provider_name: reference.providerName,
    reason: "",
    saved_service_id: `saved-local-${stableSuffix(reference.serviceDocId)}`,
    service_doc_id: reference.serviceDocId,
    source_content_cid: reference.sourceContentCid,
    source_page_cid: reference.sourcePageCid,
    source_url: reference.sourceUrl,
    status: "saved",
    title: reference.title,
    updated_at: now,
    wallet_id: walletId
  };
}

function createLocalServicePlan(
  reference: ServiceReference,
  input: PlanPersistenceInput,
  walletId = "local-wallet"
): ServicePlan {
  const now = new Date().toISOString();
  return {
    appointment_at: input.appointmentAt,
    assigned_worker_recipient_id: input.assignedWorkerRecipientId,
    created_at: now,
    documents_needed: input.documentsNeeded,
    goal: input.goal,
    plan_id: `plan-local-${Date.now().toString(36)}-${stableSuffix(reference.serviceDocId)}`,
    private_notes_record_id: input.privateNotesRecordId,
    provider_name: input.providerName,
    questions_to_ask: input.questionsToAsk,
    related_interaction_ids: [],
    reminder_at: input.reminderAt,
    service_doc_id: reference.serviceDocId,
    service_title: input.serviceTitle,
    source_content_cid: input.sourceContentCid,
    source_page_cid: input.sourcePageCid,
    status: input.status,
    steps: input.steps,
    travel_target: input.travelTarget,
    updated_at: now,
    wallet_id: walletId
  };
}

function updateLocalServicePlan(
  plan: ServicePlan,
  input: PlanPersistenceInput,
  reference: ServiceReference
): ServicePlan {
  return {
    ...plan,
    appointment_at: input.appointmentAt,
    assigned_worker_recipient_id: input.assignedWorkerRecipientId,
    documents_needed: input.documentsNeeded,
    goal: input.goal,
    private_notes_record_id: input.privateNotesRecordId,
    provider_name: input.providerName,
    questions_to_ask: input.questionsToAsk,
    reminder_at: input.reminderAt,
    service_title: input.serviceTitle,
    source_content_cid: input.sourceContentCid || reference.sourceContentCid,
    source_page_cid: input.sourcePageCid || reference.sourcePageCid,
    status: input.status,
    steps: input.steps,
    travel_target: input.travelTarget,
    updated_at: new Date().toISOString()
  };
}

function upsertServicePlan(plans: ServicePlan[], plan: ServicePlan): ServicePlan[] {
  return [plan, ...plans.filter((item) => item.plan_id !== plan.plan_id)];
}

function upsertSavedService(services: SavedService[], service: SavedService): SavedService[] {
  return [service, ...services.filter((item) => item.saved_service_id !== service.saved_service_id)];
}

function readLocalNote(recordId: string): string {
  if (typeof window === "undefined") return "";
  try {
    const notes = JSON.parse(window.localStorage.getItem(localNotesStorageKey) || "{}") as Record<string, string>;
    return decodeLocalNote(notes[recordId] || "");
  } catch {
    return "";
  }
}

function writeLocalNote(recordId: string, note: string): void {
  if (typeof window === "undefined") return;
  try {
    const notes = JSON.parse(window.localStorage.getItem(localNotesStorageKey) || "{}") as Record<string, string>;
    notes[recordId] = encodeLocalNote(note);
    window.localStorage.setItem(localNotesStorageKey, JSON.stringify(notes));
  } catch {
    window.localStorage.setItem(localNotesStorageKey, JSON.stringify({ [recordId]: encodeLocalNote(note) }));
  }
}

function encodeLocalNote(note: string): string {
  return window.btoa(unescape(encodeURIComponent(note)));
}

function decodeLocalNote(note: string): string {
  if (!note) return "";
  try {
    return decodeURIComponent(escape(window.atob(note)));
  } catch {
    return "";
  }
}

function toDatetimeLocalValue(value: string): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}

function stableSuffix(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
