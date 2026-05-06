import { detectBrowserMlBackends } from "../lib/backendDetection";
import type { BackendDetectionOptions, BackendDetectionResult } from "../lib/backendDetection";
import { setupGlobalWarningSuppressions, suppressKnownBrowserMlWarnings } from "../lib/warningSuppressionUtils";

setupGlobalWarningSuppressions();

type BackendDetectionWorkerRequest =
  | {
      id: string;
      type: "detect";
      data?: BackendDetectionOptions;
    }
  | {
      id: string;
      type: "status";
      data?: Record<string, never>;
    };

interface BackendDetectionWorkerResponse {
  id: string;
  success: boolean;
  data?: {
    result?: BackendDetectionResult;
    ready?: boolean;
  };
  error?: string;
}

self.onmessage = async (event: MessageEvent<BackendDetectionWorkerRequest>) => {
  const { id, type, data } = event.data;

  try {
    if (type === "status") {
      postResponse({ id, success: true, data: { ready: true } });
      return;
    }

    if (type === "detect") {
      const result = await suppressKnownBrowserMlWarnings(() => detectBrowserMlBackends(data || {}));
      postResponse({ id, success: true, data: { result, ready: true } });
      return;
    }

    throw new Error(`Unknown backend detection worker request: ${type}`);
  } catch (error) {
    postResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : "Backend detection worker failed",
    });
  }
};

function postResponse(response: BackendDetectionWorkerResponse): void {
  self.postMessage(response);
}

export {};
