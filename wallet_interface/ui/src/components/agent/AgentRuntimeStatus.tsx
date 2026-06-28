import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Cloud, Cpu, Gauge, KeyRound, RefreshCw, Trash2, Zap } from "lucide-react";
import { SUPPORTED_CLIENT_LLM_MODELS, type ClientLlmModel } from "../../lib/llmConfig";

type ClientLlmDevice = "wasm" | "webgpu" | "auto";

interface ClientLlmRuntimeCapabilities {
  webGPU: boolean;
  webGPUError?: string;
  webGPUShaderF16?: boolean;
  webGPUAdapter?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
  };
  simd: boolean;
  wasmThreads: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
}

interface ClientLlmRuntimeStatus {
  hasWorker: boolean;
  isInitialized: boolean;
  isInitializing: boolean;
  currentModel: string;
  currentDevice: ClientLlmDevice;
  lastGenerationProvider?: "local" | "openrouter" | "huggingface";
  lastGenerationModel?: string;
  capabilities: ClientLlmRuntimeCapabilities;
  openRouter?: {
    enabled: boolean;
    configured: boolean;
    credentialSource: "browser" | "build" | "proxy" | "none";
    endpoint: string;
    model: string;
    fallbackDelayMs: number;
    lastError?: string;
    lastUsedAt?: string;
  };
  huggingFaceRouter?: {
    enabled: boolean;
    configured: boolean;
    endpoint: string;
    model: string;
    lastError?: string;
    lastUsedAt?: string;
  };
  error?: string;
}

interface ClientAudioRuntimeStatus {
  remoteAudioEnabled: boolean;
  remoteAudioConfigured: boolean;
  remoteAudioEndpoint: string;
  remoteAudioLastError?: string;
  remoteAudioLastUsedAt?: string;
  remoteAudioProxyMode?: string;
  localAudioEnabled: boolean;
  localAudioAvailable: boolean;
  localAudioReady: boolean;
  fallbackVoiceAvailable: boolean;
}

const unavailableCapabilities: ClientLlmRuntimeCapabilities = {
  webGPU: false,
  webGPUShaderF16: false,
  simd: false,
  wasmThreads: false,
  crossOriginIsolated: Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated),
  sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
};

const initialStatus: ClientLlmRuntimeStatus = {
  hasWorker: false,
  isInitialized: false,
  isInitializing: false,
  currentModel: "",
  currentDevice: "wasm",
  capabilities: unavailableCapabilities,
};

