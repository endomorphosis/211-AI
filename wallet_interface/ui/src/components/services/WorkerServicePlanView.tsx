import { useMemo } from "react";
import { EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";
import type { ServicePlan, WalletGrantReceipt } from "../../models/abby";
import type { RecordGrantResponse } from "../../services/walletApi";
import { Badge, Button, Section, StatusBanner } from "../ui";

export type ServicePlanShareScope =
  | "service_summary"
  | "checklist"
  | "schedule"
  | "worker_assignment"
  | "interaction_history";

export type ServicePlanField =
  | "service_doc_id"
  | "source_content_cid"
  | "source_page_cid"
  | "service_title"
  | "provider_name"
  | "goal"
  | "status"
  | "steps"
  | "documents_needed"
  | "questions_to_ask"
  | "appointment_at"
  | "reminder_at"
  | "travel_target"
  | "assigned_worker_recipient_id"
  | "related_interaction_ids";

export type RedactedServicePlan = Partial<Record<ServicePlanField, string | string[]>>;

export type WorkerServicePlanGrant = WalletGrantReceipt | RecordGrantResponse;

type NormalizedWorkerServicePlanGrant = {
  abilities: string[];
  audienceDid: string;
  caveats: Record<string, unknown>;
  id: string;
  resources: string[];
  status: string;
};

const servicePlanShareScopeFields: Record<ServicePlanShareScope, ServicePlanField[]> = {
  service_summary: [
    "service_doc_id",
    "source_content_cid",
    "source_page_cid",
    "service_title",
    "provider_name",
    "goal",
    "status"
  ],
  checklist: ["steps", "documents_needed", "questions_to_ask"],
  schedule: ["appointment_at", "reminder_at", "travel_target"],
  worker_assignment: ["assigned_worker_recipient_id"],
  interaction_history: ["related_interaction_ids"]
};

const servicePlanFields = new Set<string>(Object.values(servicePlanShareScopeFields).flat());

export function WorkerServicePlanView({
  grant,
  grantId,
  grantReceipts = [],
  onRevokeGrant,
  plan,
  revokingGrantId = "",
  workerDid = ""
}: {
  grant?: RecordGrantResponse;
  grantId?: string;
  grantReceipts?: WalletGrantReceipt[];
  onRevokeGrant?: (grantId: string) => Promise<void> | void;
  plan?: ServicePlan;
  revokingGrantId?: string;
  workerDid?: string;
}) {
  const grants = useMemo(() => (grant ? [grant, ...grantReceipts] : grantReceipts), [grant, grantReceipts]);
  const activeGrant = useMemo(
    () => (plan ? selectActiveServicePlanGrant(plan, grants, { grantId, workerDid }) : undefined),
    [grantId, grants, plan, workerDid]
  );
  const revokedGrantCount = useMemo(
    () =>
      plan
        ? grants
            .map(normalizeWorkerServicePlanGrant)
            .filter(
              (candidate) =>
                candidate.status === "revoked" &&
                grantCoversPlan(candidate, plan) &&
                (!workerDid || candidate.audienceDid === workerDid) &&
                (!grantId || candidate.id === grantId)
            ).length
        : 0,
    [grantId, grants, plan, workerDid]
  );
  const redactedPlan = useMemo(
    () => (plan && activeGrant ? redactServicePlanForWorker(plan, activeGrant.caveats) : {}),
    [activeGrant, plan]
  );

  if (!plan) {
    return (
      <Section
        actions={<Badge tone="neutral">no plan</Badge>}
        eyebrow="Redacted worker view"
        title="Worker service plan"
      >
        <StatusBanner tone="info">Select a saved service plan before opening a worker view.</StatusBanner>
      </Section>
    );
  }

  if (!activeGrant) {
    return (
      <Section
        actions={
          revokedGrantCount ? (
            <Badge tone="warning">
              {revokedGrantCount} revoked {revokedGrantCount === 1 ? "grant" : "grants"}
            </Badge>
          ) : (
            <Badge tone="neutral">no access</Badge>
          )
        }
        eyebrow="Redacted worker view"
        title="Worker service plan"
      >
        <StatusBanner tone="warning">
          Worker access is not active. This view hides all service plan fields until an active scoped grant is present.
        </StatusBanner>
      </Section>
    );
  }

  const allowedFields = grantFieldsFromCaveats(activeGrant.caveats);
  const allowedFieldSet = new Set<ServicePlanField>(allowedFields);
  const scopes = grantScopesFromCaveats(activeGrant.caveats);
  const summaryRows = detailRows(redactedPlan, [
    ["service_title", "Service"],
    ["provider_name", "Provider"],
    ["goal", "Goal"],
    ["status", "Status"],
    ["service_doc_id", "Service document"],
    ["source_content_cid", "Source content CID"],
    ["source_page_cid", "Source page CID"]
  ]);
  const scheduleRows = detailRows(redactedPlan, [
    ["appointment_at", "Appointment"],
    ["reminder_at", "Reminder"],
    ["travel_target", "Travel or contact target"]
  ]);
  const workerRows = detailRows(redactedPlan, [["assigned_worker_recipient_id", "Assigned worker reference"]]);

  return (
    <Section
      actions={<Badge tone="success">active grant</Badge>}
      eyebrow="Redacted worker view"
      title="Worker service plan"
    >
      <StatusBanner tone="info">
        Only fields covered by grant {activeGrant.id} are shown. Private notes and wallet-only identifiers are withheld.
      </StatusBanner>

      <div className="review-panel">
        <div>
          <h3>Grant boundary</h3>
          <p className="supporting-copy">{activeGrant.audienceDid || "Worker DID not listed"}</p>
          <div className="badge-row">
            {scopes.map((scope) => (
              <Badge key={scope} tone="info">
                {scopeLabel(scope)}
              </Badge>
            ))}
            <Badge tone="neutral">
              <ShieldCheck aria-hidden="true" size={14} />
              service_plan/read
            </Badge>
          </div>
        </div>
        {onRevokeGrant ? (
          <div className="row-actions">
            <Button
              loading={revokingGrantId === activeGrant.id}
              loadingLabel="Revoking"
              onClick={() => void onRevokeGrant(activeGrant.id)}
              variant="danger"
            >
              <LockKeyhole aria-hidden="true" size={18} />
              Revoke access
            </Button>
          </div>
        ) : null}
      </div>

      {summaryRows.length ? <DetailPanel rows={summaryRows} title="Service summary" /> : null}

      {allowedFieldSet.has("steps") || allowedFieldSet.has("documents_needed") || allowedFieldSet.has("questions_to_ask") ? (
        <div className="review-panel">
          <h3>Checklist</h3>
          <div className="list-stack">
            {allowedFieldSet.has("steps") ? <TextList items={redactedPlan.steps} title="Steps" /> : null}
            {allowedFieldSet.has("documents_needed") ? (
              <TextList items={redactedPlan.documents_needed} title="Documents needed" />
            ) : null}
            {allowedFieldSet.has("questions_to_ask") ? (
              <TextList items={redactedPlan.questions_to_ask} title="Questions to ask" />
            ) : null}
          </div>
        </div>
      ) : null}

      {scheduleRows.length ? <DetailPanel rows={scheduleRows} title="Schedule" /> : null}
      {workerRows.length ? <DetailPanel rows={workerRows} title="Worker assignment" /> : null}

      {allowedFieldSet.has("related_interaction_ids") ? (
        <div className="review-panel">
          <h3>Interaction history</h3>
          <TextList items={redactedPlan.related_interaction_ids} title="Related interactions" />
        </div>
      ) : null}

      <div className="review-panel">
        <h3>Withheld fields</h3>
        <p className="supporting-copy">
          <EyeOff aria-hidden="true" size={16} /> Private notes, wallet ID, plan ID, timestamps, and any ungranted scope
          fields are not rendered in this worker view.
        </p>
      </div>
    </Section>
  );
}

export function redactServicePlanForWorker(
  plan: ServicePlan,
  caveats: Record<string, unknown> = {}
): RedactedServicePlan {
  const redacted: RedactedServicePlan = {};
  for (const field of grantFieldsFromCaveats(caveats)) {
    redacted[field] = plan[field] as string | string[];
  }
  return redacted;
}

export function selectActiveServicePlanGrant(
  plan: ServicePlan,
  grants: WorkerServicePlanGrant[],
  {
    grantId = "",
    workerDid = ""
  }: {
    grantId?: string;
    workerDid?: string;
  } = {}
): NormalizedWorkerServicePlanGrant | undefined {
  return grants
    .map(normalizeWorkerServicePlanGrant)
    .find(
      (candidate) =>
        candidate.status === "active" &&
        grantCoversPlan(candidate, plan) &&
        grantHasReadAbility(candidate) &&
        (!grantId || candidate.id === grantId) &&
        (!workerDid || candidate.audienceDid === workerDid)
    );
}

function DetailPanel({ rows, title }: { rows: Array<{ label: string; value: string | string[] }>; title: string }) {
  return (
    <div className="review-panel">
      <h3>{title}</h3>
      <div className="list-stack">
        {rows.map((row) => (
          <article className="list-item" key={row.label}>
            <div>
              <h3>{row.label}</h3>
              <p style={{ overflowWrap: "anywhere" }}>{formatPlanValue(row.value)}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function TextList({ items, title }: { items?: string | string[]; title: string }) {
  const values = Array.isArray(items) ? items.filter(Boolean) : items ? [items] : [];
  return (
    <article className="list-item">
      <div>
        <h3>{title}</h3>
        {values.length ? (
          <ul>
            {values.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p>None listed</p>
        )}
      </div>
    </article>
  );
}

function detailRows(
  redactedPlan: RedactedServicePlan,
  fields: Array<[ServicePlanField, string]>
): Array<{ label: string; value: string | string[] }> {
  return fields.flatMap(([field, label]) => (field in redactedPlan ? [{ label, value: redactedPlan[field] || "" }] : []));
}

function grantFieldsFromCaveats(caveats: Record<string, unknown> = {}): ServicePlanField[] {
  const explicitFields = caveats.allowed_fields;
  if (Array.isArray(explicitFields)) {
    return uniqueServicePlanFields(explicitFields);
  }

  const scopes = grantScopesFromCaveats(caveats);
  return uniqueServicePlanFields(scopes.flatMap((scope) => servicePlanShareScopeFields[scope]));
}

function grantScopesFromCaveats(caveats: Record<string, unknown> = {}): ServicePlanShareScope[] {
  const scopes = caveats.service_plan_scopes;
  if (!Array.isArray(scopes)) return ["service_summary"];
  const normalized = scopes.filter(isServicePlanShareScope);
  return normalized.length ? normalized : ["service_summary"];
}

function uniqueServicePlanFields(values: unknown[]): ServicePlanField[] {
  const fields: ServicePlanField[] = [];
  for (const value of values) {
    if (isServicePlanField(value) && !fields.includes(value)) {
      fields.push(value);
    }
  }
  return fields;
}

function isServicePlanField(value: unknown): value is ServicePlanField {
  return typeof value === "string" && servicePlanFields.has(value);
}

function isServicePlanShareScope(value: unknown): value is ServicePlanShareScope {
  return typeof value === "string" && value in servicePlanShareScopeFields;
}

function normalizeWorkerServicePlanGrant(grant: WorkerServicePlanGrant): NormalizedWorkerServicePlanGrant {
  if ("grantId" in grant) {
    return {
      abilities: grant.abilities,
      audienceDid: grant.audienceDid,
      caveats: grant.caveats || {},
      id: grant.grantId,
      resources: grant.resources,
      status: grant.status
    };
  }
  return {
    abilities: grant.abilities,
    audienceDid: grant.audience_did,
    caveats: grant.caveats || {},
    id: grant.grant_id,
    resources: grant.resources,
    status: grant.status || "active"
  };
}

function grantCoversPlan(grant: NormalizedWorkerServicePlanGrant, plan: ServicePlan): boolean {
  const caveatPlanId = String(grant.caveats.service_plan_id || "");
  return (
    caveatPlanId === plan.plan_id ||
    grant.resources.some((resource) => resource.endsWith(`/portal/plans/${plan.plan_id}`))
  );
}

function grantHasReadAbility(grant: NormalizedWorkerServicePlanGrant): boolean {
  return grant.abilities.includes("service_plan/read") || grant.abilities.includes("*");
}

function scopeLabel(scope: ServicePlanShareScope): string {
  return scope.replace(/_/g, " ");
}

function formatPlanValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None listed";
  const text = String(value || "").trim();
  if (!text) return "Not provided";
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  return text;
}
