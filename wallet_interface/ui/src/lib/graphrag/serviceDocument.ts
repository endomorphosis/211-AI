import type {
  CorpusDocument,
  ServiceAddress,
  ServiceContactPoint,
  ServiceExtractValue,
} from "./types";

export function isServiceDocument(document: CorpusDocument): boolean {
  return document.doc_type === "service";
}

export function getServicePhones(document: CorpusDocument): ServiceContactPoint[] {
  return Array.isArray(document.phones) ? document.phones.filter(isContactPoint) : [];
}

export function getServiceEmails(document: CorpusDocument): ServiceContactPoint[] {
  return Array.isArray(document.emails) ? document.emails.filter(isContactPoint) : [];
}

export function getServiceWebsites(document: CorpusDocument): ServiceContactPoint[] {
  return Array.isArray(document.websites) ? document.websites.filter(isContactPoint) : [];
}

export function getServiceAddresses(document: CorpusDocument): ServiceAddress[] {
  return Array.isArray(document.addresses) ? document.addresses.filter(isAddress) : [];
}

export function getServiceExtractValues(
  values: ServiceExtractValue[] | undefined,
): ServiceExtractValue[] {
  return Array.isArray(values) ? values.filter(isExtractValue) : [];
}

export function getPrimaryPhone(document: CorpusDocument): ServiceContactPoint | null {
  return firstBy(getServicePhones(document), (item) => item.tel_url || item.value);
}

export function getPrimaryWebsite(document: CorpusDocument): string {
  const website = firstBy(getServiceWebsites(document), (item) => item.url || item.value);
  return normalizeString(website?.url || website?.value || document.source_url);
}

export function getPrimaryAddress(document: CorpusDocument): ServiceAddress | null {
  return firstBy(getServiceAddresses(document), (item) => item.maps_query || item.address || item.city);
}

export function getServiceLocationLabel(document: CorpusDocument): string {
  const address = getPrimaryAddress(document);
  return (
    normalizeString(address?.address) ||
    normalizeString(address?.maps_query) ||
    [document.city, document.state].filter(Boolean).join(", ")
  );
}

export function getPrimaryMapQuery(document: CorpusDocument): string {
  const address = getPrimaryAddress(document);
  return (
    normalizeString(address?.maps_query) ||
    normalizeString(address?.address) ||
    getServiceLocationLabel(document)
  );
}

export function getPrimaryIntakeText(document: CorpusDocument): string {
  return getServiceExtractValues(document.intake_steps)
    .map((item) => normalizeString(item.value))
    .find(Boolean) || "";
}

export function getPrimaryEligibilityText(document: CorpusDocument): string {
  return getServiceExtractValues(document.eligibility)
    .map((item) => normalizeString(item.value))
    .find(Boolean) || "";
}

export function getPrimaryRequiredDocumentsText(document: CorpusDocument): string {
  return getServiceExtractValues(document.required_documents)
    .map((item) => normalizeString(item.value))
    .find(Boolean) || "";
}

export function getServiceAreaServedText(document: CorpusDocument): string {
  return getServiceExtractValues(document.area_served)
    .map((item) => normalizeString(item.value))
    .filter(Boolean)
    .join("; ");
}

export function getServiceTravelInfoText(document: CorpusDocument): string {
  return getServiceExtractValues(document.travel_info)
    .map((item) => normalizeString(item.value))
    .filter(Boolean)
    .join("; ");
}

export function getServiceSearchMetadataText(document: CorpusDocument): string {
  const parts = [
    document.provider_name,
    document.program_name,
    document.title,
    document.categories,
    document.city,
    document.state,
    getServiceLocationLabel(document),
    getPrimaryMapQuery(document),
    getServiceAreaServedText(document),
    getServiceTravelInfoText(document),
    getPrimaryIntakeText(document),
    getPrimaryEligibilityText(document),
    getPrimaryRequiredDocumentsText(document),
  ];
  return parts
    .map(normalizeString)
    .filter(Boolean)
    .join(" ");
}

export function getServiceRichnessScore(document: CorpusDocument): number {
  let score = 0;
  if (getServicePhones(document).length > 0) score += 0.08;
  if (getServiceAddresses(document).length > 0) score += 0.08;
  if (getServiceWebsites(document).length > 0) score += 0.04;
  if (getServiceExtractValues(document.intake_steps).length > 0) score += 0.08;
  if (getServiceExtractValues(document.required_documents).length > 0) score += 0.04;
  if (getServiceExtractValues(document.area_served).length > 0) score += 0.04;
  return score;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstBy<T>(items: T[], predicate: (item: T) => unknown): T | null {
  for (const item of items) {
    if (predicate(item)) {
      return item;
    }
  }
  return null;
}

function isContactPoint(value: ServiceContactPoint | undefined): value is ServiceContactPoint {
  return Boolean(value && (value.value || value.url || value.tel_url || value.sms_url));
}

function isAddress(value: ServiceAddress | undefined): value is ServiceAddress {
  return Boolean(value && (value.address || value.maps_query || value.city || value.state));
}

function isExtractValue(value: ServiceExtractValue | undefined): value is ServiceExtractValue {
  return Boolean(value && value.value);
}