export function AgentRuntimeStatus({ open, showModelSelector = true }: { open: boolean; showModelSelector?: boolean }) {
  const [status, setStatus] = useState<ClientLlmRuntimeStatus>(initialStatus);
  const [audioStatus, setAudioStatus] = useState<ClientAudioRuntimeStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [openRouterKeyDraft, setOpenRouterKeyDraft] = useState("");
  const [loading, setLoading] = useState(false);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const { clientLLMWorkerService } = await import("../../lib/clientLLMWorkerService");
      const { clientAudioReplyService } = await import("../../lib/clientAudioReplyService");
      const [workerCapabilities, serviceStatus] = await Promise.all([
        clientLLMWorkerService.getCapabilities(),
        Promise.resolve(clientLLMWorkerService.getStatus()),
      ]);
      const nextStatus = {
        ...serviceStatus,
        currentDevice: workerCapabilities.device || serviceStatus.currentDevice,
        currentModel: workerCapabilities.modelName || serviceStatus.currentModel,
        isInitialized: Boolean(workerCapabilities.isInitialized ?? serviceStatus.isInitialized),
        capabilities: workerCapabilities.capabilities || serviceStatus.capabilities,
      };
      setStatus(nextStatus);
      setAudioStatus(clientAudioReplyService.getStatus());
      setSelectedModel(nextStatus.currentModel);
    } catch (error) {
      setStatus({
        ...initialStatus,
        error: error instanceof Error ? error.message : "Assistant runtime unavailable",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const switchModel = useCallback(async (modelName: ClientLlmModel) => {
    setSelectedModel(modelName);
    setLoading(true);
    try {
      const { clientLLMWorkerService } = await import("../../lib/clientLLMWorkerService");
      await clientLLMWorkerService.switchModel(modelName);
      await refreshStatus();
    } catch (error) {
      setStatus((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Assistant model switch failed",
      }));
    } finally {
      setLoading(false);
    }
  }, [refreshStatus]);

  const saveOpenRouterKey = useCallback(async () => {
    const apiKey = openRouterKeyDraft.trim();
    if (!apiKey) {
      return;
    }
    setLoading(true);
    try {
      const { clientLLMWorkerService } = await import("../../lib/clientLLMWorkerService");
      const openRouter = clientLLMWorkerService.saveOpenRouterApiKey(apiKey);
      setStatus((current) => ({ ...current, openRouter }));
      setOpenRouterKeyDraft("");
    } finally {
      setLoading(false);
    }
  }, [openRouterKeyDraft]);

  const clearOpenRouterKey = useCallback(async () => {
    setLoading(true);
    try {
      const { clientLLMWorkerService } = await import("../../lib/clientLLMWorkerService");
      const openRouter = clientLLMWorkerService.clearOpenRouterApiKey();
      setStatus((current) => ({ ...current, openRouter }));
      setOpenRouterKeyDraft("");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void refreshStatus();
  }, [open, refreshStatus]);

  const summary = useMemo(() => summarizeRuntime(status), [status]);
  const Icon = summary.backend === "webgpu" ? Zap : summary.backend === "wasm" ? Cpu : Gauge;

  return (
    <section
      aria-label="Assistant runtime status"
      className={`agent-runtime-status agent-runtime-status-${summary.tone}`}
    >
      <span aria-hidden="true" className="agent-runtime-icon">
        <Icon size={16} />
      </span>
      <div className="agent-runtime-summary">
        <small>{summary.label}</small>
        <span title={summary.detail}>{summary.detail}</span>
      </div>
      <dl className="agent-runtime-details" aria-label="Local inference details">
        <div>
          <dt>Model</dt>
          <dd title={status.currentModel}>{shortModelName(status.currentModel)}</dd>
        </div>
        <div>
          <dt>Threads</dt>
          <dd>{status.capabilities.wasmThreads ? "on" : "off"}</dd>
        </div>
        <div>
          <dt>Isolation</dt>
          <dd>{status.capabilities.crossOriginIsolated ? "on" : "off"}</dd>
        </div>
      </dl>
      {showModelSelector ? (
        <>
          <label className="agent-runtime-model-select">
            <span>Model</span>
            <select
              aria-label="Assistant language model"
              disabled={loading}
              onChange={(event) => void switchModel(event.target.value as ClientLlmModel)}
              value={selectedModel || status.currentModel}
            >
              {Object.entries(SUPPORTED_CLIENT_LLM_MODELS).map(([modelName, modelInfo]) => (
                <option key={modelName} value={modelName}>
                  {modelInfo.name} ({modelInfo.device}{modelInfo.requiresWebGPU ? " required" : ""})
                </option>
              ))}
            </select>
          </label>
          <div className="agent-runtime-openrouter">
            <label>
              <span>OpenRouter key</span>
              <div className="agent-runtime-openrouter-control">
                <input
                  aria-label="OpenRouter API key"
                  autoComplete="off"
                  disabled={loading}
                  onChange={(event) => setOpenRouterKeyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveOpenRouterKey();
                    }
                  }}
                  placeholder={status.openRouter?.configured ? "OpenRouter key saved" : "sk-or-v1-..."}
                  type="password"
                  value={openRouterKeyDraft}
                />
                <button
                  aria-label="Save OpenRouter API key"
                  className="agent-runtime-key-button"
                  disabled={loading || !openRouterKeyDraft.trim()}
                  onClick={() => void saveOpenRouterKey()}
                  type="button"
                >
                  {status.openRouter?.configured ? (
                    <Check aria-hidden="true" size={14} />
                  ) : (
                    <KeyRound aria-hidden="true" size={14} />
                  )}
                </button>
                <button
                  aria-label="Clear OpenRouter API key"
                  className="agent-runtime-key-button"
                  disabled={loading || status.openRouter?.credentialSource !== "browser"}
                  onClick={() => void clearOpenRouterKey()}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={14} />
                </button>
              </div>
            </label>
            <small className={status.openRouter?.configured ? "agent-runtime-cloud-ready" : undefined}>
              <Cloud aria-hidden="true" size={12} />
              {formatOpenRouterStatus(status.openRouter)}
            </small>
          </div>
          {audioStatus ? (
            <div className="agent-runtime-audio">
              <small className={audioStatus.remoteAudioConfigured ? "agent-runtime-cloud-ready" : undefined}>
                <Cloud aria-hidden="true" size={12} />
                {formatVoiceProxyStatus(audioStatus)}
              </small>
              <dl className="agent-runtime-details" aria-label="Voice proxy details">
                <div>
                  <dt>Voice proxy</dt>
                  <dd>{audioStatus.remoteAudioConfigured ? "ready" : audioStatus.remoteAudioEnabled ? "unreachable" : "off"}</dd>
                </div>
                <div>
                  <dt>Format</dt>
                  <dd>{audioStatus.remoteAudioProxyMode || "multipart-wav"}</dd>
                </div>
                <div>
                  <dt>Fallback</dt>
                  <dd>{audioStatus.localAudioReady ? "local ready" : audioStatus.fallbackVoiceAvailable ? "browser speech" : "none"}</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </>
      ) : null}
      <button
        aria-label="Refresh assistant runtime status"
        className="agent-runtime-refresh"
        disabled={loading}
        onClick={() => void refreshStatus()}
        type="button"
      >
        <RefreshCw aria-hidden="true" className={loading ? "loading-icon" : undefined} size={15} />
      </button>
    </section>
  );
}

function summarizeRuntime(status: ClientLlmRuntimeStatus): {
  backend: "webgpu" | "wasm" | "unknown";
  detail: string;
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  if (status.error) {
    return {
      backend: "unknown",
      detail: status.error,
      label: "Runtime unavailable",
      tone: "danger",
    };
  }
  if (status.currentDevice === "webgpu") {
    return {
      backend: "webgpu",
      detail: formatWebGpuDetail(status.capabilities),
      label: "WebGPU",
      tone: "success",
    };
  }
  if (status.capabilities.webGPU) {
    return {
      backend: "wasm",
      detail: status.capabilities.webGPUError || (status.isInitialized ? "WASM active" : "WebGPU available before model load"),
      label: status.isInitialized ? "WASM" : "WebGPU ready",
      tone: status.isInitialized ? "warning" : "success",
    };
  }
  return {
    backend: "wasm",
    detail: status.capabilities.webGPUError || "WebGPU unavailable; WASM fallback",
    label: "WASM fallback",
    tone: status.capabilities.webGPUError ? "warning" : "neutral",
  };
}

function shortModelName(modelName: string): string {
  if (!modelName) {
    return "not loaded";
  }
  const parts = modelName.split("/");
  return (parts[parts.length - 1] || modelName).replace(/-Instruct$/, "");
}

function formatAdapter(adapter: ClientLlmRuntimeCapabilities["webGPUAdapter"]): string {
  if (!adapter) {
    return "";
  }
  return [adapter.vendor, adapter.device || adapter.description, adapter.architecture].filter(Boolean).join(" ");
}

function formatWebGpuDetail(capabilities: ClientLlmRuntimeCapabilities): string {
  const adapter = formatAdapter(capabilities.webGPUAdapter) || "WebGPU active";
  return capabilities.webGPUShaderF16 ? `${adapter}; shader-f16` : `${adapter}; no shader-f16`;
}

function formatOpenRouterStatus(status: ClientLlmRuntimeStatus["openRouter"]): string {
  if (!status?.enabled) {
    return "cloud fallback off";
  }
  if (status.lastError) {
    return "cloud fallback error";
  }
  if (status.configured) {
    return `cloud fallback ready (${status.credentialSource})`;
  }
  return "configure HTTPS proxy for cloud fallback";
}

function formatVoiceProxyStatus(status: ClientAudioRuntimeStatus): string {
  if (!status.remoteAudioEnabled) {
    return "voice proxy off";
  }
  if (status.remoteAudioLastError) {
    return "voice proxy error";
  }
  if (status.remoteAudioConfigured) {
    return "voice proxy ready";
  }
  return "voice proxy unavailable";
}
