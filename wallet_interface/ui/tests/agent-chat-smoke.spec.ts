import { expect, test, type Locator, type Page } from "@playwright/test";

test("assistant opens, searches food pantry evidence, navigates, and gates saving", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "Mobile Safari", "Full GraphRAG planner smoke is covered in Desktop Chrome.");
  test.setTimeout(90000);
  await enterSignedInApp(page);
  await installTiny211Corpus(page);

  await openTextAssistant(page);
  const assistant = visibleAssistant(page);
  await expect(assistant).toBeVisible();
  await expect(assistant.getByText(/I will ask before changing wallet data/i)).toBeVisible();

  await sendAssistantMessage(assistant, "open services");
  await expect(page.getByRole("heading", { name: /Find support/i })).toBeVisible({ timeout: 15000 });
  await expect(assistant.getByText(/Opened Services/i).first()).toBeVisible({ timeout: 15000 });

  await sendAssistantMessage(assistant, "find food pantry evidence near Portland");
  await expect(assistant.getByText(/Found \d+ service records/i).first()).toBeVisible({ timeout: 45000 });
  await expect(assistant.getByRole("region", { name: /GraphRAG evidence/i })).toBeVisible();
  await expect(assistant.locator(".agent-evidence-item").first()).toContainText(/Neighborhood Food Pantry|pantry/i);

  const firstDocId = await firstEvidenceDocId(assistant);
  expect(firstDocId).toBe("svc-food-pantry-1");

  await sendAssistantMessage(assistant, `save service ${firstDocId}`);
  const confirmation = assistant.getByRole("region", { name: /Confirmation required: Save service/i });
  await expect(confirmation).toBeVisible({ timeout: 15000 });
  await expect(confirmation).toContainText(firstDocId);
  await expect(confirmation.getByText(/Before/i)).toBeVisible();
  await expect(confirmation.getByText(/After/i)).toBeVisible();
  await expect(assistant.getByText(new RegExp(`^Saved service ${escapeRegex(firstDocId)}\\.$`))).toHaveCount(0);

  await confirmation.getByRole("button", { name: /Confirm Save service/i }).click();
  await expect(assistant.getByText(new RegExp(`^Saved service ${escapeRegex(firstDocId)}\\.$`)).first()).toBeVisible({
    timeout: 45000,
  });
});

test("assistant launchers expose separate text and voice chat surfaces", async ({ page }) => {
  await enterSignedInApp(page);

  const launcher = visibleClosedLauncher(page);
  await expect(launcher.getByRole("button", { name: /Open text chat/i })).toBeVisible();
  await expect(launcher.getByRole("button", { name: /Open voice chat/i })).toBeVisible();

  await launcher.getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  await expect(voiceAssistant).toBeVisible();
  await expect(voiceAssistant.getByRole("button", { name: /Start voice chat/i })).toBeVisible();
  await expect(voiceAssistant.getByText(/Voice chat/i).first()).toBeVisible();

  await voiceAssistant.getByRole("button", { name: /Close voice chat|Close voice assistant|Close assistant/i }).first().click();
  await openTextAssistant(page);
  await expect(visibleAssistant(page).getByLabel(/Message Abby assistant/i)).toBeVisible();
});

test("front page assistant button opens voice chat", async ({ page }) => {
  await page.goto("/");
  await clearPwaState(page);
  await page.goto("/");

  const frontPageAssistantButton = page.getByRole("button", { name: /^Open assistant$/i });
  if (await frontPageAssistantButton.isVisible({ timeout: 10000 }).catch(() => false)) {
    await frontPageAssistantButton.click();
  } else {
    await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  }
  await expect(page.getByRole("heading", { name: /Your safety plan/i })).toBeVisible({ timeout: 10000 });

  const voiceAssistant = visibleVoiceAssistant(page);
  await expect(voiceAssistant).toBeVisible();
  await expect(voiceAssistant.getByRole("button", { name: /Start voice chat/i })).toBeVisible();
});

