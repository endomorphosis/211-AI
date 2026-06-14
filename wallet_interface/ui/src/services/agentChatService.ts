import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AppActionRuntime } from "../app/appActions";
import type { RouteId } from "../models/abby";
import type {
  AgentChatController,
  AgentChatControllerOptions,
  AgentChatSnapshot
} from "../agent/chatController";
import { createAgentChatController } from "../agent/chatController";
import type { AgentSurfaceApi } from "../agent/surfaceApi";
import { createAgentSurfaceApi } from "../agent/surfaceApi";

export type AgentChatService = AgentChatController;

export type AgentChatServiceOptions = Omit<AgentChatControllerOptions, "surfaceApi"> & {
  surfaceApi?: AgentSurfaceApi;
};

export interface AgentChatServiceHandle {
  service: AgentChatService;
  snapshot: AgentChatSnapshot;
  messages: AgentChatSnapshot["messages"];
  progress: AgentChatSnapshot["progress"];
  pendingConfirmations: AgentChatSnapshot["pendingConfirmations"];
  responding: boolean;
  lastError: AgentChatSnapshot["lastError"];
  canRetry: boolean;
  sendMessage: AgentChatService["sendMessage"];
  approveConfirmation: AgentChatService["approveConfirmation"];
  denyConfirmation: AgentChatService["denyConfirmation"];
  retry: AgentChatService["retry"];
  resetError: AgentChatService["resetError"];
  patchMessageMetadata: AgentChatService["patchMessageMetadata"];
}

export function createAgentChatService(
  runtimeOrSurfaceApi: AppActionRuntime | AgentSurfaceApi,
  options: AgentChatServiceOptions = {}
): AgentChatService {
  const surfaceApi = options.surfaceApi ?? toSurfaceApi(runtimeOrSurfaceApi);
  return createAgentChatController({
    ...options,
    surfaceApi
  });
}

export function useAgentChatService(
  runtime: AppActionRuntime,
  options: AgentChatServiceOptions = {}
): AgentChatServiceHandle {
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const stableRuntime = useMemo<AppActionRuntime>(
    () => ({
      getState: () => runtimeRef.current.getState(),
      setActiveRoute: (route) => runtimeRef.current.setActiveRoute?.(route),
      setServiceDetailDocId: (docId) => runtimeRef.current.setServiceDetailDocId?.(docId),
      setMobileNavOpen: (open) => runtimeRef.current.setMobileNavOpen?.(open),
      setProfile: (profile) => runtimeRef.current.setProfile?.(profile),
      setPolicy: (policy) => runtimeRef.current.setPolicy?.(policy),
      setRecipients: (recipients) => runtimeRef.current.setRecipients?.(recipients),
      setShelterContactRequests: (requests) => runtimeRef.current.setShelterContactRequests?.(requests),
      setShelterStaffAccounts: (accounts) => runtimeRef.current.setShelterStaffAccounts?.(accounts),
      setShelterUserAccounts: (accounts) => runtimeRef.current.setShelterUserAccounts?.(accounts),
      setUploads: (uploads) => runtimeRef.current.setUploads?.(uploads),
      setAccessRequests: (requests) => runtimeRef.current.setAccessRequests?.(requests),
      setGrantReceipts: (receipts) => runtimeRef.current.setGrantReceipts?.(receipts),
      setWalletAuditEvents: (events) => runtimeRef.current.setWalletAuditEvents?.(events),
      setAnalyticsOptIn: (optedIn) => runtimeRef.current.setAnalyticsOptIn?.(optedIn),
      setWalletProofReceipts: (proofs) => runtimeRef.current.setWalletProofReceipts?.(proofs),
      setExportBundleViews: (bundles) => runtimeRef.current.setExportBundleViews?.(bundles),
      setSavedServices: (services) => runtimeRef.current.setSavedServices?.(services),
      setServicePlans: (plans) => runtimeRef.current.setServicePlans?.(plans),
      setServiceInteractions: (interactions) => runtimeRef.current.setServiceInteractions?.(interactions),
      get walletApiConfig() {
        return runtimeRef.current.walletApiConfig;
      },
      refreshWalletAccessState: () => runtimeRef.current.refreshWalletAccessState?.() ?? Promise.resolve(),
      refreshWalletAuditEvents: () => runtimeRef.current.refreshWalletAuditEvents?.() ?? Promise.resolve()
    }),
    []
  );

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const service = useMemo(
    () =>
      createAgentChatService(stableRuntime, {
        ...optionsRef.current,
        surfaceApi: optionsRef.current.surfaceApi
      }),
    [stableRuntime]
  );

  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const activeRoute = runtime.getState().activeRoute;

  useEffect(() => {
    service.setActiveRoute(activeRoute);
  }, [activeRoute, service]);

  return toHandle(service, snapshot);
}

export function useAgentChatServiceSnapshot(service: AgentChatService): AgentChatServiceHandle {
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  return toHandle(service, snapshot);
}

function toSurfaceApi(runtimeOrSurfaceApi: AppActionRuntime | AgentSurfaceApi): AgentSurfaceApi {
  if (isAgentSurfaceApi(runtimeOrSurfaceApi)) return runtimeOrSurfaceApi;
  return createAgentSurfaceApi(runtimeOrSurfaceApi);
}

function isAgentSurfaceApi(value: AppActionRuntime | AgentSurfaceApi): value is AgentSurfaceApi {
  return (
    typeof (value as AgentSurfaceApi).getContext === "function" &&
    typeof (value as AgentSurfaceApi).invokeToolCall === "function"
  );
}

function toHandle(service: AgentChatService, snapshot: AgentChatSnapshot): AgentChatServiceHandle {
  return {
    service,
    snapshot,
    messages: snapshot.messages,
    progress: snapshot.progress,
    pendingConfirmations: snapshot.pendingConfirmations,
    responding: snapshot.responding,
    lastError: snapshot.lastError,
    canRetry: snapshot.canRetry,
    sendMessage: service.sendMessage,
    approveConfirmation: service.approveConfirmation,
    denyConfirmation: service.denyConfirmation,
    retry: service.retry,
    resetError: service.resetError,
    patchMessageMetadata: service.patchMessageMetadata,
  };
}

export function syncAgentChatRoute(service: AgentChatService, route: RouteId) {
  service.setActiveRoute(route);
}
