import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";
import type { AgentMessage, EvidenceBundle } from "../../agent/types";
import type { AgentMessageAudioRecord } from "../../agent/chatController";
import type { ClientAudioProgress, ClientAudioReplyResult, ClientVoiceReplyRequest } from "../../lib/clientAudioReplyService";
import { clientAudioReplyService } from "../../lib/clientAudioReplyService";
import { clientLLMWorkerService } from "../../lib/clientLLMWorkerService";
import { findPrecomputedAudioReply } from "../../lib/precomputedAudioReplyService";
import { AgentCitationLink } from "./AgentCitationLink";
import {
  buildVoiceFallbackText,
  buildVoiceGraphRagPromptParts,
  selectEvidenceBundlesForMessage,
} from "../../lib/voiceGraphRagPrompt";
import { createWavBlobFromFloat32Chunks } from "../../lib/voiceProxyPayload";
import { preflightRemoteSpeechToTextProxy, transcribeRemoteSpeech } from "../../lib/remoteAudioClient";
import { Button } from "../ui";

type AudioSessionState = "ready" | "monitoring" | "listening" | "thinking" | "speaking" | "unavailable";
type AgentAudioSurface = "drawer" | "sheet";
type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;
type BrowserAudioContextConstructor = new () => BrowserAudioContext;
type BrowserAudioWorklet = { addModule: (moduleUrl: string) => Promise<void> };
type BrowserAudioWorkletNode = AudioWorkletNode;

const AUDIO_SURFACE_DESKTOP_QUERY = "(min-width: 760px)";
const AUDIO_OPENING_GREETING = "Welcome to Abby voice. You can start speaking when you are ready.";
const AUDIO_OPENING_CLIP_PATH = "assets/audio/intro.wav?v=20260515-abby-intro";
const VAD_MIN_RMS = 0.025;
const VAD_NOISE_MULTIPLIER = 3.2;
const VAD_VOICE_BAND_RATIO = 0.38;
const VAD_TRIGGER_FRAMES = 5;
const VAD_RETRIGGER_COOLDOWN_MS = 1200;
const MIC_CAPTURE_WORKLET_NAME = "abby-voice-capture-processor";
const VOICE_RESPONSE_MAX_TOKENS = 512;
const SPEECH_RECOGNITION_WARMUP_ABORT_MS = 180;
const SPEECH_RECOGNITION_WARMUP_COOLDOWN_MS = 8000;
const REMOTE_STT_CAPTURE_DURATION_MS = 4200;
const REMOTE_STT_PREFLIGHT_CACHE_MS = 60_000;
const MIC_CAPTURE_WORKLET_SOURCE = `
class AbbyVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const channel = input?.[0];
    if (channel?.length) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    if (output?.[0]) {
      output[0].fill(0);
    }
    return true;
  }
}

registerProcessor("abby-voice-capture-processor", AbbyVoiceCaptureProcessor);
`;
let openingGreetingReservedForCurrentOpen = false;
let primedOpeningClipAudio: HTMLAudioElement | null = null;
let primedOpeningClipPromise: Promise<HTMLAudioElement | null> | null = null;
let lastSpeechRecognitionWarmupAt = 0;
let remoteSpeechToTextPreflightPromise: Promise<boolean> | null = null;
let remoteSpeechToTextPreflightReadyUntil = 0;

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  abort: () => void;
  start: () => void;
  stop: () => void;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0?: {
      transcript?: string;
    };
  }>;
}

export function resolveAudioOpeningClipUrl(
  documentBaseUri?: string,
  baseUrl = String(import.meta.env?.BASE_URL || "/"),
): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const baseReference = documentBaseUri || (typeof document !== "undefined" ? document.baseURI : undefined);
  const relativePath = `${normalizedBase}${AUDIO_OPENING_CLIP_PATH}`;
  return baseReference ? new URL(relativePath, baseReference).toString() : relativePath;
}

function tryResolveAudioOpeningClipUrl(): string | null {
  try {
    return resolveAudioOpeningClipUrl();
  } catch {
    return null;
  }
}

export function primeVoiceChatActivation(): void {
  resetOpeningGreetingReservation();
  void primeOpeningClipPlayback();
  warmupSpeechRecognition();
}

export function reserveOpeningGreetingForCurrentOpen(): boolean {
  if (openingGreetingReservedForCurrentOpen) {
    return false;
  }
  openingGreetingReservedForCurrentOpen = true;
  return true;
}

export function resetOpeningGreetingReservation(): void {
  openingGreetingReservedForCurrentOpen = false;
}

interface BrowserAudioContext {
  sampleRate?: number;
  state?: AudioContextState;
  audioWorklet?: BrowserAudioWorklet;
  close: () => Promise<void>;
  createAnalyser: () => AnalyserNode;
  createBiquadFilter?: () => BiquadFilterNode;
  createGain?: () => GainNode;
  createMediaStreamSource: (stream: MediaStream) => MediaStreamAudioSourceNode;
  decodeAudioData?: (audioData: ArrayBuffer) => Promise<AudioBuffer>;
  destination: AudioDestinationNode;
  resume?: () => Promise<void>;
}