test("mobile assistant sheet expands to a near full-screen view", async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), "Bottom-sheet expansion is covered in mobile projects.");
  await enterSignedInApp(page);
  await openTextAssistant(page);

  const assistant = visibleAssistant(page);
  await expect(assistant).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  const collapsedRect = await assistant.boundingBox();
  expect(collapsedRect).not.toBeNull();

  await assistant.getByRole("button", { name: /Expand assistant sheet/i }).first().click();
  await expect(assistant.getByRole("button", { name: /Collapse assistant sheet/i }).first()).toBeVisible();

  const expandedRect = await assistant.boundingBox();
  expect(expandedRect).not.toBeNull();
  expect(expandedRect!.height).toBeGreaterThan((collapsedRect?.height || 0) + 120);
  expect(expandedRect!.height / viewport!.height).toBeGreaterThan(0.85);
  expect(expandedRect!.width / viewport!.width).toBeGreaterThan(0.95);
  expect(expandedRect!.y).toBeLessThan(24);
});

test("mobile assistant sheet lets users scroll existing chat history after expansion", async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), "Bottom-sheet scrolling is covered in mobile projects.");
  test.setTimeout(90000);
  await enterSignedInApp(page);
  await installTiny211Corpus(page);
  await openTextAssistant(page);

  const assistant = visibleAssistant(page);
  await assistant.getByRole("button", { name: /Expand assistant sheet/i }).first().click();
  await expect(assistant.getByRole("button", { name: /Collapse assistant sheet/i }).first()).toBeVisible();

  await sendAssistantMessage(assistant, "open services");
  await expect(page.getByRole("heading", { name: /Find support/i })).toBeVisible({ timeout: 15000 });

  await sendAssistantMessage(assistant, "find food pantry evidence near Portland");
  await expect(assistant.getByText(/Found \d+ service records/i).first()).toBeVisible({ timeout: 45000 });

  const firstDocId = await firstEvidenceDocId(assistant);
  await sendAssistantMessage(assistant, `save service ${firstDocId}`);
  const confirmation = assistant.getByRole("region", { name: /Confirmation required: Save service/i });
  await expect(confirmation).toBeVisible({ timeout: 15000 });
  await confirmation.getByRole("button", { name: /Confirm Save service/i }).click();
  await expect(assistant.getByText(new RegExp(`^Saved service ${escapeRegex(firstDocId)}\\.$`)).first()).toBeVisible({
    timeout: 45000,
  });

  const messageList = assistant.locator(".agent-message-list");
  await expect.poll(() => getScrollCapacity(messageList)).toBeGreaterThan(80);

  const scrollMetrics = await messageList.evaluate(async (node) => {
    const element = node as HTMLDivElement;
    const maxScroll = element.scrollHeight - element.clientHeight;
    element.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const topBefore = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    return {
      clientHeight: element.clientHeight,
      maxScroll,
      scrollHeight: element.scrollHeight,
      topAfter: element.scrollTop,
      topBefore,
    };
  });

  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.maxScroll).toBeGreaterThan(80);
  expect(scrollMetrics.topBefore).toBe(0);
  expect(scrollMetrics.topAfter).toBeGreaterThan(80);
});

test("voice chat shows local audio model warmup progress", async ({ page }) => {
  await installFakeAudioWorker(page);
  await enterSignedInApp(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  const progressRegion = voiceAssistant.getByRole("status", { name: /Audio model progress/i });

  await expect(progressRegion).toBeVisible({ timeout: 5000 });
  await expect(progressRegion.getByText(/Downloading model|Loading runtime|Warming up/i)).toBeVisible();
  await expect(progressRegion.locator(".agent-audio-model-progress-header span")).toHaveText("38%");
  await expect(progressRegion.getByText(/decoder_q4\.onnx/i)).toBeVisible();
});

test("voice chat reports local audio model warmup failures", async ({ page }) => {
  await installFakeAudioWorker(page, "warmup-error");
  await enterSignedInApp(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  const diagnostic = voiceAssistant.getByRole("alert", { name: /Audio diagnostic/i });

  await expect(diagnostic).toBeVisible({ timeout: 5000 });
  await expect(diagnostic).toContainText(/Failed to fetch decoder_q4\.onnx: 404/i);
  await expect(voiceAssistant.getByText(/Browser speech output ready/i)).toBeVisible();
});

test("voice chat on iPhone uses browser speech instead of downloading the local audio model", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Mobile Safari", "iPhone local-audio policy is covered by the Mobile Safari project.");
  await installFakeSpeechSynthesis(page);
  await installFakeAudioWorker(page, "success");
  await enterSignedInApp(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  const diagnostic = voiceAssistant.getByRole("alert", { name: /Audio diagnostic/i });

  await expect(voiceAssistant.getByText(/Browser speech output ready/i)).toBeVisible({ timeout: 5000 });
  await expect(diagnostic).toContainText(/disabled on iPhone and iPad/i);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          ((window as typeof window & { __abbyWorkerScripts?: string[] }).__abbyWorkerScripts || []).filter((script) =>
            script.includes("clientAudioWorker"),
          ).length,
      ),
    )
    .toBe(0);
});

