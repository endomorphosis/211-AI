import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ServiceQuickActions } from "../components/services/ServiceQuickActions";
import { ServiceProvenancePanel } from "../components/services/ServiceProvenancePanel";
import { Badge, Button, Section, StatusBanner } from "../components/ui";
import { t, tFormat, type SupportedLocale } from "../lib/localization";
import {
  getPrimaryEligibilityText,
  getPrimaryIntakeText,
  getPrimaryRequiredDocumentsText,
  getServiceAddresses,
  getServiceAreaServedText,
  getServiceLocationLabel,
  getServicePhones,
  getServiceTravelInfoText,
  load211ArtifactManifest,
  load211DocumentsByReference,
  load211GeneratedManifest,
  load211ServiceLocationsSlice,
  type CorpusDocument,
  type ServiceLocationRecord,
} from "../lib/graphrag";
import { build211InfoServiceProvenance } from "../services/graphRagService";

type ServiceDetailMetadata = {
  buildManifestCid: string;
  documentsArtifactCid: string;
  documentCount: number;
  loadedAt: string;
};

type ServiceDetailState =
  | { status: "loading"; document: null; metadata: null; locations: ServiceLocationRecord[]; error: "" }
  | { status: "ready"; document: CorpusDocument; metadata: ServiceDetailMetadata; locations: ServiceLocationRecord[]; error: "" }
  | { status: "not-found"; document: null; metadata: ServiceDetailMetadata | null; locations: ServiceLocationRecord[]; error: "" }
  | { status: "error"; document: null; metadata: null; locations: ServiceLocationRecord[]; error: string };

