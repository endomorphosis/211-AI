import { ExternalLink, FileText, Hash, Route } from "lucide-react";
import type { EvidenceCitation } from "../../agent/types";
import { Button } from "../ui";

export interface AgentCitationLinkProps {
  citation: EvidenceCitation;
  title?: string;
  source?: string;
  score?: number;
  summary?: string;
  compact?: boolean;
  onOpenServiceDetail?: (docId: string) => void;
}

export function AgentCitationLink({
  citation,
  title,
  source,
  score,
  summary,
  compact = false,
  onOpenServiceDetail
}: AgentCitationLinkProps) {
  const sourceLabel = source || citation.url || "211 corpus";
  const sourceUrl = citation.url;
  const hasServiceRoute = Boolean(citation.docId && onOpenServiceDetail);
  const resolvedTitle = title?.trim() || citation.label.trim() || sourceLabel;
  const duplicatePrimaryText = normalizeCitationText(resolvedTitle) === normalizeCitationText(citation.label);
  const summaryText = compact ? buildCitationSummaryText(summary, sourceLabel) : summary?.trim();

  return (
    <div className={`agent-citation-link ${compact ? "agent-citation-link-compact" : ""}`}>
      <div className="agent-citation-primary">
        <span className="agent-citation-label">{citation.label}</span>
        {!duplicatePrimaryText ? <span className="agent-citation-title">{resolvedTitle}</span> : null}
        {summaryText ? <span className="agent-citation-summary">{summaryText}</span> : null}
      </div>

      <div className="agent-citation-actions" aria-label={`Evidence actions for ${resolvedTitle}`}>
        {hasServiceRoute ? (
          <Button
            ariaLabel={`Open service detail for ${resolvedTitle || citation.docId}`}
            className="agent-citation-button"
            onClick={() => onOpenServiceDetail?.(citation.docId ?? "")}
            variant="secondary"
          >
            <Route aria-hidden="true" size={14} />
            <span>Detail</span>
          </Button>
        ) : null}

        {sourceUrl ? (
          <a
            className="agent-citation-source-link"
            href={sourceUrl}
            rel="noreferrer"
            target="_blank"
            title={sourceUrl}
          >
            <ExternalLink aria-hidden="true" size={14} />
            <span>{compact ? "Source" : truncateMiddle(sourceLabel, 36)}</span>
          </a>
        ) : (
          <span className="agent-citation-source-link agent-citation-source-static" title={sourceLabel}>
            <FileText aria-hidden="true" size={14} />
            <span>{compact ? "Source" : truncateMiddle(sourceLabel, 36)}</span>
          </span>
        )}
      </div>

      <dl className="agent-citation-provenance">
        {citation.docId ? (
          <div>
            <dt>Doc ID</dt>
            <dd>{citation.docId}</dd>
          </div>
        ) : null}
        {citation.contentCid ? (
          <div>
            <dt>
              <Hash aria-hidden="true" size={12} />
              Content CID
            </dt>
            <dd title={citation.contentCid}>{citation.contentCid}</dd>
          </div>
        ) : null}
        {citation.pageCid ? (
          <div>
            <dt>
              <Hash aria-hidden="true" size={12} />
              Page CID
            </dt>
            <dd title={citation.pageCid}>{citation.pageCid}</dd>
          </div>
        ) : null}
        {typeof score === "number" ? (
          <div>
            <dt>Score</dt>
            <dd>{formatScore(score)}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function buildCitationSummaryText(summary?: string, source?: string): string | undefined {
  const summaryText = summary?.trim();
  const sourceText = source?.trim();
  if (summaryText && sourceText && normalizeCitationText(summaryText) !== normalizeCitationText(sourceText)) {
    return `${summaryText} · ${truncateMiddle(sourceText, 40)}`;
  }
  return summaryText || sourceText || undefined;
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "n/a";
  return score >= 1 ? score.toFixed(2) : `${Math.round(score * 100)}%`;
}

function normalizeCitationText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const edgeLength = Math.max(6, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, edgeLength)}...${value.slice(-edgeLength)}`;
}
