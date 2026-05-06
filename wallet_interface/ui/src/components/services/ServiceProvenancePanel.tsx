import { ExternalLink, Link as LinkIcon } from "lucide-react";
import { Badge, Section } from "../ui";
import type { ServiceFieldProvenance, ServiceProvenance } from "../../services/graphRagService";

export function ServiceProvenancePanel({ provenance }: { provenance: ServiceProvenance }) {
  return (
    <Section title="Source and provenance">
      <div className="list-stack">
        <article className="list-item">
          <div>
            <h3>Source URL</h3>
            {provenance.sourceUrl ? (
              <p style={{ overflowWrap: "anywhere" }}>
                <a href={provenance.sourceUrl} rel="noreferrer" target="_blank">
                  {provenance.sourceUrl}
                </a>
              </p>
            ) : (
              <p>Source URL not listed</p>
            )}
          </div>
          {provenance.sourceUrl ? <LinkIcon aria-hidden="true" size={20} /> : null}
        </article>
        <ProvenanceRow label="Service document ID" value={provenance.serviceDocId} />
        <ProvenanceRow label="Source content CID" value={provenance.sourceContentCid} />
        <ProvenanceRow label="Source page CID" value={provenance.sourcePageCid} />
        <ProvenanceRow label="Build manifest CID" value={provenance.buildManifestCid} />
        <ProvenanceRow label="Documents artifact CID" value={provenance.documentsArtifactCid} />
        <ProvenanceRow label="Detail loaded at" value={provenance.loadedAt} />
        <ProvenanceRow label="Scrape timestamp" value={provenance.scrapeTimestamp} />
        <ProvenanceRow label="Corpus document count" value={provenance.documentCount.toLocaleString()} />
      </div>

      <div className="list-stack" aria-label="Field extraction confidence and source spans">
        {provenance.fields.map((field) => (
          <FieldProvenanceRow field={field} key={field.field} />
        ))}
      </div>
    </Section>
  );
}

function FieldProvenanceRow({ field }: { field: ServiceFieldProvenance }) {
  const confidencePercent = `${Math.round(field.confidence * 100)}%`;
  const badgeTone = field.confidence >= 0.9 ? "success" : field.confidence > 0 ? "warning" : "neutral";
  return (
    <article className="list-item" style={{ alignItems: "flex-start" }}>
      <div style={{ display: "grid", flex: "1 1 280px", gap: 8, minWidth: 0 }}>
        <div>
          <h3>{field.label}</h3>
          <p style={{ overflowWrap: "anywhere" }}>{field.value || "Not extracted"}</p>
          <small className="upload-machine-summary">{field.method}</small>
        </div>
        {field.sourceSpan ? (
          <div style={{ borderTop: "1px solid #d8dee6", display: "grid", gap: 6, paddingTop: 8 }}>
            <small>
              Source span characters {field.sourceSpan.start}-{field.sourceSpan.end}
            </small>
            <p className="supporting-copy" style={{ overflowWrap: "anywhere" }}>
              {field.sourceSpan.text}
            </p>
          </div>
        ) : (
          <small className="upload-machine-summary">{field.warning || "Exact source span is not available."}</small>
        )}
      </div>
      <div className="badge-row" style={{ flex: "0 1 220px", justifyContent: "flex-end" }}>
        <Badge tone={badgeTone}>{field.confidenceLabel}</Badge>
        <Badge>{confidencePercent}</Badge>
        {field.sourceUrl ? (
          <a
            aria-label={`Open source for ${field.label}`}
            className="button button-secondary compact-list-action"
            href={field.sourceUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" size={16} />
            Source
          </a>
        ) : null}
      </div>
    </article>
  );
}

function ProvenanceRow({ label, value }: { label: string; value: string }) {
  return (
    <article className="list-item">
      <div>
        <h3>{label}</h3>
        <p style={{ overflowWrap: "anywhere" }}>{value || "Not listed"}</p>
      </div>
    </article>
  );
}
