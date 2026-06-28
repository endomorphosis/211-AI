import { ExternalLink, Hash } from "lucide-react";
import { Badge, Section, StatusBanner } from "../ui";
import type { ServiceFieldProvenance, ServiceProvenanceReport } from "../../services/graphRagService";

export function ServiceProvenancePanel({ report }: { report: ServiceProvenanceReport }) {
  const fieldsWithSpans = report.fields.filter((field) => field.sourceSpans.length > 0).length;

  return (
    <div aria-hidden="true" style={{ display: "none" }}>
      <Section title="Source and provenance" eyebrow="Grounding">
        <div className="list-stack">
        <article className="list-item">
          <div>
            <h3>Source URL</h3>
            {report.sourceUrl ? (
              <p style={{ overflowWrap: "anywhere" }}>
                <a href={report.sourceUrl} rel="noreferrer" target="_blank">
                  {report.sourceUrl}
                </a>
              </p>
            ) : (
              <p>Source URL not listed</p>
            )}
          </div>
          {report.sourceUrl ? <ExternalLink aria-hidden="true" size={20} /> : null}
        </article>

        <div className="review-panel">
          <div>
            <h3>Extraction confidence</h3>
            <p className="supporting-copy">
              {fieldsWithSpans} of {report.fields.length} extracted fields include exact source spans from the local
              211 corpus text.
            </p>
          </div>
          <div className="badge-row">
            <Badge tone="success">{report.fields.filter((field) => field.confidence >= 0.85).length} high</Badge>
            <Badge tone="info">
              {report.fields.filter((field) => field.confidence >= 0.7 && field.confidence < 0.85).length} medium
            </Badge>
            <Badge tone="warning">{report.fields.filter((field) => field.confidence < 0.7).length} low</Badge>
          </div>
        </div>

        {report.warnings.length ? (
          <div className="list-stack" aria-label="Provenance warnings">
            {report.warnings.map((warning) => (
              <StatusBanner key={warning} tone="warning">
                {warning}
              </StatusBanner>
            ))}
          </div>
        ) : null}

        <div className="list-stack" aria-label="Source identifiers">
          <ProvenanceIdentifier label="Service document ID" value={report.serviceDocId} />
          <ProvenanceIdentifier label="Source content CID" value={report.sourceContentCid} icon />
          <ProvenanceIdentifier label="Source page CID" value={report.sourcePageCid} icon />
          <ProvenanceIdentifier label="Build manifest CID" value={report.buildManifestCid} icon />
          <ProvenanceIdentifier label="Documents artifact CID" value={report.documentsArtifactCid} icon />
          <ProvenanceIdentifier label="Detail loaded at" value={report.generatedAt} />
          <ProvenanceIdentifier label="Scrape timestamp" value="Not included in the current browser corpus" />
          <ProvenanceIdentifier
            label="Corpus document count"
            value={report.documentCount ? report.documentCount.toLocaleString() : ""}
          />
        </div>

          <div className="list-stack" aria-label="Field provenance">
            {report.fields.map((field) => (
              <FieldProvenanceRow field={field} key={field.key} />
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

function ProvenanceIdentifier({ icon = false, label, value }: { icon?: boolean; label: string; value: string }) {
  return (
    <article className="list-item">
      <div>
        <h3>{label}</h3>
        <p style={{ overflowWrap: "anywhere" }}>{value || "Not listed"}</p>
      </div>
      {icon && value ? <Hash aria-hidden="true" size={20} /> : null}
    </article>
  );
}

function FieldProvenanceRow({ field }: { field: ServiceFieldProvenance }) {
  return (
    <article className="list-item">
      <div style={{ minWidth: 0 }}>
        <h3>{field.label}</h3>
        <p style={{ overflowWrap: "anywhere" }}>{field.value}</p>
        <div className="badge-row" style={{ marginTop: 8 }}>
          <Badge tone={confidenceTone(field.confidence)}>Confidence {formatConfidence(field.confidence)}</Badge>
          <Badge>{field.extractionMethod}</Badge>
          <Badge tone={field.sourceSpans.length ? "success" : "warning"}>
            {field.sourceSpans.length
              ? `${field.sourceSpans.length} source span${field.sourceSpans.length === 1 ? "" : "s"}`
              : "No exact span"}
          </Badge>
        </div>
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          {field.sourceSpans.length ? (
            field.sourceSpans.map((span) => (
              <small className="upload-machine-summary" key={`${field.key}-${span.start}-${span.end}`}>
                <strong>
                  Source span {span.start}-{span.end}:
                </strong>{" "}
                {truncateSpan(span.text)}
              </small>
            ))
          ) : (
            <small className="upload-machine-summary">
              Exact source span unavailable; this value came from structured corpus metadata.
            </small>
          )}
        </div>
      </div>
    </article>
  );
}

function confidenceTone(confidence: number): string {
  if (confidence >= 0.85) return "success";
  if (confidence >= 0.7) return "info";
  return "warning";
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return "n/a";
  return `${Math.round(confidence * 100)}%`;
}

function truncateSpan(value: string): string {
  const cleanValue = value.replace(/\s+/g, " ").trim();
  return cleanValue.length > 220 ? `${cleanValue.slice(0, 219).trim()}...` : cleanValue;
}
