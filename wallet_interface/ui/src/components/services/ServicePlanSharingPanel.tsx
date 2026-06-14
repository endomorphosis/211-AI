import { FormEvent, useEffect, useMemo, useState } from "react";
import { Share2, ShieldCheck } from "lucide-react";
import type { DisclosureRecipientDraft, ServicePlan, WalletGrantReceipt } from "../../models/abby";
import {
  createWalletServicePlanShareGrant,
  type ServicePlanShareGrantResponse,
  type WalletApiConfig
} from "../../services/walletApi";
import { Badge, Button, Field, Section, StatusBanner } from "../ui";

export type ServicePlanShareScope =
  | "service_summary"
  | "checklist"
  | "schedule"
  | "worker_assignment"
  | "interaction_history";

const shareScopes: Array<{ id: ServicePlanShareScope; label: string; detail: string }> = [
  { id: "service_summary", label: "Service summary", detail: "provider, goal, source CIDs, status" },
  { id: "checklist", label: "Checklist", detail: "steps, needed documents, questions" },
  { id: "schedule", label: "Schedule", detail: "appointment, reminder, travel target" },
  { id: "worker_assignment", label: "Worker assignment", detail: "assigned worker reference" },
  { id: "interaction_history", label: "Interaction history", detail: "related interaction IDs" }
];

const workerRecipientTypes = new Set(["social_worker", "shelter_staff", "government_liaison", "benefits_agency"]);

