const selfUrl = new URL(import.meta.url);
const appRoot = new URL("../", selfUrl);
const shellResponse = await fetch(new URL("index.html?abby-client-audio-worker-recover=" + Date.now(), appRoot), {
  cache: "no-store",
});
if (!shellResponse.ok) throw new Error("Unable to load the current Abby app shell.");
const html = await shellResponse.text();
const scriptPattern = /\bsrc=["']([^"']*assets\/app-[^"']+\.js)["']/gi;
let currentWorkerUrl;
let scriptMatch;
while ((scriptMatch = scriptPattern.exec(html))) {
  const appScriptUrl = new URL(scriptMatch[1], appRoot);
  const appScriptResponse = await fetch(appScriptUrl.href + "?abby-client-audio-worker-recover=" + Date.now(), {
    cache: "no-store",
  });
  if (!appScriptResponse.ok) continue;
  const appScript = await appScriptResponse.text();
  const workerMatch = /clientAudioWorker-[A-Za-z0-9_-]+\.js/.exec(appScript);
  if (workerMatch) {
    currentWorkerUrl = new URL("assets/" + workerMatch[0], appRoot);
    break;
  }
}
if (!currentWorkerUrl) throw new Error("Unable to find the current Abby audio worker chunk.");
await import(currentWorkerUrl.href);
