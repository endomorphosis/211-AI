import { useMemo, useState } from "react";
import {
  CalendarClock,
  ExternalLink,
  Filter,
  RefreshCw,
  RotateCcw,
  ShieldCheck
} from "lucide-react";
import type {
  AuditEvent,
  DisclosureRecipientDraft,
  ProofReceiptView,
  SavedService,
  ServiceInteractionEvent,
  ServicePlan,
  UploadItem,
  WalletAccessRequest,
  WalletGrantReceipt
} from "../../models/abby";
import { Badge, Button, Field, Section, StatusBanner } from "../ui";

export type InteractionTimeFilter = "all" | "today" | "past_7_days" | "past_30_days" | "follow_up_due" | "custom";

export interface InteractionTimelineFilters {
  fromDate: string;
  serviceDocId: string;
  status: string;
  time: InteractionTimeFilter;
  toDate: string;
  worker: string;
}

export interface InteractionTimelineContext {
  now?: Date | string;
  servicePlans?: ServicePlan[];
}

export interface InteractionTimelinePrivacySummary {
  auditEventCount: number;
  grantReferenceCount: number;
  privateNoteReferenceCount: number;
  proofReceiptCount: number;
  protectedRecordReferenceCount: number;
  uploadReferenceCount: number;
}

interface InteractionTimelineSummary {
  appointmentCount: number;
  followUpCount: number;
  overdueFollowUpCount: number;
  serviceCount: number;
}

interface InteractionDayGroup {
  dayKey: string;
  items: ServiceInteractionEvent[];
  label: string;
}

type ServiceOption = {
  id: string;
  label: string;
};

type WorkerOption = {
  id: string;
  label: string;
};

const defaultFilters: InteractionTimelineFilters = {
  fromDate: "",
  serviceDocId: "",
  status: "",
  time: "all",
  toDate: "",
  worker: ""
};

export function filterInteractionTimelineEvents(
  interactions: ServiceInteractionEvent[],
  filters: Partial<InteractionTimelineFilters> = {},
  context: InteractionTimelineContext = {}
): ServiceInteractionEvent[] {
  const mergedFilters = { ...defaultFilters, ...filters };
  const now = normalizeDate(context.now) ?? new Date();
  return interactions
    .filter((interaction) => matchesServiceFilter(interaction, mergedFilters.serviceDocId))
    .filter((interaction) => matchesWorkerFilter(interaction, mergedFilters.worker, context.servicePlans ?? []))
    .filter((interaction) => matchesStatusFilter(interaction, mergedFilters.status))
    .filter((interaction) => matchesTimeFilter(interaction, mergedFilters, now))
    .sort(compareInteractionsDescending);
}

export function getInteractionTimelinePrivacySummary({
  auditEvents = [],
  grantReceipts = [],
  interactions,
  proofReceipts = [],
  uploads = []
}: {
  auditEvents?: AuditEvent[];
  grantReceipts?: WalletGrantReceipt[];
  interactions: ServiceInteractionEvent[];
  proofReceipts?: ProofReceiptView[];
  uploads?: UploadItem[];
}): InteractionTimelinePrivacySummary {
  const uploadRecordIds = new Set(uploads.map((upload) => upload.recordId || upload.id).filter(Boolean));
  const referencedRecords = uniqueStrings(interactions.flatMap((interaction) => interaction.related_record_ids ?? []));
  const referencedGrants = uniqueStrings(interactions.flatMap((interaction) => interaction.related_grant_ids ?? []));

  return {
    auditEventCount: auditEvents.length,
    grantReferenceCount: Math.max(referencedGrants.length, grantReceipts.length),
    privateNoteReferenceCount: interactions.filter((interaction) => Boolean(interaction.notes_record_id)).length,
    proofReceiptCount: proofReceipts.length,
    protectedRecordReferenceCount: referencedRecords.length,
    uploadReferenceCount: referencedRecords.filter((recordId) => uploadRecordIds.has(recordId)).length
  };
}

