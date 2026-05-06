import type { AppActionResult, AppActionRuntime } from "../../app/appActions";
import type { OpenServiceDetailCommandInput } from "../commandSchemas";

const serviceDetailHashPrefix = "#/services/";

export function getCanonicalServiceDetailHash(docId: string): string {
  return `${serviceDetailHashPrefix}${encodeURIComponent(docId.trim())}`;
}

export function getServiceDetailDocIdFromHash(
  hash = typeof window === "undefined" ? "" : window.location.hash
): string | null {
  if (!hash.startsWith(serviceDetailHashPrefix)) return null;
  const encodedDocId = hash.slice(serviceDetailHashPrefix.length).split("/")[0];
  if (!encodedDocId) return null;
  try {
    return decodeURIComponent(encodedDocId);
  } catch {
    return encodedDocId;
  }
}

export function setLocationServiceDetailHash(docId: string): void {
  if (typeof window === "undefined") return;
  window.location.hash = getCanonicalServiceDetailHash(docId);
}

export async function openServiceDetailAction(
  runtime: AppActionRuntime,
  input: OpenServiceDetailCommandInput
): Promise<AppActionResult> {
  const docId = input.docId.trim();
  setLocationServiceDetailHash(docId);
  runtime.setServiceDetailDocId?.(docId);
  runtime.setActiveRoute?.("social-services");
  runtime.setMobileNavOpen?.(false);
  return {
    ok: true,
    action: "open_service_detail",
    summary: `Opened service ${docId}.`,
    route: "social-services",
    artifactId: docId,
    metadata: {
      canonicalRoute: getCanonicalServiceDetailHash(docId)
    }
  };
}
