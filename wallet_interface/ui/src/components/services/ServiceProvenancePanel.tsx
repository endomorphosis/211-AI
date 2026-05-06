import { ExternalLink, FileText, Hash } from "lucide-react";
import { Badge, Section } from "../ui";
import type { ServiceProvenance } from "../../services/graphRagService";

export interface ServiceProvenanceMetadataRow {
  label: string;
  value: string;
}

export function ServiceProvenancePanel({
  provenance,
  metadataRows = []
}: {
  provenance: ServiceProvenance;
  metadataRows?: ServiceProvenanceMetadataRow[];
}) {
  const spanCount = provenance.sourceSpans.length;

  return (
    <Section title="Source and provenance">
      <div className="service-provenance">
        <div className="service-provenance-summary">
          <div>
            <small>Extracted fields</small>
            <strong>{provenance.fields.length}</strong>
          </div>
          <div>
            <small>Source spans</small>
            <strong>{spanCount}</strong>
          </div>
          <div>
            <small>Record</small>
            <strong>{provenance.docId}</strong>
          </div>
        </div>

        <article className="list-item service-source-card">
          <div>
            <h3>Source record</h3>
            {provenance.sourceUrl ? (
              <p>
                <a href={provenance.sourceUrl} rel="noreferrer" target="_blank">
                  {provenance.sourceUrl}
                </a>
              </p>
            ) : (
              <p>Source URL not listed</p>
            )}
          </div>
          {provenance.sourceUrl ? (
            <ExternalLink aria-hidden="true" size={20} />
          ) : (
            <FileText aria-hidden="true" size={20} />
          )}
        </article>

        <div className="list-stack">
          {provenance.fields.map((field) => (
            <article className="service-provenance-field" key={field.key}>
              <div className="service-provenance-field-header">
                <div>
                  <h3>{field.label}</h3>
                  <p>{field.value}</p>
                </div>
                <Badge tone={field.confidence >= 0.9 ? "success" : field.confidence >= 0.8 ? "info" : "warning"}>
                  {Math.round(field.confidence * 100)}%
                </Badge>
              </div>
              <dl className="service-provenance-meta">
                <div>
                  <dt>Method</dt>
                  <dd>{formatMethod(field.method)}</dd>
                </div>
                {field.span ? (
                  <div>
                    <dt>Span</dt>
                    <dd>
                      {field.span.start}-{field.span.end}
                    </dd>
                  </div>
                ) : null}
                {field.contentCid ? (
                  <div>
                    <dt>
                      <Hash aria-hidden="true" size={12} />
                      Content CID
                    </dt>
                    <dd title={field.contentCid}>{field.contentCid}</dd>
                  </div>
                ) : null}
              </dl>
              {field.span ? <blockquote className="service-source-span">{field.span.context}</blockquote> : null}
              {field.warnings.map((warning) => (
                <p className="service-provenance-warning" key={warning}>
                  {warning}
                </p>
              ))}
            </article>
          ))}
        </div>

        {metadataRows.length ? (
          <div className="list-stack">
            {metadataRows.map((row) => (
              <article className="list-item" key={row.label}>
                <div>
                  <h3>{row.label}</h3>
                  <p>{row.value || "Not listed"}</p>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function formatMethod(method: string): string {
  return method.replace(/_/g, " ");
}