export function ServicePlanSharingPanel({
  apiConfig,
  grantReceipts = [],
  onShared,
  plan,
  recipients = []
}: {
  apiConfig?: WalletApiConfig;
  grantReceipts?: WalletGrantReceipt[];
  onShared?: (result: ServicePlanShareGrantResponse) => void;
  plan?: ServicePlan;
  recipients?: DisclosureRecipientDraft[];
}) {
  const recipientOptions = useMemo(() => {
    const workers = recipients.filter((recipient) => workerRecipientTypes.has(recipient.type));
    return workers.length ? workers : recipients;
  }, [recipients]);
  const assignedRecipient = useMemo(
    () => recipientOptions.find((recipient) => recipient.id === plan?.assigned_worker_recipient_id),
    [plan?.assigned_worker_recipient_id, recipientOptions]
  );
  const activePlanReceipts = useMemo(
    () => grantReceipts.filter((receipt) => plan && receipt.status === "active" && receiptCoversPlan(receipt, plan.plan_id)),
    [grantReceipts, plan]
  );
  const [selectedRecipientId, setSelectedRecipientId] = useState(assignedRecipient?.id || "");
  const [workerDid, setWorkerDid] = useState(assignedRecipient ? didForRecipient(assignedRecipient) : "");
  const [expiresAt, setExpiresAt] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ServicePlanShareScope[]>(["service_summary"]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "info"; text: string } | null>(null);

  useEffect(() => {
    setSelectedRecipientId(assignedRecipient?.id || "");
    setWorkerDid(assignedRecipient ? didForRecipient(assignedRecipient) : "");
    setSelectedScopes(["service_summary"]);
    setMessage(null);
  }, [assignedRecipient, plan?.plan_id]);

  function selectRecipient(recipientId: string) {
    setSelectedRecipientId(recipientId);
    const recipient = recipientOptions.find((item) => item.id === recipientId);
    if (recipient) {
      setWorkerDid(didForRecipient(recipient));
    }
    setMessage(null);
  }

  function toggleScope(scope: ServicePlanShareScope) {
    const nextScopes = selectedScopes.includes(scope)
      ? selectedScopes.filter((item) => item !== scope)
      : [...selectedScopes, scope];
    setSelectedScopes(nextScopes);
    setMessage(null);
  }

  async function sharePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan) {
      setMessage({ tone: "warning", text: "Create and save the plan before sharing it." });
      return;
    }
    if (!apiConfig?.actorDid) {
      setMessage({ tone: "warning", text: "Connect a wallet API session before creating a worker grant." });
      return;
    }
    const audienceDid = workerDid.trim();
    if (!audienceDid) {
      setMessage({ tone: "warning", text: "Worker DID is required." });
      return;
    }
    if (!selectedScopes.length) {
      setMessage({ tone: "warning", text: "Select at least one plan scope." });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const recipient = recipientOptions.find((item) => item.id === selectedRecipientId);
      const result = await createWalletServicePlanShareGrant(apiConfig, plan.plan_id, {
        audienceDid,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        scopes: selectedScopes,
        workerName: recipient?.displayName || "",
        workerRecipientId: selectedRecipientId
      });
      onShared?.(result);
      setMessage({ tone: "success", text: `Scoped grant ${result.grantId} created.` });
    } catch (error) {
      setMessage({ tone: "warning", text: error instanceof Error ? error.message : "Service plan could not be shared." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      actions={
        activePlanReceipts.length ? <Badge tone="success">{activePlanReceipts.length} active grant</Badge> : null
      }
      title="Worker sharing"
    >
      {!plan ? <StatusBanner tone="info">Save this service plan before sharing it with a worker.</StatusBanner> : null}
      {message ? <StatusBanner tone={message.tone}>{message.text}</StatusBanner> : null}
      <form className="form-grid" onSubmit={sharePlan}>
        <div className="form-grid">
          <Field label="Worker">
            <select value={selectedRecipientId} onChange={(event) => selectRecipient(event.target.value)}>
              <option value="">Manual worker DID</option>
              {recipientOptions.map((recipient) => (
                <option key={recipient.id} value={recipient.id}>
                  {recipient.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Worker DID" required>
            <input value={workerDid} onChange={(event) => setWorkerDid(event.target.value)} placeholder="did:key:worker" />
          </Field>
          <Field label="Expires">
            <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </Field>
        </div>

        <div className="review-panel">
          <h3>Grant scopes</h3>
          <div className="list-stack">
            {shareScopes.map((scope) => (
              <article className="list-item" key={scope.id}>
                <label style={{ alignItems: "center", display: "flex", flex: 1, gap: 12, minWidth: 0 }}>
                  <input
                    checked={selectedScopes.includes(scope.id)}
                    onChange={() => toggleScope(scope.id)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{scope.label}</strong>
                    <small className="upload-machine-summary">{scope.detail}</small>
                  </span>
                </label>
                {scope.id === "service_summary" ? <Badge tone="info">default</Badge> : null}
              </article>
            ))}
          </div>
        </div>

        {activePlanReceipts.length ? (
          <div className="review-panel">
            <h3>Active worker grants</h3>
            <div className="list-stack">
              {activePlanReceipts.map((receipt) => (
                <article className="list-item" key={receipt.id}>
                  <div>
                    <h3>{receipt.audienceName}</h3>
                    <p>{receipt.grantId}</p>
                    <div className="badge-row">
                      {scopeLabelsFromReceipt(receipt).map((scope) => (
                        <Badge key={scope} tone="neutral">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Badge tone="success">active</Badge>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        <div className="row-actions">
          <Button disabled={!plan || !apiConfig?.actorDid} loading={busy} loadingLabel="Sharing" type="submit">
            <Share2 aria-hidden="true" size={18} />
            Share plan
          </Button>
          <Badge tone="neutral">
            <ShieldCheck aria-hidden="true" size={14} />
            service_plan/read
          </Badge>
        </div>
      </form>
    </Section>
  );
}

function receiptCoversPlan(receipt: WalletGrantReceipt, planId: string): boolean {
  const caveatPlanId = String(receipt.caveats?.service_plan_id || "");
  return caveatPlanId === planId || receipt.resources.some((resource) => resource.endsWith(`/portal/plans/${planId}`));
}

function scopeLabelsFromReceipt(receipt: WalletGrantReceipt): string[] {
  const scopes = receipt.caveats?.service_plan_scopes;
  if (!Array.isArray(scopes)) return ["service_summary"];
  return scopes.map((scope) => String(scope)).filter(Boolean);
}

function didForRecipient(recipient: DisclosureRecipientDraft): string {
  if (recipient.id.startsWith("did:")) return recipient.id;
  return `did:abby:recipient:${recipient.id.replace(/[^a-zA-Z0-9._:-]/g, "-")}`;
}