test("voice chat speaks an opening greeting when the audio surface opens", async ({ page }) => {
  await installFakeAudioWorker(page, "success");
  await installFakeAudioPlayback(page);
  await enterSignedInApp(page);
  await resetAudioPlaybackLog(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();

  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __abbyAudioPlayCalls?: number }).__abbyAudioPlayCalls || 0),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __abbyAudioSources?: string[] }).__abbyAudioSources?.join(" ") || ""),
    )
    .toContain("assets/audio/intro.wav");
});

test("voice chat plays the intro clip only once per open session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Mobile Chrome", "Intro replay semantics are covered in the mobile Chromium bottom-sheet surface.");
  await installFakeAudioWorker(page, "success");
  await installFakeAudioPlayback(page);
  await installFakeSpeechRecognition(page, "open services", 5000);
  await installFakeMicrophoneMeter(page, "quiet");
  await enterSignedInApp(page);
  await resetAudioPlaybackLog(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  await expect(voiceAssistant).toBeVisible();

  await expect.poll(() => getAudioPlayCallCount(page)).toBe(1);
  await expect.poll(() => getAudioSourceLog(page)).toContain("assets/audio/intro.wav");
  await expect(voiceAssistant.getByRole("button", { name: /Pause voice detection/i })).toBeVisible({ timeout: 10000 });

  await voiceAssistant.getByRole("button", { name: /Pause voice detection/i }).click();
  await expect(voiceAssistant.getByRole("button", { name: /Start voice chat/i })).toBeVisible({ timeout: 5000 });

  await voiceAssistant.getByRole("button", { name: /Start voice chat/i }).click();
  await expect(voiceAssistant.getByRole("button", { name: /Pause voice detection/i })).toBeVisible({ timeout: 10000 });
  await expect.poll(() => getAudioPlayCallCount(page)).toBe(1);

  await voiceAssistant.getByRole("button", { name: /Close voice chat|Close voice assistant|Close assistant/i }).first().click();
  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  await expect.poll(() => getAudioPlayCallCount(page)).toBe(2);
});

test("voice chat validates microphone input level while listening", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "Mobile Safari", "Synthetic Web Audio microphone metering is covered in Chromium.");
  await installFakeSpeechSynthesis(page);
  await installFakeAudioWorker(page, "success");
  await installFakeSpeechRecognition(page, "open services", 900);
  await installFakeMicrophoneMeter(page);
  await enterSignedInApp(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);

  const meter = voiceAssistant.getByRole("meter", { name: /Microphone input level/i });
  await expect(meter).toBeVisible();
  await expect.poll(async () => Number((await meter.getAttribute("aria-valuenow")) || 0)).toBeGreaterThan(20);
});

test("voice chat automatically captures speech, routes the app command, and plays generated audio", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "Mobile Safari", "Synthetic SpeechRecognition and Audio playback are covered in Chromium.");
  await installFakeSpeechSynthesis(page);
  await installFakeAudioWorker(page, "success");
  await installFakeSpeechRecognition(page, "open services");
  await installFakeMicrophoneMeter(page);
  await installFakeAudioPlayback(page);
  await enterSignedInApp(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  await expect(voiceAssistant.getByText(/Audio model ready/i)).toBeVisible({ timeout: 10000 });

  await expect(page.getByRole("heading", { name: /Find support/i })).toBeVisible({ timeout: 15000 });
  await expect(voiceAssistant.getByLabel(/Voice conversation transcript/i)).toContainText(/open services/i, {
    timeout: 15000,
  });
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __abbyAudioPlayCalls?: number }).__abbyAudioPlayCalls || 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = (window as typeof window & {
          __abbyAudioWorkerMessages?: Array<{ type?: string; data?: { text?: string; fallbackText?: string } }>;
        }).__abbyAudioWorkerMessages || [];
        return messages.find((message) => message.type === "generateVoiceReply")?.data?.text || "";
      }),
    )
    .toContain("User voice query: open services");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          ((window as typeof window & { __abbyWorkerScripts?: string[] }).__abbyWorkerScripts || []).filter((script) =>
            script.includes("clientLLMWorker"),
          ).length,
      ),
    )
    .toBe(0);
});

