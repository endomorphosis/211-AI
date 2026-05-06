import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Badge, Button, Section, StatusBanner } from "../components/ui";
import { ServiceProvenancePanel } from "../components/services/ServiceProvenancePanel";
import {
  load211ArtifactManifest,
  load211Documents,
  load211GeneratedManifest,
  type CorpusDocument,
} from "../lib/graphrag";
import { build211InfoServiceProvenance } from "../services/graphRagService";

type ServiceDetailMetadata = {
  buildManifestCid: string;
  documentsArtifactCid: string;
  documentCount: number;
  loadedAt: string;
};

type ServiceDetailState =
  | { status: "loading"; document: null; metadata: null; error: "" }
  | { status: "ready"; document: CorpusDocument; metadata: ServiceDetailMetadata; error: "" }
  | { status: "not-found"; document: null; metadata: ServiceDetailMetadata | null; error: "" }
  | { status: "error"; document: null; metadata: null; error: string };

export function ServiceDetailScreen({ docId, onBack }: { docId: string; onBack: () => void }) {
  const [state, setState] = useState<ServiceDetailState>({
    status: "loading",
    document: null,
    metadata: null,
    error: "",
  });

  useEffect(() => {
    let canceled = false;

    async function loadServiceDetail() {
      setState({ status: "loading", document: null, metadata: null, error: "" });
      try {
        const [documentsState, artifactManifest, generatedManifest] = await Promise.all([
          load211Documents(),
          load211ArtifactManifest(),
          load211GeneratedManifest(),
        ]);
        if (canceled) return;

        const document =
          documentsState.documentById.get(docId) ??
          documentsState.documentByContentCid.get(docId) ??
          documentsState.documents.find((item) => item.source_page_cid === docId) ??
          null;
        const documentsArtifact = artifactManifest.artifacts.find((artifact) => artifact.role === "documents");
        const metadata: ServiceDetailMetadata = {
          buildManifestCid: artifactManifest.sourcePackage.build_manifest_cid,
          documentsArtifactCid: documentsArtifact?.cid ?? "",
          documentCount: generatedManifest.documentCount,
          loadedAt: new Date().toISOString(),
        };

        setState(
          document
            ? { status: "ready", document, metadata, error: "" }
            : { status: "not-found", document: null, metadata, error: "" },
        );
      } catch (error) {
        if (canceled) return;
        setState({
          status: "error",
          document: null,
          metadata: null,
          error: error instanceof Error ? error.message : "Service detail unavailable",
        });
      }
    }

    void loadServiceDetail();

    return () => {
      canceled = true;
    };
  }, [docId]);

  if (state.status === "loading") {
    return (
      <div className="screen">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          Services
        </Button>
        <StatusBanner tone="info">Loading service detail from the local 211 corpus.</StatusBanner>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="screen">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          Services
        </Button>
        <StatusBanner tone="warning">Service detail could not load: {state.error}</StatusBanner>
      </div>
    );
  }

  if (state.status === "not-found") {
    return (
      <div className="screen">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          Services
        </Button>
        <StatusBanner tone="warning">No 211 service record was found for {docId}.</StatusBanner>
        <Section title="Requested source">
          <div className="list-item">
            <div>
              <h3>Document ID or CID</h3>
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
  const provider = document.provider_name || "Provider not listed";
  const program = document.program_name || document.title || "Program not listed";
  const sourceUrl = document.source_url;
  const location = [document.city, document.state].filter(Boolean).join(", ");
  const provenance = build211InfoServiceProvenance(document);
  const metadataRows = [
    { label: "Build manifest CID", value: metadata.buildManifestCid },
    { label: "Documents artifact CID", value: metadata.documentsArtifactCid },
    { label: "Detail loaded at", value: metadata.loadedAt },
    { label: "Scrape timestamp", value: "Not included in the current browser corpus" },
    { label: "Corpus document count", value: metadata.documentCount.toLocaleString() },
  ];

  return (
    <div className="screen">
      <div className="page-title">
        <Button onClick={onBack} variant="quiet">
          <ArrowLeft aria-hidden="true" size={18} />
          Services
        </Button>
        <p className="eyebrow">Service detail</p>
        <h1>{title}</h1>
      </div>

      <Section title="Provider and program">
        <div className="list-stack">
          <article className="list-item">
            <div>
              <h3>Provider</h3>
              <p>{provider}</p>
            </div>
            <Badge>{document.doc_type}</Badge>
          </article>
          <article className="list-item">
            <div>
              <h3>Program</h3>
              <p>{program}</p>
            </div>
            {location ? <Badge tone="success">{location}</Badge> : null}
          </article>
        </div>
      </Section>

      <Section title="Actions">
        <div className="row-actions">
          {sourceUrl ? (
            <a className="button button-secondary" href={sourceUrl} rel="noreferrer" target="_blank">
              <ExternalLink aria-hidden="true" size={18} />
              Website
            </a>
          ) : null}
        </div>
      </Section>

      <Section title="Summary">
        <div className="review-panel">
          <p className="supporting-copy" style={{ overflowWrap: "anywhere" }}>
            {toReadableSummary(document.text)}
          </p>
        </div>
      </Section>

      <ServiceProvenancePanel metadataRows={metadataRows} provenance={provenance} />
    </div>
  );
}

function toReadableSummary(text: string): string {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) return "No source summary is available for this 211 record.";
  return cleanText.length > 700 ? `${cleanText.slice(0, 700).trim()}...` : cleanText;
}
