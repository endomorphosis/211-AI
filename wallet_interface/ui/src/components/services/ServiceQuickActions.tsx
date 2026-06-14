import { ExternalLink, MapPinned, Phone } from "lucide-react";
import type { CorpusDocument } from "../../lib/graphrag";
import { t, type SupportedLocale } from "../../lib/localization";
import {
  getPrimaryAddress,
  getPrimaryIntakeText,
  getPrimaryMapQuery,
  getPrimaryPhone,
  getPrimaryWebsite,
} from "../../lib/graphrag";
import { buildCallAction, buildMapAction } from "../../services/serviceActionService";

export function ServiceQuickActions({
  document,
  className = "row-actions",
  includeApply = true,
  siteLocale,
}: {
  document: CorpusDocument;
  className?: string;
  includeApply?: boolean;
  siteLocale: SupportedLocale;
}) {
  const primaryPhone = getPrimaryPhone(document);
  const primaryAddress = getPrimaryAddress(document);
  const primaryWebsite = getPrimaryWebsite(document);
  const intakeText = getPrimaryIntakeText(document);
  const callAction = buildCallAction({
    phone: primaryPhone?.value,
    context: {
      serviceDocId: document.doc_id,
      providerName: document.provider_name,
      programName: document.program_name || document.title,
      sourceUrl: document.source_url,
      sourceContentCid: document.source_content_cid,
      sourcePageCid: document.source_page_cid,
    },
  });
  const mapAction = buildMapAction({
    query: getPrimaryMapQuery(document),
    address: primaryAddress?.address,
    context: {
      serviceDocId: document.doc_id,
      providerName: document.provider_name,
      programName: document.program_name || document.title,
      sourceUrl: document.source_url,
      sourceContentCid: document.source_content_cid,
      sourcePageCid: document.source_page_cid,
    },
  });

  return (
    <div className={className}>
      {callAction.href ? (
        <a className="button button-secondary" href={callAction.href}>
          <Phone aria-hidden="true" size={18} />
          {t(siteLocale, "action.call")}
        </a>
      ) : null}
      {mapAction.href ? (
        <a className="button button-secondary" href={mapAction.href} rel={mapAction.rel} target={mapAction.target}>
          <MapPinned aria-hidden="true" size={18} />
          {t(siteLocale, "action.directions")}
        </a>
      ) : null}
      {includeApply && primaryWebsite ? (
        <a className="button button-secondary" href={primaryWebsite} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" size={18} />
          {intakeText ? t(siteLocale, "action.applyInfo") : t(siteLocale, "action.website")}
        </a>
      ) : null}
    </div>
  );
}