test("voice chat falls back to browser speech when generated audio playback fails", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "Mobile Safari", "Synthetic Audio playback failure is covered in Chromium.");
  await installFakeSpeechSynthesis(page);
  await installFakeAudioWorker(page, "success");
  await installFakeSpeechRecognition(page, "open services");
  await installFakeMicrophoneMeter(page);
  await installFakeAudioPlayback(page, "play-error");
  await enterSignedInApp(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  await expect(voiceAssistant.getByText(/Audio model ready/i)).toBeVisible({ timeout: 10000 });

  await expect(page.getByRole("heading", { name: /Find support/i })).toBeVisible({ timeout: 15000 });
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __abbyAudioPlayCalls?: number }).__abbyAudioPlayCalls || 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __abbySpeechTexts?: string[] }).__abbySpeechTexts?.join(" ") || ""),
    )
    .toMatch(/Opened Services/i);
});

test("voice chat transcript hides source blocks from assistant audio bubbles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "Mobile Safari", "Synthetic SpeechRecognition and audio transcript are covered in Chromium.");
  await installFakeSpeechSynthesis(page);
  await installFakeAudioWorker(page, "success");
  await installFakeSpeechRecognition(page, "find food pantry evidence near Portland");
  await installFakeMicrophoneMeter(page);
  await installFakeAudioPlayback(page);
  await installTiny211Corpus(page);
  await enterSignedInApp(page);

  await visibleClosedLauncher(page).getByRole("button", { name: /Open voice chat/i }).click();
  const voiceAssistant = visibleVoiceAssistant(page);
  await expect(voiceAssistant.getByLabel(/Voice conversation transcript/i)).toContainText(/food pantry evidence/i, {
    timeout: 15000,
  });
  const transcript = voiceAssistant.getByLabel(/Voice conversation transcript/i);
  await expect(transcript).toContainText(/Neighborhood Food Pantry|pantry/i, { timeout: 45000 });
  await expect(transcript).not.toContainText(/Sources?:/i);
  await expect(transcript).not.toContainText(/https?:\/\//i);
});

function visibleAssistant(page: Page): Locator {
  return page.locator('aside[aria-label="Abby text assistant"]:visible, aside[aria-label="Abby assistant"]:visible');
}

function visibleVoiceAssistant(page: Page): Locator {
  return page.locator('aside[aria-label="Abby voice assistant"]:visible, aside[aria-label="Abby assistant"]:visible');
}

function visibleClosedLauncher(page: Page): Locator {
  return page.locator(".agent-chat-launcher:visible, .agent-chat-bottom-launcher:visible").first();
}

async function openTextAssistant(page: Page): Promise<void> {
  await visibleClosedLauncher(page).getByRole("button", { name: /Open text chat/i }).click();
}

async function enterSignedInApp(page: Page): Promise<void> {
  await page.goto("/");
  await clearPwaState(page);
  await page.goto("/");
  if (await page.getByRole("heading", { name: /Sign in to Abby/i }).isVisible()) {
    await page.getByRole("button", { name: /Open assistant/i }).click();
  }
  await expect(page.getByRole("heading", { name: /Your safety plan/i })).toBeVisible({ timeout: 10000 });
  await closeAssistantIfOpen(page);
}

async function closeAssistantIfOpen(page: Page): Promise<void> {
  const closeButton = page
    .getByRole("button", { name: /Close text chat|Close voice chat|Close voice assistant|Close assistant/i })
    .first();
  if (await closeButton.isVisible()) {
    await closeButton.click();
  }
}

async function clearPwaState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registrations = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      await Promise.all((await caches.keys()).map((cacheName) => caches.delete(cacheName)));
    }
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

type FakeAudioWorkerMode = "progress-only" | "success" | "warmup-error";

