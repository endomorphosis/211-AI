import { chromium } from "playwright";

const baseUrl = process.env.ABBY_CHECK_BASE_URL || "http://127.0.0.1:4179/";
const voiceUrl = "https://animegf.chat:8790/api/voice/infer";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 1,
});

const consoleMessages = [];
const page = await context.newPage();
page.on("console", (message) => {
  consoleMessages.push({ type: message.type(), text: message.text() });
});

await page.route(voiceUrl, async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      audioBase64: "UklGRg==",
      mimeType: "audio/wav",
      model: "remote-voice-proxy",
      text: "Mock voice reply.",
    }),
  });
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });

  const serviceWorkerState = await page.evaluate(async () => {
    const registrations = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistrations() : [];
    return {
      hasController: Boolean(navigator.serviceWorker?.controller),
      registrationCount: registrations.length,
      scope: registrations[0]?.scope ?? null,
    };
  });

  const proxyResult = await page.evaluate(async (endpoint) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ mode: "tts", text: "test" }),
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, voiceUrl);

  const serviceWorkerConsoleErrors = consoleMessages.filter((message) => {
    const text = message.text.toLowerCase();
    return text.includes("serviceworker.js") || text.includes("failed to fetch");
  });

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    serviceWorkerState,
    proxyResult,
    serviceWorkerConsoleErrors,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