export function ServiceDetailScreen({ docId, onBack, siteLocale }: { docId: string; onBack: () => void; siteLocale: SupportedLocale }) {
  const [state, setState] = useState<ServiceDetailState>({
    status: "loading",
    document: null,
    metadata: null,
    locations: [],
    error: "",
  });

  useEffect(() => {
    let canceled = false;

    async function loadServiceDetail() {
      setState({ status: "loading", document: null, metadata: null, locations: [], error: "" });
      try {
        const documentsState = await load211DocumentsByReference(docId, { limit: 4 });
        const [artifactManifestResult, generatedManifestResult] = await Promise.allSettled([
          load211ArtifactManifest(),
          load211GeneratedManifest(),
        ]);
        if (canceled) return;

        const artifactManifest =
          artifactManifestResult.status === "fulfilled" ? artifactManifestResult.value : null;
        const generatedManifest =
          generatedManifestResult.status === "fulfilled" ? generatedManifestResult.value : null;
        const document =
          documentsState.documentById.get(docId) ??
          documentsState.documentByContentCid.get(docId) ??
          documentsState.documents.find((item) => item.source_page_cid === docId) ??
          null;
        const locations = document
          ? await load211ServiceLocationsSlice({ serviceDocIds: [document.doc_id] }).catch(() => [])
          : [];
        if (canceled) return;
        const documentsArtifact = artifactManifest?.artifacts.find((artifact) => artifact.role === "documents");
        const metadata: ServiceDetailMetadata = {
          buildManifestCid:
            artifactManifest?.sourcePackage.build_manifest_cid ||
            ((generatedManifest as { sourcePackage?: { build_manifest_cid?: string } } | null)?.sourcePackage
              ?.build_manifest_cid ??
              ""),
          documentsArtifactCid: documentsArtifact?.cid ?? "",
          documentCount:
            generatedManifest?.documentCount ?? artifactManifest?.corpus.documentCount ?? documentsState.documents.length,
          loadedAt: new Date().toISOString(),
        };

        setState(
          document
            ? { status: "ready", document, metadata, locations, error: "" }
            : { status: "not-found", document: null, metadata, locations: [], error: "" },
        );
      } catch (error) {
        if (canceled) return;
        setState({
          status: "error",
          document: null,
          metadata: null,
          locations: [],
          error: error instanceof Error ? error.message : t(siteLocale, "services.detail.unavailable"),
        });
      }
    }

    void loadServiceDetail();

    return () => {
      canceled = true;
    };
  }, [docId, siteLocale]);

  if (state.status === "loading") {
    return (
      <div className="screen">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          {t(siteLocale, "services.detail.back")}
        </Button>
        <StatusBanner tone="info">{t(siteLocale, "services.detail.loading")}</StatusBanner>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="screen">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          {t(siteLocale, "services.detail.back")}
        </Button>
        <StatusBanner tone="warning">{tFormat(siteLocale, "services.detail.loadError", { error: state.error })}</StatusBanner>
      </div>
    );
  }

  if (state.status === "not-found") {
    return (
      <div className="screen">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          {t(siteLocale, "services.detail.back")}
        </Button>
        <StatusBanner tone="warning">{tFormat(siteLocale, "services.detail.notFound", { docId })}</StatusBanner>
        <Section title={t(siteLocale, "services.detail.requestedSource")}>
          <div className="list-item">
            <div>
              <h3>{t(siteLocale, "services.detail.documentIdOrCid")}</h3>
              <p>{docId}</p>
            </div>
          </div>
        </Section>
      </div>
    );
  }

  const document = state.document;
  const metadata = state.metadata;
  const title = document.program_name || document.provider_name || document.title || document.doc_id;
  const provider = document.provider_name || t(siteLocale, "services.providerNotListed");
  const program = document.program_name || document.title || t(siteLocale, "services.programNotListed");
  const location = getServiceLocationLabel(document);
  const phones = getServicePhones(document);
  const addresses = getServiceAddresses(document);
  const detailedLocations = state.locations;
  const intakeText = getPrimaryIntakeText(document);
  const eligibilityText = getPrimaryEligibilityText(document);
  const requiredDocumentsText = getPrimaryRequiredDocumentsText(document);
  const areaServedText = getServiceAreaServedText(document);
  const travelInfoText = getServiceTravelInfoText(document);
  const provenance = build211InfoServiceProvenance(document, {
    buildManifestCid: metadata.buildManifestCid,
    documentsArtifactCid: metadata.documentsArtifactCid,
    documentCount: metadata.documentCount,
    generatedAt: metadata.loadedAt,
  });

  return (
    <div className="screen">
      <div className="page-title">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          {t(siteLocale, "services.detail.back")}
        </Button>
        <p className="eyebrow">{t(siteLocale, "services.detail.eyebrow")}</p>
        <h1>{title}</h1>
      </div>

      <Section title={t(siteLocale, "services.detail.providerProgram")}>
        <div className="list-stack">
          <article className="list-item">
            <div>
              <h3>{t(siteLocale, "services.detail.provider")}</h3>
              <p>{provider}</p>
            </div>
            <Badge>{document.doc_type}</Badge>
          </article>
          <article className="list-item">
            <div>
              <h3>{t(siteLocale, "services.detail.program")}</h3>
              <p>{program}</p>
            </div>
            {location ? <Badge tone="success">{location}</Badge> : null}
          </article>
        </div>
      </Section>

      <Section title={t(siteLocale, "services.detail.actions")}>
        <ServiceQuickActions document={document} siteLocale={siteLocale} />
      </Section>

      <Section title={t(siteLocale, "services.detail.contactLocation")}>
        <div className="list-stack">
          {phones.length ? (
            <article className="list-item">
              <div>
                <h3>{t(siteLocale, "services.detail.phone")}</h3>
                <p>{phones.map((item) => item.value).filter(Boolean).join(" · ")}</p>
              </div>
            </article>
          ) : null}
          {addresses.length ? (
            <article className="list-item">
              <div>
                <h3>{detailedLocations.length ? t(siteLocale, "services.detail.embeddedAddressSummary") : t(siteLocale, "services.detail.address")}</h3>
                <p>{addresses.map((item) => item.address || item.maps_query).filter(Boolean).join(" · ")}</p>
              </div>
              {location ? <Badge tone="success">{location}</Badge> : null}
            </article>
          ) : null}
          {detailedLocations.map((item) => {
            const addressText = item.address || item.maps_query || [item.street, item.city, item.state, item.postal_code].filter(Boolean).join(", ");
            const mapHref = item.google_maps_url || item.apple_maps_url || item.geo_url || "";
            return (
              <article className="list-item" key={item.location_id || `${item.service_doc_id}:${item.address}`}>
                <div>
                  <h3>{item.label || t(siteLocale, "services.detail.serviceLocation")}</h3>
                  <p>{addressText || t(siteLocale, "services.detail.locationWithoutAddress")}</p>
                  {item.geo_precision ? <p className="supporting-copy">{tFormat(siteLocale, "services.detail.geoPrecision", { value: item.geo_precision })}</p> : null}
                </div>
                {mapHref ? (
                  <a className="button button-secondary" href={mapHref} rel="noreferrer" target="_blank">
                    {t(siteLocale, "services.detail.openMap")}
                  </a>
                ) : item.geo_cluster_id != null ? (
                  <Badge tone="success">{tFormat(siteLocale, "services.detail.cluster", { value: String(item.geo_cluster_id) })}</Badge>
                ) : null}
              </article>
            );
          })}
          {areaServedText ? (
            <article className="list-item">
              <div>
                <h3>{t(siteLocale, "services.detail.areaServed")}</h3>
                <p>{areaServedText}</p>
              </div>
            </article>
          ) : null}
          {travelInfoText ? (
            <article className="list-item">
              <div>
                <h3>{t(siteLocale, "services.detail.travelNotes")}</h3>
                <p>{travelInfoText}</p>
              </div>
            </article>
          ) : null}
        </div>
      </Section>

      <Section title={t(siteLocale, "services.detail.howToApply")}>
        <div className="list-stack">
          {intakeText ? (
            <article className="list-item">
              <div>
                <h3>{t(siteLocale, "services.detail.intakeSteps")}</h3>
                <p>{intakeText}</p>
              </div>
            </article>
          ) : null}
          {eligibilityText ? (
            <article className="list-item">
              <div>
                <h3>{t(siteLocale, "services.detail.eligibility")}</h3>
                <p>{eligibilityText}</p>
              </div>
            </article>
          ) : null}
          {requiredDocumentsText ? (
            <article className="list-item">
              <div>
                <h3>{t(siteLocale, "services.detail.requiredDocuments")}</h3>
                <p>{requiredDocumentsText}</p>
              </div>
            </article>
          ) : null}
          {!intakeText && !eligibilityText && !requiredDocumentsText ? (
            <StatusBanner tone="info">{t(siteLocale, "services.detail.noStructuredIntake")}</StatusBanner>
          ) : null}
        </div>
      </Section>

      <Section title={t(siteLocale, "services.detail.summary")}>
        <div className="review-panel">
          <p className="supporting-copy" style={{ overflowWrap: "anywhere" }}>
            {toReadableSummary(document, detailedLocations, siteLocale)}
          </p>
        </div>
      </Section>

      <ServiceProvenancePanel report={provenance} />
    </div>
  );
}