async function installFakeAudioWorker(page: Page, mode: FakeAudioWorkerMode = "progress-only"): Promise<void> {
  await page.addInitScript((fakeMode: FakeAudioWorkerMode) => {
    Object.defineProperty(window, "__abbyWorkerScripts", {
      configurable: true,
      writable: true,
      value: [],
    });
    Object.defineProperty(window, "__abbyAudioWorkerMessages", {
      configurable: true,
      writable: true,
      value: [],
    });
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {},
    });
    if (!("speechSynthesis" in window)) {
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          cancel: () => undefined,
          speak: () => undefined,
        },
      });
    }
    if (typeof SpeechSynthesisUtterance === "undefined") {
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        configurable: true,
        value: class SpeechSynthesisUtterance {
          text: string;
          onend: (() => void) | null = null;
          onerror: (() => void) | null = null;

          constructor(text: string) {
            this.text = text;
          }
        },
      });
    }

    const RealWorker = window.Worker;
    class FakeAudioWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      private readonly realWorker?: Worker;

      constructor(scriptUrl: string | URL, options?: WorkerOptions) {
        (window as typeof window & { __abbyWorkerScripts?: string[] }).__abbyWorkerScripts?.push(String(scriptUrl));
        if (!String(scriptUrl).includes("clientAudioWorker")) {
          this.realWorker = new RealWorker(scriptUrl, options);
          return this.realWorker;
        }
      }

      postMessage(message: { id: string; type: string; data?: { modelName?: string; text?: string; fallbackText?: string } }) {
        (window as typeof window & {
          __abbyAudioWorkerMessages?: Array<{ id: string; type: string; data?: { modelName?: string; text?: string; fallbackText?: string } }>;
        }).__abbyAudioWorkerMessages?.push(message);
        const modelName = message.data?.modelName || "LiquidAI/LFM2.5-Audio-1.5B-ONNX";
        window.setTimeout(() => {
          this.onmessage?.({
            data: {
              id: message.id,
              type: "progress",
              progress: {
                phase: "loading-runtime",
                progress: 4,
                status: "Loading LiquidAI audio runtime.",
                modelName,
              },
            },
          } as MessageEvent);
        }, 25);
        window.setTimeout(() => {
          this.onmessage?.({
            data: {
              id: message.id,
              type: "progress",
              progress: {
                phase: "downloading-model",
                progress: 38,
                status: "Downloading audio model decoder_q4.onnx.",
                file: "decoder_q4.onnx",
                modelName,
              },
            },
          } as MessageEvent);
        }, 50);
        window.setTimeout(() => {
          if (fakeMode === "warmup-error" && message.type === "warmUp") {
            this.onmessage?.({
              data: {
                id: message.id,
                success: false,
                error: "Failed to fetch decoder_q4.onnx: 404",
              },
            } as MessageEvent);
            return;
          }
          if (fakeMode !== "success") return;
          if (message.type === "warmUp") {
            this.onmessage?.({
              data: {
                id: message.id,
                success: true,
                data: {
                  modelName,
                  provider: "local-liquidai",
                },
              },
            } as MessageEvent);
            return;
          }
          this.onmessage?.({
            data: {
              id: message.id,
              type: "progress",
              progress: {
                phase: "generating",
                progress: 92,
                status: "Generating speech audio (4 frames).",
                modelName,
              },
            },
          } as MessageEvent);
          window.setTimeout(() => {
            this.onmessage?.({
              data: {
                id: message.id,
                success: true,
                data: {
                  audioBlob: new Blob(["RIFF....WAVE"], { type: "audio/wav" }),
                  mimeType: "audio/wav",
                  modelName,
                  provider: "local-liquidai",
                },
              },
            } as MessageEvent);
          }, 25);
        }, 75);
      }

      terminate() {
        this.realWorker?.terminate();
      }
    }

    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: FakeAudioWorker,
    });
  }, mode);
}

async function installFakeSpeechSynthesis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__abbySpeechSpeakCalls", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(window, "__abbySpeechTexts", {
      configurable: true,
      writable: true,
      value: [],
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        cancel: () => undefined,
        speak: (utterance: SpeechSynthesisUtterance) => {
          const testWindow = window as typeof window & {
            __abbySpeechSpeakCalls?: number;
            __abbySpeechTexts?: string[];
          };
          testWindow.__abbySpeechSpeakCalls = (testWindow.__abbySpeechSpeakCalls || 0) + 1;
          testWindow.__abbySpeechTexts = [...(testWindow.__abbySpeechTexts || []), utterance.text];
          window.setTimeout(() => utterance.onend?.({} as SpeechSynthesisEvent), 10);
        },
      },
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class SpeechSynthesisUtterance {
        onend: ((event: SpeechSynthesisEvent) => void) | null = null;
        onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
        pitch = 1;
        rate = 1;
        text: string;

        constructor(text: string) {
          this.text = text;
        }
      },
    });
  });
}