export function InteractionTimeline({
  accessRequests = [],
  auditEvents = [],
  error = "",
  grantReceipts = [],
  interactions,
  loading = false,
  onOpenPlan,
  onOpenService,
  onRefresh,
  proofReceipts = [],
  recipients = [],
  savedServices = [],
  servicePlans = [],
  uploads = []
}: {
  accessRequests?: WalletAccessRequest[];
  auditEvents?: AuditEvent[];
  error?: string;
  grantReceipts?: WalletGrantReceipt[];
  interactions: ServiceInteractionEvent[];
  loading?: boolean;
  onOpenPlan?: (docId: string) => void;
  onOpenService?: (docId: string) => void;
  onRefresh?: () => void;
  proofReceipts?: ProofReceiptView[];
  recipients?: DisclosureRecipientDraft[];
  savedServices?: SavedService[];
  servicePlans?: ServicePlan[];
  uploads?: UploadItem[];
}) {
  const [filters, setFilters] = useState<InteractionTimelineFilters>(defaultFilters);
  const serviceOptions = useMemo(
    () => buildServiceOptions(interactions, savedServices, servicePlans),
    [interactions, savedServices, servicePlans]
  );
  const workerOptions = useMemo(
    () => buildWorkerOptions(interactions, servicePlans, recipients),
    [interactions, recipients, servicePlans]
  );
  const statusOptions = useMemo(() => uniqueStrings(interactions.map((interaction) => interaction.status).filter(Boolean)), [
    interactions
  ]);
  const filteredInteractions = useMemo(
    () => filterInteractionTimelineEvents(interactions, filters, { servicePlans }),
    [filters, interactions, servicePlans]
  );
  const now = useMemo(() => new Date(), []);
  const privacySummary = useMemo(
    () =>
      getInteractionTimelinePrivacySummary({
        auditEvents,
        grantReceipts,
        interactions: filteredInteractions,
        proofReceipts,
        uploads
      }),
    [auditEvents, filteredInteractions, grantReceipts, proofReceipts, uploads]
  );
  const timelineSummary = useMemo(
    () => getInteractionTimelineSummary({ interactions: filteredInteractions, now, servicePlans }),
    [filteredInteractions, now, servicePlans]
  );
  const interactionGroups = useMemo(() => groupInteractionsByDay(filteredInteractions, now), [filteredInteractions, now]);
  const calendarPreview = useMemo(() => buildCalendarPreview(filteredInteractions, now), [filteredInteractions, now]);
  const requestCount = accessRequests.length;

  function updateFilter(patch: Partial<InteractionTimelineFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function resetFilters() {
    setFilters(defaultFilters);
  }

  return (
    <Section
      actions={
        onRefresh ? (
          <Button
            ariaLabel="Refresh interactions"
            loading={loading}
            loadingLabel="Refreshing"
            onClick={onRefresh}
            variant="quiet"
          >
            <RefreshCw aria-hidden="true" size={18} />
          </Button>
        ) : null
      }
      title="Interaction timeline"
    >
      {error ? <StatusBanner tone="warning">Interactions could not refresh: {error}</StatusBanner> : null}
      <section className="interaction-summary-grid" aria-label="Interaction summary">
        <article className="interaction-summary-card">
          <span>Visible interactions</span>
          <strong>{filteredInteractions.length}</strong>
          <small>{interactions.length} total recorded for this wallet view.</small>
        </article>
        <article className="interaction-summary-card">
          <span>Services involved</span>
          <strong>{timelineSummary.serviceCount}</strong>
          <small>Unique services represented in the current timeline.</small>
        </article>
        <article className="interaction-summary-card">
          <span>Calendar carry-over</span>
          <strong>{timelineSummary.followUpCount + timelineSummary.appointmentCount}</strong>
          <small>{timelineSummary.followUpCount} follow-ups and {timelineSummary.appointmentCount} plan appointments.</small>
        </article>
        <article className="interaction-summary-card">
          <span>Follow-up due</span>
          <strong>{timelineSummary.overdueFollowUpCount}</strong>
          <small>Interactions that should already be visible on the calendar.</small>
        </article>
      </section>

      <div className="interaction-history-layout">
        <aside className="interaction-history-sidebar">
          <form
            aria-label="Interaction filters"
            className="review-panel interaction-filter-panel"
            onSubmit={(event) => event.preventDefault()}
          >
            <div>
              <h3>Filter timeline</h3>
              <p className="page-note">Refine the wallet-backed history by service, worker, status, or date range.</p>
            </div>
            <div className="form-grid">
              <Field label="Service">
                <select
                  value={filters.serviceDocId}
                  onChange={(event) => updateFilter({ serviceDocId: event.target.value })}
                >
                  <option value="">All services</option>
                  {serviceOptions.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Worker">
                <select value={filters.worker} onChange={(event) => updateFilter({ worker: event.target.value })}>
                  <option value="">All workers and counterparties</option>
                  {workerOptions.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select value={filters.status} onChange={(event) => updateFilter({ status: event.target.value })}>
                  <option value="">All statuses</option>
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>
                      {formatStatus(status)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Time">
                <select
                  value={filters.time}
                  onChange={(event) => updateFilter({ time: event.target.value as InteractionTimeFilter })}
                >
                  <option value="all">All time</option>
                  <option value="today">Today</option>
                  <option value="past_7_days">Past 7 days</option>
                  <option value="past_30_days">Past 30 days</option>
                  <option value="follow_up_due">Follow-up due</option>
                  <option value="custom">Custom range</option>
                </select>
              </Field>
            </div>
            {filters.time === "custom" ? (
              <div className="form-grid">
                <Field label="From">
                  <input
                    type="date"
                    value={filters.fromDate}
                    onChange={(event) => updateFilter({ fromDate: event.target.value })}
                  />
                </Field>
                <Field label="To">
                  <input
                    type="date"
                    value={filters.toDate}
                    onChange={(event) => updateFilter({ toDate: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}
            <div className="row-actions">
              <Badge tone="info">
                <Filter aria-hidden="true" size={14} />
                {filteredInteractions.length} of {interactions.length}
              </Badge>
              <Button onClick={resetFilters} variant="secondary">
                <RotateCcw aria-hidden="true" size={18} />
                Reset filters
              </Button>
            </div>
          </form>

          <div className="review-panel interaction-calendar-panel">
            <div>
              <h3>Calendar handoff</h3>
              <p className="page-note">
                Follow-up times recorded here feed the Calendar screen alongside scheduled plan appointments.
              </p>
            </div>
            {calendarPreview.length ? (
              <div className="interaction-calendar-preview-list">
                {calendarPreview.map((preview) => (
                  <article className="interaction-calendar-preview" key={preview.interaction_id}>
                    <strong>{preview.next_action || formatInteractionType(preview.interaction_type)}</strong>
                    <small>{serviceLabelForInteraction(preview, serviceOptions)}</small>
                    <small>{formatTimestamp(preview.next_follow_up_at || "")}</small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="page-note">No follow-up reminders are scheduled from the current interaction set.</p>
            )}
          </div>

          <div className="review-panel" aria-label="Safe audit metadata boundary">
            <div>
              <h3>Audit boundary</h3>
              <p className="page-note">
                Private notes and protected record or grant identifiers stay referenced, not expanded in this timeline.
              </p>
            </div>
            <div className="badge-row">
              <Badge tone="neutral">{privacySummary.auditEventCount} audit events</Badge>
              <Badge tone="neutral">{requestCount} worker requests</Badge>
              <Badge tone="success">
                <ShieldCheck aria-hidden="true" size={14} />
                {privacySummary.privateNoteReferenceCount} private note refs
              </Badge>
              <Badge tone="info">{privacySummary.protectedRecordReferenceCount} record refs</Badge>
              <Badge tone="info">{privacySummary.grantReferenceCount} grant refs</Badge>
              <Badge tone="neutral">{privacySummary.proofReceiptCount} proof receipts</Badge>
              <Badge tone="neutral">{privacySummary.uploadReferenceCount} upload refs</Badge>
            </div>
          </div>
        </aside>

        <div className="interaction-history-main">
          {!interactions.length ? (
            <StatusBanner tone="info">No service interactions have been recorded for this wallet yet.</StatusBanner>
          ) : null}
          {interactions.length && !filteredInteractions.length ? (
            <StatusBanner tone="info">No interactions match the selected filters.</StatusBanner>
          ) : null}
          {interactionGroups.length ? (
            <div className="timeline interaction-day-groups" aria-label="Service interaction timeline">
              {interactionGroups.map((group) => (
                <section className="interaction-day-group" key={group.dayKey}>
                  <div className="interaction-day-header">
                    <h3>{group.label}</h3>
                    <Badge tone="neutral">{group.items.length} events</Badge>
                  </div>
                  <div className="interaction-day-list">
                    {group.items.map((interaction) => (
                      <TimelineEvent
                        interaction={interaction}
                        key={interaction.interaction_id}
                        now={now}
                        onOpenPlan={onOpenPlan}
                        onOpenService={onOpenService}
                        serviceLabel={serviceLabelForInteraction(interaction, serviceOptions)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

function TimelineEvent({
  interaction,
  now,
  onOpenPlan,
  onOpenService,
  serviceLabel
}: {
  interaction: ServiceInteractionEvent;
  now: Date;
  onOpenPlan?: (docId: string) => void;
  onOpenService?: (docId: string) => void;
  serviceLabel: string;
}) {
  const protectedReferenceCount = (interaction.related_grant_ids?.length ?? 0) + (interaction.related_record_ids?.length ?? 0);
  const followUpAt = normalizeDate(interaction.next_follow_up_at);
  const hasOverdueFollowUp = Boolean(followUpAt && followUpAt.getTime() <= now.getTime());
  const detailParts = [interaction.counterparty_name, interaction.counterparty_contact].filter(Boolean);
  const metaItems = [
    { label: "When", value: formatTimestamp(interaction.timestamp || interaction.created_at) },
    detailParts.length ? { label: "Contact", value: detailParts.join(" · ") } : null,
    interaction.outcome ? { label: "Outcome", value: interaction.outcome } : null,
    interaction.next_action ? { label: "Next step", value: interaction.next_action } : null,
    followUpAt ? { label: hasOverdueFollowUp ? "Follow-up due" : "Follow-up scheduled", value: formatTimestamp(interaction.next_follow_up_at || "") } : null
  ].filter(Boolean) as Array<{ label: string; value: string }>;
  return (
    <article className={`timeline-event ${hasOverdueFollowUp ? "timeline-event-overdue" : ""}`}>
      <span aria-hidden="true" />
      <div className="interaction-event-shell">
        <div className="interaction-event-header">
          <div>
            <h3>{formatInteractionType(interaction.interaction_type)}</h3>
            <p>{serviceLabel}</p>
          </div>
          {hasOverdueFollowUp ? <Badge tone="warning">Follow-up due</Badge> : null}
        </div>
        <div className="badge-row">
          <Badge tone={toneForStatus(interaction.status)}>{formatStatus(interaction.status || "recorded")}</Badge>
          {interaction.channel ? <Badge tone="neutral">{formatStatus(interaction.channel)}</Badge> : null}
          <Badge tone={interaction.privacy_level === "restricted" ? "warning" : "success"}>
            {interaction.privacy_level || "private"}
          </Badge>
          {interaction.notes_record_id ? <Badge tone="success">private notes linked</Badge> : null}
          {protectedReferenceCount ? <Badge tone="info">{protectedReferenceCount} protected refs</Badge> : null}
          {interaction.source_content_cid ? <Badge tone="neutral">source {shortId(interaction.source_content_cid)}</Badge> : null}
        </div>
        <dl className="interaction-event-meta">
          {metaItems.map((item) => (
            <div key={`${interaction.interaction_id}-${item.label}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        {onOpenPlan || onOpenService ? (
          <div className="row-actions">
            {onOpenService ? (
              <Button onClick={() => onOpenService(interaction.service_doc_id)} variant="secondary">
                <ExternalLink aria-hidden="true" size={18} />
                Open service
              </Button>
            ) : null}
            {onOpenPlan ? (
              <Button onClick={() => onOpenPlan(interaction.service_doc_id)} variant="secondary">
                <CalendarClock aria-hidden="true" size={18} />
                Open plan
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function getInteractionTimelineSummary({
  interactions,
  now,
  servicePlans
}: {
  interactions: ServiceInteractionEvent[];
  now: Date;
  servicePlans: ServicePlan[];
}): InteractionTimelineSummary {
  const serviceCount = new Set(interactions.map((interaction) => interaction.service_doc_id).filter(Boolean)).size;
  const followUpDates = interactions.map((interaction) => normalizeDate(interaction.next_follow_up_at)).filter(Boolean) as Date[];
  const appointmentCount = servicePlans.filter((plan) => Boolean(normalizeDate(plan.appointment_at))).length;
  return {
    appointmentCount,
    followUpCount: followUpDates.length,
    overdueFollowUpCount: followUpDates.filter((date) => date.getTime() <= now.getTime()).length,
    serviceCount
  };
}

function groupInteractionsByDay(interactions: ServiceInteractionEvent[], now: Date): InteractionDayGroup[] {
  const groups = new Map<string, ServiceInteractionEvent[]>();

  for (const interaction of interactions) {
    const date = normalizeDate(interaction.timestamp || interaction.created_at) ?? new Date(0);
    const key = dayKey(date);
    const current = groups.get(key) ?? [];
    current.push(interaction);
    groups.set(key, current);
  }

  return Array.from(groups.entries())
    .map(([key, items]) => ({
      dayKey: key,
      items,
      label: formatTimelineDayLabel(key, now)
    }))
    .sort((left, right) => right.dayKey.localeCompare(left.dayKey));
}

function buildCalendarPreview(interactions: ServiceInteractionEvent[], now: Date): ServiceInteractionEvent[] {
  return interactions
    .filter((interaction) => Boolean(normalizeDate(interaction.next_follow_up_at)))
    .sort((left, right) => {
      const leftTime = normalizeDate(left.next_follow_up_at)?.getTime() ?? 0;
      const rightTime = normalizeDate(right.next_follow_up_at)?.getTime() ?? 0;
      const leftDistance = Math.abs(leftTime - now.getTime());
      const rightDistance = Math.abs(rightTime - now.getTime());
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.interaction_id.localeCompare(right.interaction_id);
    })
    .slice(0, 3);
}

function buildServiceOptions(
  interactions: ServiceInteractionEvent[],
  savedServices: SavedService[],
  servicePlans: ServicePlan[]
): ServiceOption[] {
  const options = new Map<string, string>();

  for (const service of savedServices) {
    options.set(service.service_doc_id, service.label || service.program_name || service.title || service.service_doc_id);
  }
  for (const plan of servicePlans) {
    options.set(plan.service_doc_id, plan.service_title || plan.provider_name || plan.service_doc_id);
  }
  for (const interaction of interactions) {
    if (!options.has(interaction.service_doc_id)) {
      options.set(
        interaction.service_doc_id,
        interaction.program_name || interaction.provider_name || interaction.service_doc_id
      );
    }
  }

  return Array.from(options.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function buildWorkerOptions(
  interactions: ServiceInteractionEvent[],
  servicePlans: ServicePlan[],
  recipients: DisclosureRecipientDraft[]
): WorkerOption[] {
  const recipientById = new Map(recipients.map((recipient) => [recipient.id, recipient]));
  const options = new Map<string, string>();

  for (const plan of servicePlans) {
    const workerId = plan.assigned_worker_recipient_id?.trim();
    if (!workerId) continue;
    const recipient = recipientById.get(workerId);
    options.set(workerId, recipient?.displayName || workerId);
  }

  for (const interaction of interactions) {
    const metadataWorkerId = stringFromMetadata(interaction.metadata, "worker_recipient_id");
    if (metadataWorkerId) {
      const recipient = recipientById.get(metadataWorkerId);
      options.set(metadataWorkerId, recipient?.displayName || metadataWorkerId);
    }
    const counterparty = interaction.counterparty_name || interaction.counterparty_contact;
    if (counterparty) {
      options.set(counterparty, counterparty);
    }
  }

  return Array.from(options.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function matchesServiceFilter(interaction: ServiceInteractionEvent, serviceDocId: string): boolean {
  return !serviceDocId || interaction.service_doc_id === serviceDocId;
}

function matchesWorkerFilter(interaction: ServiceInteractionEvent, worker: string, servicePlans: ServicePlan[]): boolean {
  const normalizedWorker = normalizeFilterText(worker);
  if (!normalizedWorker) return true;

  const tokens = new Set(
    [
      interaction.counterparty_name,
      interaction.counterparty_contact,
      stringFromMetadata(interaction.metadata, "worker_recipient_id"),
      stringFromMetadata(interaction.metadata, "worker_name"),
      stringFromMetadata(interaction.metadata, "audience_did"),
      ...servicePlans
        .filter((plan) => plan.service_doc_id === interaction.service_doc_id)
        .map((plan) => plan.assigned_worker_recipient_id)
    ]
      .map(normalizeFilterText)
      .filter(Boolean)
  );
  return tokens.has(normalizedWorker);
}

function matchesStatusFilter(interaction: ServiceInteractionEvent, status: string): boolean {
  return !status || interaction.status === status;
}

function matchesTimeFilter(
  interaction: ServiceInteractionEvent,
  filters: InteractionTimelineFilters,
  now: Date
): boolean {
  const interactionDate = normalizeDate(interaction.timestamp || interaction.created_at);
  if (filters.time === "all") return true;
  if (filters.time === "follow_up_due") {
    const followUp = normalizeDate(interaction.next_follow_up_at);
    return Boolean(followUp && followUp.getTime() <= now.getTime());
  }
  if (!interactionDate) return false;

  if (filters.time === "today") {
    return interactionDate >= startOfDay(now) && interactionDate <= endOfDay(now);
  }
  if (filters.time === "past_7_days") {
    return interactionDate.getTime() >= now.getTime() - 7 * 24 * 60 * 60 * 1000;
  }
  if (filters.time === "past_30_days") {
    return interactionDate.getTime() >= now.getTime() - 30 * 24 * 60 * 60 * 1000;
  }
  if (filters.time === "custom") {
    const fromDate = dateFromInput(filters.fromDate, false);
    const toDate = dateFromInput(filters.toDate, true);
    if (fromDate && interactionDate < fromDate) return false;
    if (toDate && interactionDate > toDate) return false;
  }
  return true;
}

function compareInteractionsDescending(left: ServiceInteractionEvent, right: ServiceInteractionEvent): number {
  const leftDate = normalizeDate(left.timestamp || left.created_at)?.getTime() ?? 0;
  const rightDate = normalizeDate(right.timestamp || right.created_at)?.getTime() ?? 0;
  if (leftDate !== rightDate) return rightDate - leftDate;
  return right.interaction_id.localeCompare(left.interaction_id);
}

function normalizeDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateFromInput(value: string, end: boolean): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
}

function endOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 23, 59, 59, 999);
}

function serviceLabelForInteraction(interaction: ServiceInteractionEvent, options: ServiceOption[]): string {
  return (
    options.find((option) => option.id === interaction.service_doc_id)?.label ||
    interaction.program_name ||
    interaction.provider_name ||
    interaction.service_doc_id
  );
}

function formatInteractionType(value: string): string {
  const labels: Record<string, string> = {
    appointment_completed: "Appointment completed",
    appointment_scheduled: "Appointment scheduled",
    called_provider: "Called provider",
    created_calendar_reminder: "Calendar reminder",
    emailed_provider: "Emailed provider",
    needs_follow_up: "Needs follow-up",
    opened_map: "Opened map",
    planned_visit: "Planned visit",
    provider_contacted_user: "Provider contacted user",
    saved_service: "Saved service",
    service_unavailable: "Service unavailable",
    shared_service: "Shared service",
    shared_service_plan: "Shared service plan",
    texted_provider: "Texted provider",
    uploaded_required_document: "Uploaded document",
    viewed_service: "Viewed service"
  };
  return labels[value] ?? formatStatus(value || "interaction");
}

function formatStatus(value: string): string {
  const cleaned = value.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "not set";
  return cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toneForStatus(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("failed") || normalized.includes("unavailable") || normalized.includes("revoked")) {
    return "warning";
  }
  if (normalized.includes("complete") || normalized.includes("scheduled") || normalized.includes("active")) {
    return "success";
  }
  if (normalized.includes("follow") || normalized.includes("handoff")) {
    return "info";
  }
  return "neutral";
}

function formatTimestamp(value: string): string {
  const date = normalizeDate(value);
  if (!date) return "Time not recorded";
  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatTimelineDayLabel(value: string, now: Date): string {
  const [year, month, day] = value.split("-").map((segment) => Number.parseInt(segment, 10));
  const date =
    Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
      ? new Date(year, month - 1, day)
      : undefined;
  if (!date) return value;
  const today = startOfDay(now);
  const candidate = startOfDay(date);
  const dayOffset = Math.round((today.getTime() - candidate.getTime()) / (24 * 60 * 60 * 1000));
  if (dayOffset === 0) return "Today";
  if (dayOffset === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    weekday: "long",
    year: "numeric"
  });
}

function shortId(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function stringFromMetadata(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFilterText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
