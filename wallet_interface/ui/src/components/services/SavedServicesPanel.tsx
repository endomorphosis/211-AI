import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ExternalLink, RefreshCw } from "lucide-react";
import { getServiceLocationLabel, load211DocumentsByReference, type CorpusDocument } from "../../lib/graphrag";
import { t, tFormat, type SupportedLocale } from "../../lib/localization";
import type { SavedService, ServicePlan } from "../../models/abby";
import { Badge, Button, Section, StatusBanner } from "../ui";
import { ServiceQuickActions } from "./ServiceQuickActions";

export function SavedServicesPanel({
  error = "",
  loading = false,
  onOpenDetail,
  onOpenPlan,
  onRefresh,
  savedServices,
  siteLocale,
  servicePlans
}: {
  error?: string;
  loading?: boolean;
  onOpenDetail: (docId: string) => void;
  onOpenPlan: (docId: string) => void;
  onRefresh?: () => void;
  savedServices: SavedService[];
  siteLocale: SupportedLocale;
  servicePlans: ServicePlan[];
}) {
  const [documentById, setDocumentById] = useState<Map<string, CorpusDocument>>(new Map());
  const serviceByDoc = new Map(savedServices.map((service) => [service.service_doc_id, service]));
  const planByService = new Map(servicePlans.map((plan) => [plan.service_doc_id, plan]));
  const rows = [
    ...savedServices.map((service) => ({ service, plan: planByService.get(service.service_doc_id) })),
    ...servicePlans
      .filter((plan) => !serviceByDoc.has(plan.service_doc_id))
      .map((plan) => ({ service: undefined, plan }))
  ];
  const serviceDocIds = useMemo(
    () =>
      [...new Set(rows.map(({ plan, service }) => service?.service_doc_id || plan?.service_doc_id || "").filter(Boolean))],
    [rows]
  );
  const serviceDocIdKey = serviceDocIds.join("\u0000");

  useEffect(() => {
    let canceled = false;
    if (!serviceDocIds.length) {
      setDocumentById(new Map());
      return () => {
        canceled = true;
      };
    }
    load211DocumentsByReference(serviceDocIds, { docTypes: ["service"], limit: serviceDocIds.length })
      .then((state) => {
        if (!canceled) {
          setDocumentById(state.documentById);
        }
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [serviceDocIdKey]);

  return (
    <Section
      actions={
        onRefresh ? (
          <Button
            ariaLabel={t(siteLocale, "services.saved.refresh")}
            loading={loading}
            loadingLabel={t(siteLocale, "services.saved.refreshing")}
            onClick={onRefresh}
            variant="quiet"
          >
            <RefreshCw aria-hidden="true" size={18} />
          </Button>
        ) : null
      }
      title={t(siteLocale, "services.saved.title")}
    >
      {error ? <StatusBanner tone="warning">{tFormat(siteLocale, "services.saved.error", { error })}</StatusBanner> : null}
      {!rows.length ? (
        <StatusBanner tone="info">{t(siteLocale, "services.saved.empty")}</StatusBanner>
      ) : (
        <div className="list-stack" aria-label={t(siteLocale, "services.saved.aria")}>
          {rows.map(({ plan, service }) => {
            const serviceDocId = service?.service_doc_id || plan?.service_doc_id || "";
            const serviceDocument = serviceDocId ? documentById.get(serviceDocId) : undefined;
            const title =
              service?.label ||
              service?.program_name ||
              serviceDocument?.program_name ||
              service?.title ||
              serviceDocument?.title ||
              plan?.service_title ||
              serviceDocId;
            const provider =
              service?.provider_name || plan?.provider_name || serviceDocument?.provider_name || t(siteLocale, "services.saved.providerNotListed");
            const location = serviceDocument ? getServiceLocationLabel(serviceDocument) : "";
            return (
              <article className="list-item" key={service?.saved_service_id || plan?.plan_id || serviceDocId}>
                <div>
                  <h3>{title}</h3>
                  <p>{provider}</p>
                  {service?.reason ? <small className="upload-machine-summary">{service.reason}</small> : null}
                  <div className="badge-row">
                    {service ? (
                      <Badge tone={service.priority === "high" ? "warning" : "neutral"}>
                        {service.priority || t(siteLocale, "services.saved.priority.normal")}
                      </Badge>
                    ) : null}
                    <Badge tone={service?.status === "saved" || !service ? "success" : "neutral"}>
                      {service?.status || t(siteLocale, "services.saved.status.planned")}
                    </Badge>
                    {plan ? <Badge tone="info">{tFormat(siteLocale, "services.saved.planStatus", { status: plan.status || "active" })}</Badge> : null}
                    {service?.private_notes_record_id || plan?.private_notes_record_id ? (
                      <Badge tone="success">{t(siteLocale, "services.saved.encryptedNotes")}</Badge>
                    ) : null}
                    {location ? <Badge>{location}</Badge> : null}
                  </div>
                </div>
                <div className="row-actions list-item-action">
                  {serviceDocument ? <ServiceQuickActions document={serviceDocument} siteLocale={siteLocale} /> : null}
                  {service?.source_url ? (
                    <a className="button button-secondary" href={service.source_url} rel="noreferrer" target="_blank">
                      <ExternalLink aria-hidden="true" size={18} />
                      {t(siteLocale, "services.saved.source")}
                    </a>
                  ) : null}
                  <Button onClick={() => onOpenDetail(serviceDocId)} variant="secondary">
                    {t(siteLocale, "services.openDetail")}
                  </Button>
                  <Button onClick={() => onOpenPlan(serviceDocId)} variant={plan ? "secondary" : "primary"}>
                    <CalendarClock aria-hidden="true" size={18} />
                    {plan ? t(siteLocale, "services.saved.editPlan") : t(siteLocale, "services.saved.createPlan")}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}