async function installFakeSpeechRecognition(page: Page, transcript: string, delayMs = 40): Promise<void> {
  await page.addInitScript(({ spokenText, resultDelayMs }: { spokenText: string; resultDelayMs: number }) => {
    class FakeSpeechRecognition extends EventTarget {
      continuous = false;
      interimResults = false;
      lang = "en-US";
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }> }) => void) | null =
        null;

      start() {
        window.setTimeout(() => {
          this.onresult?.({
            resultIndex: 0,
            results: [
              {
                isFinal: true,
                0: {
                  transcript: spokenText,
                },
              },
            ],
          });
          this.onend?.();
        }, resultDelayMs);
      }

      stop() {
        this.onend?.();
      }

      abort() {
        this.onend = null;
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
  }, { spokenText: transcript, resultDelayMs: delayMs });
}

type FakeMicrophoneMeterMode = "voice-activity" | "quiet";

async function installFakeMicrophoneMeter(page: Page, mode: FakeMicrophoneMeterMode = "voice-activity"): Promise<void> {
  await page.addInitScript((meterMode: FakeMicrophoneMeterMode) => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => undefined,
            },
          ],
        }),
      },
    });

    class FakeAnalyser {
      fftSize = 256;
      smoothingTimeConstant = 0.72;

      get frequencyBinCount() {
        return this.fftSize / 2;
      }

      getByteTimeDomainData(data: Uint8Array) {
        for (let index = 0; index < data.length; index += 1) {
          data[index] = meterMode === "quiet" ? (index % 2 === 0 ? 126 : 130) : index % 2 === 0 ? 72 : 184;
        }
      }

      getByteFrequencyData(data: Uint8Array) {
        if (meterMode === "quiet") {
          data.fill(4);
          return;
        }
        for (let index = 0; index < data.length; index += 1) {
          data[index] = index > 0 && index < 37 ? 220 : 6;
        }
      }
    }

    class FakeAudioContext {
      sampleRate = 48000;
      state: AudioContextState = "running";

      async close() {
        return undefined;
      }

      createAnalyser() {
        return new FakeAnalyser();
      }

      createMediaStreamSource() {
        return {
          connect: () => undefined,
          disconnect: () => undefined,
        } as unknown as MediaStreamAudioSourceNode;
      }

      async resume() {
        return undefined;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
    Object.defineProperty(window, "webkitAudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
  }, mode);
}

type FakeAudioPlaybackMode = "success" | "play-error";