const SUMMARY_NOISE_PATTERNS = [
  /Print\s*&\s*Share\s*X\s*Print\s*&\s*Share\s*Print\s*PDF/gi,
  /Print\s*&\s*Share/gi,
  /Get Directions/gi,
  /Visit Website/gi,
  /Main phone/gi,
];

function toReadableSummary(document: CorpusDocument, detailedLocations: ServiceLocationRecord[], locale: SupportedLocale): string {
  const cleanText = sanitizeSummaryText(document.text);
  if (!cleanText) return t(locale, "services.detail.noSourceSummary");

  const exclusionValues = buildSummaryExclusionValues(document, detailedLocations);
  const summarySegments = cleanText
    .split(/(?<=[.!?])\s+|\s{2,}|\s+[\u2022\-]\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !isDuplicateStructuredSummarySegment(segment, exclusionValues));

  const summary = summarySegments.join(" ").replace(/\s+/g, " ").trim();
  if (!summary) return t(locale, "services.detail.noNonDuplicativeSummary");
  return summary.length > 700 ? `${summary.slice(0, 700).trim()}...` : summary;
}

function sanitizeSummaryText(text: string): string {
  let value = text.replace(/\s+/g, " ").trim();
  for (const pattern of SUMMARY_NOISE_PATTERNS) {
    value = value.replace(pattern, " ");
  }
  return value.replace(/\s+/g, " ").trim();
}

function buildSummaryExclusionValues(document: CorpusDocument, detailedLocations: ServiceLocationRecord[]): string[] {
  const addressValues = getServiceAddresses(document)
    .flatMap((item) => [item.label, item.address, item.maps_query, item.street, item.city, item.state, item.postal_code]);
  const locationValues = detailedLocations.flatMap((item) => [
    item.label,
    item.address,
    item.maps_query,
    item.street,
    item.city,
    item.state,
    item.postal_code,
  ]);
  const phoneValues = getServicePhones(document).flatMap((item) => [item.label, item.value]);
  const exclusionValues = [
    document.provider_name,
    document.program_name,
    document.title,
    getServiceLocationLabel(document),
    getPrimaryIntakeText(document),
    getPrimaryEligibilityText(document),
    getPrimaryRequiredDocumentsText(document),
    getServiceAreaServedText(document),
    getServiceTravelInfoText(document),
    ...addressValues,
    ...locationValues,
    ...phoneValues,
  ];
  return exclusionValues
    .map(normalizeSummaryComparisonText)
    .filter((value) => value.length >= 12);
}

function isDuplicateStructuredSummarySegment(segment: string, exclusionValues: string[]): boolean {
  const normalizedSegment = normalizeSummaryComparisonText(segment);
  if (!normalizedSegment || normalizedSegment.length < 12) {
    return false;
  }
  return exclusionValues.some(
    (value) => normalizedSegment.includes(value) || value.includes(normalizedSegment),
  );
}

function normalizeSummaryComparisonText(value: string | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
