const DEFAULT_VOICE_PROXY_SAMPLE_RATE = 16_000;
const DEFAULT_VOICE_PROXY_SILENCE_MS = 240;

export function createVoiceProxyFormData(input: {
  mode?: "tts" | "voice-reply";
  text: string;
  systemPrompt?: string;
  userPrompt?: string;
  fallbackText?: string;
  audioBlob?: Blob;
}): FormData {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Voice proxy text prompt is empty.");
  }

  const audioBlob = input.audioBlob ?? createSilentWavBlob();
  assertWavAudioBlob(audioBlob);
  const systemPrompt = input.systemPrompt?.trim();
  const userPrompt = input.userPrompt?.trim();
  const fallbackText = input.fallbackText?.trim();

  const formData = new FormData();
  formData.append("audio", audioBlob, "input.wav");
  formData.append("text", text);
  if (input.mode) {
    formData.append("mode", input.mode);
  }
  if (systemPrompt) {
    formData.append("systemPrompt", systemPrompt);
    formData.append("system_prompt", systemPrompt);
  }
  if (userPrompt) {
    formData.append("userPrompt", userPrompt);
    formData.append("user_prompt", userPrompt);
  }
  if (fallbackText) {
    formData.append("fallbackText", fallbackText);
    formData.append("fallback_text", fallbackText);
  }
  return formData;
}

export function createVoiceProxyTtsBody(input: {
  text: string;
  voiceDescription?: string;
}): URLSearchParams {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Voice proxy text prompt is empty.");
  }

  const body = new URLSearchParams();
  body.set("text", text);
  const voiceDescription = input.voiceDescription?.trim();
  if (voiceDescription) {
    body.set("voice_description", voiceDescription);
  }
  return body;
}

export function createSilentWavBlob(
  durationMs = DEFAULT_VOICE_PROXY_SILENCE_MS,
  sampleRate = DEFAULT_VOICE_PROXY_SAMPLE_RATE,
): Blob {
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  return createMonoWavBlob(new Float32Array(sampleCount), sampleRate);
}

export function createWavBlobFromFloat32Chunks(chunks: Float32Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!totalSamples) {
    return createSilentWavBlob();
  }
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return createMonoWavBlob(merged, sampleRate);
}

export function assertWavAudioBlob(audioBlob: Blob): void {
  const normalizedType = audioBlob.type.trim().toLowerCase();
  if (normalizedType && normalizedType !== "audio/wav" && normalizedType !== "audio/x-wav") {
    throw new Error(
      `Voice proxy requires WAV input. Received ${audioBlob.type || "unknown"}. Convert audio/webm or audio/ogg to WAV before upload.`,
    );
  }
}

function createMonoWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const rawSample = samples[index];
    const sample = Number.isFinite(rawSample) ? Math.max(-1, Math.min(1, rawSample)) : 0;
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}