async function installFakeAudioPlayback(page: Page, mode: FakeAudioPlaybackMode = "success"): Promise<void> {
  await page.addInitScript((playbackMode: FakeAudioPlaybackMode) => {
    Object.defineProperty(window, "__abbyAudioPlayCalls", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(window, "__abbyAudioSources", {
      configurable: true,
      writable: true,
      value: [],
    });

    class FakeAudio {
      ended = false;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      paused = true;
      preload = "";
      src = "";

      constructor(src?: string) {
        this.src = src || "";
      }

      async play() {
        const testWindow = window as typeof window & { __abbyAudioPlayCalls?: number; __abbyAudioSources?: string[] };
        testWindow.__abbyAudioPlayCalls = (testWindow.__abbyAudioPlayCalls || 0) + 1;
        testWindow.__abbyAudioSources = [...(testWindow.__abbyAudioSources || []), this.src];
        this.paused = false;
        this.ended = false;
        if (playbackMode === "play-error") {
          this.onerror?.();
          throw new Error("Synthetic audio playback failure.");
        }
        window.setTimeout(() => {
          this.ended = true;
          this.onended?.();
        }, 10);
      }

      pause() {
        this.paused = true;
        return undefined;
      }

      load() {
        return undefined;
      }

      removeAttribute(name: string) {
        if (name === "src") {
          this.src = "";
          this.ended = false;
          this.paused = true;
        }
      }

      setAttribute(_name: string, _value: string) {
        return undefined;
      }
    }

    Object.defineProperty(window, "Audio", {
      configurable: true,
      value: FakeAudio,
    });
  }, mode);
}

async function installTiny211Corpus(page: Page): Promise<void> {
  await page.route("**/corpus/211-info/current/artifacts.manifest.json", async (route) => {
    await route.fulfill({
      json: {
        schemaVersion: 1,
        datasetId: "test/211-info",
        datasetPath: "test/211-info/current",
        corpus: {
          name: "Test 211 corpus",
          source: "playwright",
          documentCount: 2,
          embeddingModel: "test",
          embeddingDimension: 2,
        },
        sourcePackage: {
          path: "playwright",
          build_manifest_cid: "test",
          document_count: 2,
          graph_node_count: 0,
          graph_edge_count: 0,
        },
        artifacts: [],
      },
    });
  });
  const documents = [
    {
      doc_id: "svc-food-pantry-1",
      doc_type: "service",
      title: "Neighborhood Food Pantry",
      text: "Neighborhood Food Pantry provides food boxes, pantry appointments, and grocery pickup help in Portland.",
      text_truncated: false,
      source_url: "https://211.example.test/food-pantry",
      source_content_cid: "bafy-food-pantry-1",
      source_page_cid: "bafy-food-page-1",
      provider_name: "Neighborhood Food Pantry",
      program_name: "Pantry appointments",
      categories: "Food",
      host: "211.example.test",
      city: "Portland",
      state: "OR",
    },
    {
      doc_id: "svc-meals-1",
      doc_type: "service",
      title: "Community Meal Site",
      text: "Community Meal Site serves prepared meals and referral support in Portland.",
      text_truncated: false,
      source_url: "https://211.example.test/meals",
      source_content_cid: "bafy-meals-1",
      source_page_cid: "bafy-meals-page-1",
      provider_name: "Community Meal Site",
      program_name: "Prepared meals",
      categories: "Food",
      host: "211.example.test",
      city: "Portland",
      state: "OR",
    },
  ];
  const bm25 = {
    schemaVersion: 1,
    documents: [
      {
        doc_id: "svc-food-pantry-1",
        doc_type: "service",
        source_url: "https://211.example.test/food-pantry",
        source_content_cid: "bafy-food-pantry-1",
        source_page_cid: "bafy-food-page-1",
        document_length: 12,
        terms: { food: 3, pantry: 4, portland: 1, grocery: 1 },
        term_idf: { food: 2.1, pantry: 2.8, portland: 0.7, grocery: 1.2 },
      },
      {
        doc_id: "svc-meals-1",
        doc_type: "service",
        source_url: "https://211.example.test/meals",
        source_content_cid: "bafy-meals-1",
        source_page_cid: "bafy-meals-page-1",
        document_length: 9,
        terms: { food: 1, meals: 3, portland: 1 },
        term_idf: { food: 2.1, meals: 1.6, portland: 0.7 },
      },
    ],
    documentFrequency: { food: 2, pantry: 1, portland: 2, grocery: 1, meals: 1 },
    k1: 1.2,
    b: 0.75,
    avgdl: 10.5,
    documentCount: 2,
    maxTermsPerDocument: 8,
  };

  await page.route("**/corpus/211-info/current/generated/documents.json", async (route) => {
    await route.fulfill({ json: documents });
  });
  await page.route("**/corpus/211-info/current/generated/bm25-documents.json", async (route) => {
    await route.fulfill({ json: bm25 });
  });
}

async function sendAssistantMessage(assistant: Locator, message: string): Promise<void> {
  const composer = assistant.getByLabel(/Message Abby assistant/i);
  await expect(composer).toBeEnabled({ timeout: 45000 });
  await composer.fill(message);
  await assistant.getByRole("button", { name: /Send assistant message/i }).click();
}

async function firstEvidenceDocId(assistant: Locator): Promise<string> {
  const firstEvidenceItem = assistant.locator(".agent-evidence-item").first();
  await expect(firstEvidenceItem).toBeVisible();
  return (await firstEvidenceItem.locator("dl div").filter({ hasText: "Doc ID" }).locator("dd").innerText()).trim();
}

async function getScrollCapacity(locator: Locator): Promise<number> {
  return locator.evaluate((node) => node.scrollHeight - node.clientHeight);
}

async function getAudioPlayCallCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & { __abbyAudioPlayCalls?: number }).__abbyAudioPlayCalls || 0);
}

async function getAudioSourceLog(page: Page): Promise<string> {
  return page.evaluate(
    () => (window as typeof window & { __abbyAudioSources?: string[] }).__abbyAudioSources?.join(" ") || "",
  );
}

async function resetAudioPlaybackLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __abbyAudioPlayCalls?: number;
      __abbyAudioSources?: string[];
    };
    testWindow.__abbyAudioPlayCalls = 0;
    testWindow.__abbyAudioSources = [];
  });
}

function isMobileProject(projectName: string): boolean {
  return /^Mobile /.test(projectName);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