export function AgentAudioChatSurface({
  activeRouteLabel,
  evidenceBundles = [],
  messages,
  open,
  responding,
  surface = "drawer",
  onClose,
  onSend,
  onAudioReply,
}: {
  activeRouteLabel: string;
  evidenceBundles?: EvidenceBundle[];
  messages: AgentMessage[];
  open: boolean;
  responding?: boolean;
  surface?: AgentAudioSurface;
  onClose: () => void;
  onSend: (message: string) => void;
  onAudioReply?: (messageId: string, record: AgentMessageAudioRecord) => void;
}) {
  const [sessionState, setSessionState] = useState<AudioSessionState>("ready");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [modelProgress, setModelProgress] = useState<ClientAudioProgress | null>(null);
  const [muted, setMuted] = useState(false);
  const [statusDetail, setStatusDetail] = useState("");
  const [audioDiagnostic, setAudioDiagnostic] = useState("");
  const [voiceDetectionEnabled, setVoiceDetectionEnabled] = useState(true);
  const finalTranscriptRef = useRef("");
  const pendingVoiceTranscriptRef = useRef("");
  const audioProgressRequestIdRef = useRef(0);
  const lastSpokenAssistantIdRef = useRef<string | undefined>(getLastAssistantMessage(messages)?.id);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAudioContextRef = useRef<BrowserAudioContext | null>(null);
  const micDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const micFrequencyDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const micFilterNodesRef = useRef<Array<{ disconnect: () => void }>>([]);
  const micRafRef = useRef<number | null>(null);
  const micSampleRateRef = useRef(48000);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCaptureWorkletRef = useRef<BrowserAudioWorkletNode | null>(null);
  const micCaptureSinkRef = useRef<GainNode | null>(null);
  const micCaptureChunksRef = useRef<Float32Array[]>([]);
  const micCaptureEnabledRef = useRef(false);
  const remoteSpeechCaptureTimeoutRef = useRef<number | null>(null);
  const lastCapturedVoiceBlobRef = useRef<Blob | null>(null);
  const mutedRef = useRef(muted);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioUrlIsObjectRef = useRef(false);
  const playbackAudioContextRef = useRef<BrowserAudioContext | null>(null);
  const playbackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const sessionStateRef = useRef(sessionState);
  const openRef = useRef(open);
  const detectVoiceActivityRef = useRef(false);
  const vadNoiseFloorRef = useRef(0.018);
  const vadSpeechFramesRef = useRef(0);
  const vadLastTriggerAtRef = useRef(0);
  const voiceDetectionEnabledRef = useRef(voiceDetectionEnabled);
  const audioOutputReadyRef = useRef(false);
  const speakingAssistantIdRef = useRef<string | null>(null);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    sessionStateRef.current = sessionState;
  }, [sessionState]);

  useEffect(() => {
    voiceDetectionEnabledRef.current = voiceDetectionEnabled;
  }, [voiceDetectionEnabled]);

  useEffect(() => {
    const handleUnhandledPlaybackInterruption = (event: PromiseRejectionEvent) => {
      if (!isInterruptedPlaybackError(event.reason)) return;
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", handleUnhandledPlaybackInterruption);
    return () => window.removeEventListener("unhandledrejection", handleUnhandledPlaybackInterruption);
  }, []);

  useEffect(() => {
    if (open && !openRef.current) {
      resetOpeningGreetingReservation();
      lastSpokenAssistantIdRef.current = getLastAssistantMessage(messages)?.id;
      audioOutputReadyRef.current = false;
      setSessionState("ready");
      setStatusDetail("");
      setAudioDiagnostic("");
      setMicLevel(0);
      setVoiceDetectionEnabled(true);
      voiceDetectionEnabledRef.current = true;
      resetVoiceActivityDetector();
    }
    if (!open && openRef.current) {
      audioProgressRequestIdRef.current += 1;
      voiceDetectionEnabledRef.current = false;
      audioOutputReadyRef.current = false;
      speakingAssistantIdRef.current = null;
      cancelListening();
      stopPlayback();
      pendingVoiceTranscriptRef.current = "";
      setInterimTranscript("");
      setModelProgress(null);
      setAudioDiagnostic("");
      setMicLevel(0);
      resetVoiceActivityDetector();
    }
    openRef.current = open;
  }, [messages, open]);

  useEffect(() => {
    if (!open || !isAudioSurfaceActive(surface)) return;
    const requestId = ++audioProgressRequestIdRef.current;
    setAudioDiagnostic("");
    void clientAudioReplyService
      .warmUp({
        onProgress: (progress) => updateModelProgress(requestId, progress),
      })
      .then((result) => {
        if (audioProgressRequestIdRef.current !== requestId || !openRef.current) return;
        setModelProgress(null);
        if (result.kind === "local-ready") {
          audioOutputReadyRef.current = true;
          setStatusDetail("Audio model ready.");
          setAudioDiagnostic("");
        } else if (result.kind === "remote-ready") {
          audioOutputReadyRef.current = true;
          setStatusDetail("Voice proxy ready.");
          setAudioDiagnostic("");
        } else {
          audioOutputReadyRef.current = false;
          setStatusDetail("Browser speech output ready.");
          setAudioDiagnostic(result.fallbackReason);
        }
      })
      .catch((error) => {
        if (audioProgressRequestIdRef.current !== requestId || !openRef.current) return;
        audioOutputReadyRef.current = false;
        const message = error instanceof Error ? error.message : "Audio model warmup failed.";
        setModelProgress(null);
        setStatusDetail(message);
        setAudioDiagnostic(message);
      });
  }, [open, surface]);

  useEffect(() => {
    if (!open || !voiceDetectionEnabled || !isAudioSurfaceActive(surface)) return;
    warmupSpeechRecognition();
    const run = () => {
      if (!openRef.current || !voiceDetectionEnabledRef.current) return;
      if (!mutedRef.current && reserveOpeningGreetingForCurrentOpen()) {
        sessionStateRef.current = "speaking";
        setSessionState("speaking");
        setStatusDetail("Testing voice output.");
        void playOpeningClip(() => {
          void startVoiceActivityDetection();
        });
        return;
      }
      void startVoiceActivityDetection();
    };
    run();
    return undefined;
  }, [open, surface, voiceDetectionEnabled]);

  useEffect(() => {
    if (!open || muted || responding || !isAudioSurfaceActive(surface)) return;
    const assistantMessage = getLastAssistantMessage(messages);
    if (!assistantMessage || assistantMessage.id === lastSpokenAssistantIdRef.current) return;
    if (assistantMessage.id === speakingAssistantIdRef.current) return;
    speakingAssistantIdRef.current = assistantMessage.id;
    void speakAssistantMessage(assistantMessage).finally(() => {
      if (speakingAssistantIdRef.current === assistantMessage.id) {
        lastSpokenAssistantIdRef.current = assistantMessage.id;
        speakingAssistantIdRef.current = null;
      }
    });
  }, [evidenceBundles, messages, muted, open, responding, surface]);

  useEffect(() => {
    if (responding && open) {
      setSessionState("thinking");
    } else if (sessionState === "thinking") {
      setSessionState("ready");
    }
  }, [open, responding, sessionState]);

  async function startVoiceActivityDetection() {
    if (
      !openRef.current ||
      !voiceDetectionEnabledRef.current ||
      recognitionRef.current ||
      responding ||
      sessionStateRef.current === "thinking" ||
      sessionStateRef.current === "speaking"
    ) {
      return;
    }
    resetVoiceActivityDetector();
    const microphoneReady = await startMicrophoneMeter({ detectVoiceActivity: true });
    if (!microphoneReady || !openRef.current || !voiceDetectionEnabledRef.current) return;
    setSessionState("monitoring");
    if (!getSpeechRecognitionConstructor()) {
      setStatusDetail("Listening for speech with remote transcription.");
      return;
    }
    setStatusDetail("Listening for speech.");
  }

  async function startListening({ fromVoiceActivity = false }: { fromVoiceActivity?: boolean } = {}) {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      stopPlayback();
      if (fromVoiceActivity) {
        detectVoiceActivityRef.current = false;
      } else {
        setVoiceDetectionEnabled(true);
        voiceDetectionEnabledRef.current = true;
        const microphoneReady = await startMicrophoneMeter({ detectVoiceActivity: false });
        if (!microphoneReady || !openRef.current) return;
      }
      setStatusDetail("Checking speech-to-text proxy.");
      const remoteSpeechReady = await preflightRemoteSpeechToText();
      if (!remoteSpeechReady) {
        setSessionState("unavailable");
        setStatusDetail("Speech recognition is unavailable and speech-to-text proxy is not ready.");
        stopMicrophoneMeter();
        return;
      }
      startRemoteSpeechCaptureSession();
      return;
    }
    stopPlayback();
    if (fromVoiceActivity) {
      detectVoiceActivityRef.current = false;
    } else {
      setVoiceDetectionEnabled(true);
      voiceDetectionEnabledRef.current = true;
      const microphoneReady = await startMicrophoneMeter({ detectVoiceActivity: false });
      if (!microphoneReady || !openRef.current) return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    finalTranscriptRef.current = "";
    setInterimTranscript("");
    beginVoiceCapture();
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalTranscriptRef.current = `${finalTranscriptRef.current} ${text}`.trim();
        } else {
          interim = `${interim} ${text}`.trim();
        }
      }
      setInterimTranscript(interim || finalTranscriptRef.current);
    };
    recognition.onerror = (event) => {
      finalizeVoiceCapture(false);
      setSessionState("ready");
      setStatusDetail(formatSpeechRecognitionError(event.error));
      stopMicrophoneMeter();
      if (event.error === "no-speech") {
        restartVoiceActivityDetectionSoon();
      }
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      finalizeVoiceCapture(true);
      stopMicrophoneMeter();
      void handleSpeechRecognitionEnd(finalTranscriptRef.current.trim());
    };
    recognitionRef.current = recognition;
    setSessionState("listening");
    setStatusDetail("");
    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      stopMicrophoneMeter();
      setSessionState("ready");
      setStatusDetail(error instanceof Error ? error.message : "Voice input could not start.");
    }
  }

  function stopListening() {
    setVoiceDetectionEnabled(false);
    voiceDetectionEnabledRef.current = false;
    const recognition = recognitionRef.current;
    if (!recognition) {
      if (micCaptureEnabledRef.current) {
        void finishRemoteSpeechCaptureSession(true);
        return;
      }
      stopMicrophoneMeter();
      setSessionState("ready");
      setStatusDetail("Voice detection paused.");
      return;
    }
    try {
      recognition.stop();
    } catch {
      recognition.abort();
      recognitionRef.current = null;
      stopMicrophoneMeter();
      setSessionState("ready");
    }
  }

  async function handleSpeechRecognitionEnd(browserTranscript: string) {
    setInterimTranscript("");
    const capturedAudio = lastCapturedVoiceBlobRef.current;
    const transcript = await resolveSpeechToTextTranscript(capturedAudio, browserTranscript);
    if (transcript) {
      pendingVoiceTranscriptRef.current = transcript;
      onSend(transcript);
      setSessionState("thinking");
      setStatusDetail("");
    } else {
      setSessionState("ready");
      restartVoiceActivityDetectionSoon();
    }
  }

  async function resolveSpeechToTextTranscript(audioBlob: Blob | null, browserTranscript: string): Promise<string> {
    if (!audioBlob) return browserTranscript;
    try {
      setStatusDetail("Checking speech-to-text proxy.");
      const ready = await preflightRemoteSpeechToText();
      if (!ready) return browserTranscript;
      setStatusDetail("Transcribing speech.");
      const result = await transcribeRemoteSpeech({
        audioBlob,
        language: navigator.language || "en-US",
      });
      const remoteTranscript = result.text.trim();
      return remoteTranscript || browserTranscript;
    } catch (error) {
      console.warn("[Abby] Remote speech-to-text unavailable; using browser/local speech fallback.", error);
      clientAudioReplyService.markRemoteSpeechToTextPreflight(false, error);
      remoteSpeechToTextPreflightPromise = null;
      remoteSpeechToTextPreflightReadyUntil = 0;
      return browserTranscript;
    }
  }

  function cancelListening() {
    const recognition = recognitionRef.current;
    if (!recognition) {
      clearRemoteSpeechCaptureTimeout();
      finalizeVoiceCapture(false);
      stopMicrophoneMeter();
      return;
    }
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onresult = null;
    finalizeVoiceCapture(false);
    recognition.abort();
    recognitionRef.current = null;
    stopMicrophoneMeter();
  }

  async function setupVoiceCaptureNode(audioContext: BrowserAudioContext, source: MediaStreamAudioSourceNode, silentSink: GainNode): Promise<boolean> {
    if (typeof AudioWorkletNode !== "undefined" && audioContext.audioWorklet) {
      const moduleUrl = URL.createObjectURL(new Blob([MIC_CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await audioContext.audioWorklet.addModule(moduleUrl);
        const worklet = new AudioWorkletNode(audioContext as unknown as AudioContext, MIC_CAPTURE_WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        }) as BrowserAudioWorkletNode;
        source.connect(worklet);
        worklet.connect(silentSink);
        silentSink.connect(audioContext.destination);
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (!micCaptureEnabledRef.current) return;
          const chunk = event.data;
          if (!chunk?.length) return;
          micCaptureChunksRef.current.push(new Float32Array(chunk));
        };
        micCaptureWorkletRef.current = worklet;
        return true;
      } catch {
        micCaptureWorkletRef.current = null;
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
    }
    micCaptureWorkletRef.current = null;
    return true;
  }

  async function startMicrophoneMeter({ detectVoiceActivity }: { detectVoiceActivity: boolean }): Promise<boolean> {
    stopMicrophoneMeter();
    if (!navigator.mediaDevices?.getUserMedia) {
      setSessionState("unavailable");
      setStatusDetail("Microphone input is not available in this browser.");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStreamRef.current = stream;
      const AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) {
        setStatusDetail("Microphone connected; input level meter is unavailable.");
        return true;
      }
      const audioContext = new AudioContextConstructor();
      if (audioContext.state === "suspended" && audioContext.resume) {
        await audioContext.resume();
      }
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      const source = audioContext.createMediaStreamSource(stream);
      const silentSink = audioContext.createGain?.() || null;
      const highPass = audioContext.createBiquadFilter?.();
      const lowPass = audioContext.createBiquadFilter?.();
      if (highPass && lowPass) {
        highPass.type = "highpass";
        highPass.frequency.value = 85;
        lowPass.type = "lowpass";
        lowPass.frequency.value = 3400;
        source.connect(highPass);
        highPass.connect(lowPass);
        lowPass.connect(analyser);
        micFilterNodesRef.current = [highPass, lowPass];
      } else {
        source.connect(analyser);
        micFilterNodesRef.current = [];
      }
      if (silentSink) {
        silentSink.gain.value = 0;
        const captureConnected = await setupVoiceCaptureNode(audioContext, source, silentSink);
        micCaptureSinkRef.current = captureConnected ? silentSink : null;
      } else {
        micCaptureWorkletRef.current = null;
        micCaptureSinkRef.current = null;
      }
      micAudioContextRef.current = audioContext;
      micAnalyserRef.current = analyser;
      micSourceRef.current = source;
      micSampleRateRef.current = audioContext.sampleRate || 48000;
      micDataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      micFrequencyDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      detectVoiceActivityRef.current = detectVoiceActivity;
      setMicLevel(0);
      setStatusDetail(detectVoiceActivity ? "Listening for speech." : "Microphone connected. Speak to check your input level.");
      monitorMicrophoneLevel();
      return true;
    } catch (error) {
      const message = formatMicrophoneError(error);
      setSessionState("unavailable");
      setStatusDetail(message);
      setAudioDiagnostic(message);
      stopMicrophoneMeter();
      return false;
    }
  }

  function monitorMicrophoneLevel() {
    const analyser = micAnalyserRef.current;
    const data = micDataRef.current;
    if (!analyser || !data) return;
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let index = 0; index < data.length; index += 1) {
      const centered = (data[index] - 128) / 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    setMicLevel(clampLevel(rms * 4.8));
    if (detectVoiceActivityRef.current && shouldTriggerSpeechRecognition(analyser, rms)) {
      detectVoiceActivityRef.current = false;
      void startListening({ fromVoiceActivity: true });
      return;
    }
    micRafRef.current = window.requestAnimationFrame(monitorMicrophoneLevel);
  }

  function stopMicrophoneMeter() {
    detectVoiceActivityRef.current = false;
    clearRemoteSpeechCaptureTimeout();
    if (micRafRef.current !== null) {
      window.cancelAnimationFrame(micRafRef.current);
      micRafRef.current = null;
    }
    micFilterNodesRef.current.forEach((node) => node.disconnect());
    micFilterNodesRef.current = [];
    if (micCaptureWorkletRef.current) {
      micCaptureWorkletRef.current.port.onmessage = null;
      micCaptureWorkletRef.current.disconnect();
      micCaptureWorkletRef.current = null;
    }
    micCaptureSinkRef.current?.disconnect();
    micCaptureSinkRef.current = null;
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    if (micAudioContextRef.current) {
      void micAudioContextRef.current.close().catch(() => undefined);
      micAudioContextRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    micAnalyserRef.current = null;
    micDataRef.current = null;
    micFrequencyDataRef.current = null;
    micCaptureEnabledRef.current = false;
    setMicLevel(0);
  }

  function beginVoiceCapture() {
    micCaptureChunksRef.current = [];
    micCaptureEnabledRef.current = true;
    lastCapturedVoiceBlobRef.current = null;
  }

  function finalizeVoiceCapture(keepResult: boolean) {
    const wasCapturing = micCaptureEnabledRef.current;
    micCaptureEnabledRef.current = false;
    if (!wasCapturing) {
      if (!keepResult) {
        lastCapturedVoiceBlobRef.current = null;
      }
      return;
    }
    if (!keepResult) {
      micCaptureChunksRef.current = [];
      lastCapturedVoiceBlobRef.current = null;
      return;
    }
    const sampleRate = micSampleRateRef.current || 48_000;
    lastCapturedVoiceBlobRef.current = createWavBlobFromFloat32Chunks(micCaptureChunksRef.current, sampleRate);
    micCaptureChunksRef.current = [];
  }

  function startRemoteSpeechCaptureSession() {
    clearRemoteSpeechCaptureTimeout();
    finalTranscriptRef.current = "";
    setInterimTranscript("Listening...");
    beginVoiceCapture();
    setSessionState("listening");
    setStatusDetail("Capturing speech for transcription.");
    remoteSpeechCaptureTimeoutRef.current = window.setTimeout(() => {
      void finishRemoteSpeechCaptureSession(false);
    }, REMOTE_STT_CAPTURE_DURATION_MS);
  }

  function clearRemoteSpeechCaptureTimeout() {
    if (remoteSpeechCaptureTimeoutRef.current === null) return;
    window.clearTimeout(remoteSpeechCaptureTimeoutRef.current);
    remoteSpeechCaptureTimeoutRef.current = null;
  }

  async function finishRemoteSpeechCaptureSession(cancelled: boolean) {
    clearRemoteSpeechCaptureTimeout();
    finalizeVoiceCapture(!cancelled);
    stopMicrophoneMeter();
    if (cancelled) {
      setInterimTranscript("");
      setSessionState("ready");
      setStatusDetail("Voice detection paused.");
      return;
    }
    await handleSpeechRecognitionEnd("");
  }

  function shouldTriggerSpeechRecognition(analyser: AnalyserNode, rms: number): boolean {
    const frequencyData = micFrequencyDataRef.current;
    if (frequencyData) {
      analyser.getByteFrequencyData(frequencyData);
    }
    const voiceBandRatio = frequencyData ? getVoiceBandRatio(frequencyData, micSampleRateRef.current) : 1;
    const noiseFloor = vadNoiseFloorRef.current;
    const speechThreshold = Math.max(VAD_MIN_RMS, noiseFloor * VAD_NOISE_MULTIPLIER);
    const speechLike = rms >= speechThreshold && (voiceBandRatio >= VAD_VOICE_BAND_RATIO || rms >= speechThreshold * 1.8);

    if (speechLike) {
      vadSpeechFramesRef.current += 1;
    } else {
      vadSpeechFramesRef.current = 0;
      vadNoiseFloorRef.current = noiseFloor * 0.96 + Math.max(0.006, rms) * 0.04;
    }

    const now = Date.now();
    if (vadSpeechFramesRef.current < VAD_TRIGGER_FRAMES || now - vadLastTriggerAtRef.current < VAD_RETRIGGER_COOLDOWN_MS) {
      return false;
    }

    vadLastTriggerAtRef.current = now;
    return true;
  }

  async function speakAssistantMessage(message: AgentMessage) {
    if (!message.content.trim()) return;
    stopPlayback();
    setSessionState("speaking");
    setStatusDetail("");
    setAudioDiagnostic("");
    const requestId = ++audioProgressRequestIdRef.current;
    const fallbackText = buildVoiceFallbackText(message.content);
    const pendingVoiceTranscript = pendingVoiceTranscriptRef.current;
    setModelProgress({
      phase: "queued",
      progress: 0,
      status: "Preparing audio reply.",
    });
    let voiceInferenceRequest = buildVoiceInferenceFallbackRequest({
      messages,
      assistantMessage: message,
      evidenceBundles,
      pendingVoiceTranscript,
      audioBlob: lastCapturedVoiceBlobRef.current || undefined,
    });
    const precomputedAudioReply = await findPrecomputedAudioReply({
      candidateTexts: [message.content, fallbackText, voiceInferenceRequest.fallbackText],
      routeHints: resolvePrecomputedAudioRouteHints(message),
      slottedResponse: resolvePrecomputedAudioSlottedHints(message),
    });
    pendingVoiceTranscriptRef.current = "";
    try {
      if (precomputedAudioReply) {
        lastCapturedVoiceBlobRef.current = null;
        setModelProgress(null);
        onAudioReply?.(message.id, {
          precomputedId: precomputedAudioReply.id,
          audioUrl: precomputedAudioReply.audioUrl,
          spokenText: precomputedAudioReply.text || fallbackText,
          provider: "precomputed",
          playedAt: new Date().toISOString(),
        });
        await playAudioUrlSource(precomputedAudioReply.audioUrl, precomputedAudioReply.text || fallbackText, requestId, {
          revokeObjectUrl: false,
          statusDetail: "Playing prerendered voice reply.",
        });
        return;
      }

      let preferredSpeechText = voiceInferenceRequest.fallbackText || fallbackText || message.content;
      if (message.status !== "failed" && !clientAudioReplyService.shouldPreferRemoteAudioBeforeLocalText()) {
        const generatedReply = await clientLLMWorkerService.tryGenerateText(
          {
            prompt: voiceInferenceRequest.prompt,
            systemPrompt: voiceInferenceRequest.systemPrompt,
            userPrompt: voiceInferenceRequest.userPrompt,
          },
          VOICE_RESPONSE_MAX_TOKENS,
        );
        if (generatedReply.ok) {
          preferredSpeechText = resolveVoiceGeneratedReplyText(generatedReply.text, preferredSpeechText);
          voiceInferenceRequest = buildVoiceInferenceFallbackRequest({
            messages,
            assistantMessage: message,
            evidenceBundles,
            pendingVoiceTranscript,
            audioBlob: lastCapturedVoiceBlobRef.current || undefined,
            assistantText: preferredSpeechText,
            fallbackText: preferredSpeechText,
          });
        }
      }

      console.info("[Abby] Requesting IndexTTS audio for completed assistant response.", {
        endpoint: "voiceProxy.tts",
        assistantMessageId: message.id,
      });
      const ttsResult = await clientAudioReplyService.generateRemoteTextAudio(preferredSpeechText, {
        onProgress: (progress) => updateModelProgress(requestId, progress),
      });
      lastCapturedVoiceBlobRef.current = null;
      if (ttsResult.kind === "audio") {
        onAudioReply?.(message.id, {
          spokenText: preferredSpeechText,
          provider: ttsResult.provider,
          mimeType: ttsResult.mimeType,
          modelName: ttsResult.modelName,
          playedAt: new Date().toISOString(),
        });
      }
      await playAudioReplyResult(ttsResult, preferredSpeechText, requestId);
    } catch (error) {
      const audioErrorMessage = error instanceof Error ? error.message : "Audio reply failed.";
      console.warn("[Abby] IndexTTS proxy failed for completed assistant response; trying voice fallback.", error);
      try {
        const result = await clientAudioReplyService.generateVoiceReply(voiceInferenceRequest, {
          onProgress: (progress) => updateModelProgress(requestId, progress),
        });
        lastCapturedVoiceBlobRef.current = null;
        if (result.kind === "audio") {
          onAudioReply?.(message.id, {
            spokenText: voiceInferenceRequest.fallbackText || fallbackText,
            provider: result.provider,
            mimeType: result.mimeType,
            modelName: result.modelName,
            playedAt: new Date().toISOString(),
          });
        }
        await playAudioReplyResult(result, voiceInferenceRequest.fallbackText || fallbackText, requestId);
        return;
      } catch (voiceInferenceError) {
        const message = voiceInferenceError instanceof Error ? voiceInferenceError.message : audioErrorMessage;
        if (audioProgressRequestIdRef.current === requestId) setModelProgress(null);
        audioRef.current = null;
        revokeAudioUrl();
        setStatusDetail(message);
        setAudioDiagnostic(message);
        setSessionState("ready");
        restartVoiceActivityDetectionSoon();
      }
    }
  }

  async function playAudioReplyResult(result: ClientAudioReplyResult, fallbackText: string, requestId: number) {
    if (audioProgressRequestIdRef.current !== requestId) return;
    setModelProgress(null);
    if (!openRef.current || mutedRef.current) return;
    if (result.kind === "audio") {
      const audioUrl = URL.createObjectURL(result.audioBlob);
      await playAudioUrlSource(audioUrl, fallbackText, requestId, {
        revokeObjectUrl: true,
        statusDetail: "Playing audio reply.",
        webAudioBlob: result.audioBlob,
      });
      return;
    }
    setStatusDetail("Using browser speech output.");
    setAudioDiagnostic(result.fallbackReason);
    playBrowserSpeech(result.text, restartVoiceActivityDetectionSoon);
  }

  async function playAudioUrlSource(
    audioUrl: string,
    fallbackText: string,
    requestId: number,
    options: {
      revokeObjectUrl: boolean;
      statusDetail: string;
      webAudioBlob?: Blob;
    },
  ) {
    if (audioProgressRequestIdRef.current !== requestId || !openRef.current || mutedRef.current) {
      if (options.revokeObjectUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      return;
    }
    revokeAudioUrl();
    audioUrlRef.current = audioUrl;
    audioUrlIsObjectRef.current = options.revokeObjectUrl;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    let usedPlaybackFallback = false;
    const fallbackToBrowserSpeech = async () => {
      if (usedPlaybackFallback) return;
      usedPlaybackFallback = true;
      if (options.webAudioBlob) {
        const playedWithWebAudio = await playAudioBlobWithWebAudio(options.webAudioBlob, () => {
          setSessionState("ready");
          restartVoiceActivityDetectionSoon();
        });
        if (playedWithWebAudio) {
          detachAudioElement(audio);
          revokeAudioUrl();
          audioRef.current = null;
          setStatusDetail(options.statusDetail);
          setAudioDiagnostic("");
          return;
        }
      }
      detachAudioElement(audio);
      revokeAudioUrl();
      audioRef.current = null;
      setStatusDetail("Using browser speech output.");
      setAudioDiagnostic("Generated audio could not be played in this browser.");
      playBrowserSpeech(fallbackText, restartVoiceActivityDetectionSoon);
    };
    audio.onended = () => {
      detachAudioElement(audio);
      revokeAudioUrl();
      audioRef.current = null;
      setSessionState("ready");
      restartVoiceActivityDetectionSoon();
    };
    audio.onerror = () => {
      void fallbackToBrowserSpeech();
    };
    setStatusDetail(options.statusDetail);
    setAudioDiagnostic("");
    await audio.play().catch((error) => {
      if (isInterruptedPlaybackError(error)) return undefined;
      return fallbackToBrowserSpeech();
    });
  }

  function updateModelProgress(requestId: number, progress: ClientAudioProgress) {
    if (audioProgressRequestIdRef.current !== requestId || !openRef.current) return;
    setModelProgress(progress);
    setStatusDetail(progress.status);
  }

  async function playAudioBlobWithWebAudio(audioBlob: Blob, onComplete?: () => void): Promise<boolean> {
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      return false;
    }
    const audioContext = new AudioContextConstructor();
    try {
      if (audioContext.state === "suspended" && audioContext.resume) {
        await audioContext.resume();
      }
      if (!audioContext.decodeAudioData) {
        await audioContext.close().catch(() => undefined);
        return false;
      }
      const audioBuffer = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
      const source = (audioContext as unknown as AudioContext).createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.onended = () => {
        source.disconnect();
        playbackSourceRef.current = null;
        playbackAudioContextRef.current = null;
        void audioContext.close().catch(() => undefined);
        onComplete?.();
      };
      playbackAudioContextRef.current = audioContext;
      playbackSourceRef.current = source;
      source.start();
      return true;
    } catch {
      playbackSourceRef.current = null;
      playbackAudioContextRef.current = null;
      await audioContext.close().catch(() => undefined);
      return false;
    }
  }

  function playBrowserSpeech(text: string, onComplete?: () => void) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setStatusDetail("Audio playback is not available in this browser.");
      sessionStateRef.current = "ready";
      setSessionState("ready");
      onComplete?.();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.96;
    utterance.pitch = 1;
    utterance.onend = () => {
      sessionStateRef.current = "ready";
      setSessionState("ready");
      onComplete?.();
    };
    utterance.onerror = () => {
      setStatusDetail("Browser speech playback failed.");
      sessionStateRef.current = "ready";
      setSessionState("ready");
      onComplete?.();
    };
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  async function playOpeningClip(onComplete?: () => void) {
    const openingClipUrl = tryResolveAudioOpeningClipUrl();
    const primedAudio = await consumePrimedOpeningClip();
    if (!primedAudio && !openingClipUrl) {
      playBrowserSpeech(AUDIO_OPENING_GREETING, onComplete);
      return;
    }
    const audio = primedAudio || new Audio(openingClipUrl ?? undefined);
    audio.preload = "auto";
    audio.setAttribute("playsinline", "true");
    audioRef.current = audio;
    if (audio.ended) {
      clearPrimedOpeningClip(audio);
      detachAudioElement(audio);
      audioRef.current = null;
      sessionStateRef.current = "ready";
      setSessionState("ready");
      onComplete?.();
      return;
    }
    audio.onended = () => {
      clearPrimedOpeningClip(audio);
      detachAudioElement(audio);
      audioRef.current = null;
      sessionStateRef.current = "ready";
      setSessionState("ready");
      onComplete?.();
    };
    audio.onerror = () => {
      clearPrimedOpeningClip(audio);
      detachAudioElement(audio);
      audioRef.current = null;
      sessionStateRef.current = "ready";
      setSessionState("ready");
      onComplete?.();
    };
    if (!primedAudio || audio.paused) {
      await audio.play().catch((error) => {
        if (isInterruptedPlaybackError(error)) return;
        clearPrimedOpeningClip(audio);
        detachAudioElement(audio);
        audioRef.current = null;
        sessionStateRef.current = "ready";
        setSessionState("ready");
        onComplete?.();
      });
    }
  }

  function stopPlayback() {
    if (audioRef.current) {
      clearPrimedOpeningClip(audioRef.current);
      detachAudioElement(audioRef.current);
      audioRef.current = null;
    }
    playbackSourceRef.current?.stop();
    playbackSourceRef.current?.disconnect();
    playbackSourceRef.current = null;
    if (playbackAudioContextRef.current) {
      void playbackAudioContextRef.current.close().catch(() => undefined);
      playbackAudioContextRef.current = null;
    }
    if (utteranceRef.current && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      utteranceRef.current = null;
    }
    revokeAudioUrl();
    if (sessionStateRef.current === "speaking") {
      setSessionState("ready");
    }
  }

  function revokeAudioUrl() {
    if (audioUrlRef.current) {
      if (audioUrlIsObjectRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      audioUrlRef.current = null;
      audioUrlIsObjectRef.current = false;
    }
  }

  function detachAudioElement(audio: HTMLAudioElement) {
    try {
      audio.pause();
    } catch {
      // Ignore browsers that object when audio is already being torn down.
    }
    audio.onended = null;
    audio.onerror = null;
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      // Loading an empty source is best-effort cleanup.
    }
  }

  function toggleMuted() {
    const nextMuted = !muted;
    setMuted(nextMuted);
    if (nextMuted) stopPlayback();
  }

  function resumeVoiceDetection() {
    warmupSpeechRecognition();
    setVoiceDetectionEnabled(true);
    voiceDetectionEnabledRef.current = true;
    void startVoiceActivityDetection();
  }

  function restartVoiceActivityDetectionSoon() {
    if (!openRef.current || !voiceDetectionEnabledRef.current) return;
    window.setTimeout(() => {
      if (openRef.current && voiceDetectionEnabledRef.current && !recognitionRef.current) {
        warmupSpeechRecognition();
        void startVoiceActivityDetection();
      }
    }, 220);
  }

  function resetVoiceActivityDetector() {
    vadNoiseFloorRef.current = 0.018;
    vadSpeechFramesRef.current = 0;
  }

  const visibleMessages = messages.slice(-8).filter((message) => message.role === "assistant" || message.role === "user");
  const isListening = sessionState === "listening";
  const isMonitoring = sessionState === "monitoring";
  const isBusy = responding || sessionState === "thinking";
  const statusLabel = getAudioSessionStatusLabel(sessionState, responding);
  const progressValue = modelProgress ? clampProgress(modelProgress.progress) : 0;
  const micLevelPercent = Math.round(micLevel * 100);
  const waveHeights = getWaveHeights(isListening || isMonitoring ? micLevel : 0);

  return (
    <div className="agent-audio-chat-content">
      <div className="agent-current-task agent-audio-session-status" role="status">
        <small>Voice chat</small>
        <span>{statusDetail || statusLabel}</span>
      </div>

      {modelProgress ? (
        <div
          aria-label="Audio model progress"
          aria-live="polite"
          className="agent-audio-model-progress"
          role="status"
        >
          <div className="agent-audio-model-progress-header">
            <strong>{formatProgressPhase(modelProgress.phase)}</strong>
            <span>{progressValue}%</span>
          </div>
          <progress max={100} value={progressValue}>
            {progressValue}%
          </progress>
          <small>{formatProgressDetail(modelProgress)}</small>
        </div>
      ) : null}

      {audioDiagnostic ? (
        <div aria-label="Audio diagnostic" className="agent-audio-diagnostic" role="alert">
          {audioDiagnostic}
        </div>
      ) : null}

      <div className={`agent-audio-stage agent-audio-stage-${sessionState}`}>
        <button
          aria-label={isListening ? "Stop listening" : isMonitoring ? "Pause voice detection" : "Start voice chat"}
          className="agent-audio-orb"
          disabled={isBusy}
          onClick={isListening || isMonitoring ? stopListening : resumeVoiceDetection}
          type="button"
        >
          {isBusy ? (
            <Loader2 aria-hidden="true" className="agent-audio-spinner" size={38} />
          ) : isListening || isMonitoring ? (
            <MicOff aria-hidden="true" size={38} />
          ) : (
            <Mic aria-hidden="true" size={38} />
          )}
        </button>
        <div className="agent-audio-wave" aria-hidden="true">
          {waveHeights.map((height, index) => (
            <span key={index} style={{ height }} />
          ))}
        </div>
        <div
          aria-label="Microphone input level"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={micLevelPercent}
          className="agent-audio-input-meter"
          role="meter"
        >
          <span style={{ transform: `scaleX(${Math.max(0.04, micLevel)})` }} />
        </div>
        <div className="agent-audio-route">
          <strong>Abby voice</strong>
          <small>{activeRouteLabel}</small>
        </div>
      </div>

      {interimTranscript ? (
        <div className="agent-audio-live-transcript" aria-live="polite">
          {interimTranscript}
        </div>
      ) : null}

      <div className="agent-audio-controls">
        <Button ariaLabel={muted ? "Unmute voice replies" : "Mute voice replies"} onClick={toggleMuted} variant="secondary">
          {muted ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}
          <span>{muted ? "Muted" : "Audio"}</span>
        </Button>
        <Button ariaLabel="Close voice chat" onClick={onClose} variant="secondary">
          <PhoneOff aria-hidden="true" size={18} />
          <span>End</span>
        </Button>
      </div>

      <div className="agent-audio-transcript" aria-label="Voice conversation transcript">
        {visibleMessages.map((message) => (
          <article className={`agent-audio-transcript-row agent-audio-transcript-${message.role}`} key={message.id}>
            <div className="agent-audio-transcript-meta">{message.role === "user" ? "You" : "Abby"}</div>
            <div className="agent-audio-transcript-bubble">
              <p>{formatAudioTranscriptMessage(message)}</p>
              {message.role === "assistant" ? (
                <div className="agent-audio-transcript-evidence">
                  {getAudioTranscriptEvidenceItems(message, evidenceBundles).map((item, index) => (
                    <div className="agent-audio-transcript-evidence-item" key={`${message.id}:${item.id}:${index}`}>
                      <AgentCitationLink
                        citation={normalizeAudioEvidenceCitation(item.citation, index)}
                        compact
                        score={item.score}
                        source={item.source}
                        summary={item.snippet}
                        title={item.title}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const browserWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
}

function getAudioContextConstructor(): BrowserAudioContextConstructor | undefined {
  const browserWindow = window as typeof window & {
    AudioContext?: BrowserAudioContextConstructor;
    webkitAudioContext?: BrowserAudioContextConstructor;
  };
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
}

function isAudioSurfaceActive(surface: AgentAudioSurface): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  const desktop = window.matchMedia(AUDIO_SURFACE_DESKTOP_QUERY).matches;
  return desktop ? surface === "drawer" : surface === "sheet";
}

function getLastAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant" && message.status === "complete");
}

function getLastUserMessageBefore(messages: AgentMessage[], assistantMessage: AgentMessage): AgentMessage | undefined {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessage.id);
  const candidates = assistantIndex >= 0 ? messages.slice(0, assistantIndex) : messages;
  return [...candidates].reverse().find((message) => message.role === "user" && message.status === "complete");
}

export function resolveVoiceReplyUserText(
  messages: AgentMessage[],
  assistantMessage: AgentMessage,
  pendingVoiceTranscript?: string,
): string {
  const transcriptText = pendingVoiceTranscript?.trim();
  if (transcriptText) {
    return transcriptText;
  }
  return getLastUserMessageBefore(messages, assistantMessage)?.content.trim() ?? "";
}

export function buildVoiceInferenceFallbackRequest(input: {
  messages: AgentMessage[];
  assistantMessage: AgentMessage;
  evidenceBundles?: EvidenceBundle[];
  pendingVoiceTranscript?: string;
  audioBlob?: Blob;
  assistantText?: string;
  fallbackText?: string;
}): ClientVoiceReplyRequest {
  const userText = resolveVoiceReplyUserText(input.messages, input.assistantMessage, input.pendingVoiceTranscript);
  const assistantText = input.assistantText?.trim() || input.assistantMessage.content;
  const promptParts = buildVoiceGraphRagPromptParts({
    userText,
    assistantText,
    evidenceBundles: selectEvidenceBundlesForMessage(input.assistantMessage, input.evidenceBundles || []),
  });
  return {
    prompt: promptParts.fullPrompt,
    systemPrompt: promptParts.systemPrompt,
    userPrompt: promptParts.userPrompt,
    fallbackText: input.fallbackText?.trim() || buildVoiceFallbackText(assistantText),
    audioBlob: input.audioBlob,
  };
}

export function resolveVoiceGeneratedReplyText(generatedText: string, fallbackText: string): string {
  return (
    buildVoiceFallbackText(generatedText)
      .replace(/^Abby\s*:\s*/i, "")
      .replace(/^Assistant\s*:\s*/i, "")
      .trim() || fallbackText.trim()
  );
}

function resolvePrecomputedAudioRouteHints(message: AgentMessage): string[] {
  const slottedResponse = readPrecomputedAudioSlottedResponseMetadata(message);
  const route = typeof slottedResponse?.route === "string" ? slottedResponse.route.trim() : "";
  return route ? [route] : [];
}

function resolvePrecomputedAudioSlottedHints(message: AgentMessage): {
  intentId?: string;
  canonicalQueryTemplate?: string;
  responseFrameId?: string;
  responseSignature?: string;
  edgeId?: string;
} | undefined {
  const slottedResponse = readPrecomputedAudioSlottedResponseMetadata(message);
  if (!slottedResponse) {
    return undefined;
  }
  const hints = {
    intentId: typeof slottedResponse.intentId === "string" ? slottedResponse.intentId.trim() : undefined,
    canonicalQueryTemplate:
      typeof slottedResponse.canonicalQueryTemplate === "string"
        ? slottedResponse.canonicalQueryTemplate.trim()
        : undefined,
    responseFrameId:
      typeof slottedResponse.responseFrameId === "string" ? slottedResponse.responseFrameId.trim() : undefined,
    responseSignature:
      typeof slottedResponse.responseSignature === "string" ? slottedResponse.responseSignature.trim() : undefined,
    edgeId: typeof slottedResponse.edgeId === "string" ? slottedResponse.edgeId.trim() : undefined,
  };
  return Object.values(hints).some(Boolean) ? hints : undefined;
}

function readPrecomputedAudioSlottedResponseMetadata(message: AgentMessage): Record<string, unknown> | undefined {
  return asRecord(message.metadata?.slottedResponse);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function primeOpeningClipPlayback(): Promise<HTMLAudioElement | null> {
  if (primedOpeningClipAudio) {
    return primedOpeningClipAudio;
  }
  if (primedOpeningClipPromise) {
    return primedOpeningClipPromise;
  }
  if (typeof Audio === "undefined") {
    return null;
  }
  const openingClipUrl = tryResolveAudioOpeningClipUrl();
  if (!openingClipUrl) {
    return null;
  }
  const audio = new Audio(openingClipUrl);
  audio.preload = "auto";
  audio.setAttribute("playsinline", "true");
  primedOpeningClipPromise = audio
    .play()
    .then(() => {
      primedOpeningClipAudio = audio;
      return audio;
    })
    .catch(() => {
      clearPrimedOpeningClip(audio);
      try {
        audio.pause();
      } catch {
        // Best-effort cleanup for interrupted autoplay priming.
      }
      audio.removeAttribute("src");
      try {
        audio.load();
      } catch {
        // Best-effort cleanup for interrupted autoplay priming.
      }
      return null;
    })
    .finally(() => {
      primedOpeningClipPromise = null;
    });
  return primedOpeningClipPromise;
}

async function consumePrimedOpeningClip(): Promise<HTMLAudioElement | null> {
  if (primedOpeningClipAudio) {
    return primedOpeningClipAudio;
  }
  if (primedOpeningClipPromise) {
    return primedOpeningClipPromise;
  }
  return null;
}

function clearPrimedOpeningClip(audio?: HTMLAudioElement | null): void {
  if (!audio || primedOpeningClipAudio === audio) {
    primedOpeningClipAudio = null;
  }
}

function isInterruptedPlaybackError(error: unknown): boolean {
  if (!(error instanceof DOMException || error instanceof Error)) return false;
  return (
    error.name === "AbortError" &&
    /play\(\) request was interrupted|interrupted by a call to pause|interrupted by a new load request/i.test(error.message)
  );
}

function warmupSpeechRecognition(): void {
  if (typeof window === "undefined") {
    return;
  }
  const Recognition = getSpeechRecognitionConstructor();
  if (!Recognition) {
    return;
  }
  const now = Date.now();
  if (now - lastSpeechRecognitionWarmupAt < SPEECH_RECOGNITION_WARMUP_COOLDOWN_MS) {
    return;
  }
  lastSpeechRecognitionWarmupAt = now;
  try {
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = () => {
      try {
        recognition.abort();
      } catch {
        // Ignore warmup teardown errors.
      }
    };
    recognition.onerror = () => undefined;
    recognition.onend = () => undefined;
    recognition.start();
    window.setTimeout(() => {
      try {
        recognition.abort();
      } catch {
        // Ignore warmup teardown errors.
      }
    }, SPEECH_RECOGNITION_WARMUP_ABORT_MS);
  } catch {
    lastSpeechRecognitionWarmupAt = 0;
  }
}

async function preflightRemoteSpeechToText(): Promise<boolean> {
  if (Date.now() < remoteSpeechToTextPreflightReadyUntil) {
    return true;
  }
  if (!remoteSpeechToTextPreflightPromise) {
    remoteSpeechToTextPreflightPromise = preflightRemoteSpeechToTextProxy()
      .then(() => {
        clientAudioReplyService.markRemoteSpeechToTextPreflight(true);
        remoteSpeechToTextPreflightReadyUntil = Date.now() + REMOTE_STT_PREFLIGHT_CACHE_MS;
        return true;
      })
      .catch((error) => {
        console.warn("[Abby] Speech-to-text proxy preflight failed; local/browser fallback remains available.", error);
        clientAudioReplyService.markRemoteSpeechToTextPreflight(false, error);
        remoteSpeechToTextPreflightReadyUntil = 0;
        return false;
      })
      .finally(() => {
        remoteSpeechToTextPreflightPromise = null;
      });
  }
  return remoteSpeechToTextPreflightPromise;
}

function formatAudioTranscriptMessage(message: AgentMessage): string {
  return message.role === "assistant" ? buildVoiceFallbackText(message.content) : message.content;
}

function getAudioTranscriptEvidenceItems(
  message: AgentMessage,
  evidenceBundles: EvidenceBundle[],
  limit = 4,
): EvidenceBundle["items"] {
  const items = selectEvidenceBundlesForMessage(message, evidenceBundles).flatMap((bundle) => bundle.items);
  const selected: EvidenceBundle["items"] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const identity = `${item.citation.docId || item.citation.url || item.id}`.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function normalizeAudioEvidenceCitation(citation: EvidenceBundle["items"][number]["citation"], index: number) {
  if (citation.label.trim()) return citation;
  return {
    ...citation,
    label: `[${index + 1}]`,
  };
}

function getAudioSessionStatusLabel(sessionState: AudioSessionState, responding?: boolean): string {
  if (responding || sessionState === "thinking") return "Abby is working through your request.";
  if (sessionState === "monitoring") return "Listening for speech.";
  if (sessionState === "listening") return "Listening.";
  if (sessionState === "speaking") return "Speaking.";
  if (sessionState === "unavailable") return "Speech recognition unavailable.";
  return "Ready.";
}

function formatSpeechRecognitionError(error?: string): string {
  if (error === "not-allowed") return "Microphone permission was blocked.";
  if (error === "no-speech") return "No speech was detected.";
  if (error === "audio-capture") return "Microphone input is unavailable.";
  return "Voice input stopped.";
}

function formatMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Microphone permission was blocked.";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "No microphone input was found.";
    if (error.name === "NotReadableError") return "Microphone input is already in use.";
  }
  return error instanceof Error ? error.message : "Microphone input could not start.";
}

function formatProgressPhase(phase: ClientAudioProgress["phase"]): string {
  if (phase === "loading-runtime") return "Loading runtime";
  if (phase === "downloading-model") return "Downloading model";
  if (phase === "warming-up") return "Warming up";
  if (phase === "generating") return "Generating audio";
  if (phase === "decoding") return "Decoding audio";
  if (phase === "ready") return "Audio ready";
  if (phase === "fallback") return "Fallback ready";
  return "Preparing audio";
}

function formatProgressDetail(progress: ClientAudioProgress): string {
  return progress.status;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function getVoiceBandRatio(data: Uint8Array, sampleRate: number): number {
  if (!data.length) return 0;
  const hzPerBin = (sampleRate / 2) / data.length;
  let totalEnergy = 0;
  let voiceEnergy = 0;
  for (let index = 1; index < data.length; index += 1) {
    const hz = index * hzPerBin;
    const magnitude = data[index] / 255;
    const energy = magnitude * magnitude;
    totalEnergy += energy;
    if (hz >= 85 && hz <= 3400) {
      voiceEnergy += energy;
    }
  }
  return totalEnergy > 0 ? voiceEnergy / totalEnergy : 0;
}

function getWaveHeights(level: number): number[] {
  const base = 10;
  const gain = clampLevel(level);
  return [0.55, 0.8, 1, 0.74, 0.58].map((weight) => Math.round(base + gain * weight * 30));
}
