const selfUrl = new URL(import.meta.url);
const appRoot = new URL("../", selfUrl);
const shellResponse = await fetch(new URL("index.html?abby-client-llm-recover=" + Date.now(), appRoot), {
  cache: "no-store",
});
if (!shellResponse.ok) throw new Error("Unable to load the current Abby app shell.");
const html = await shellResponse.text();
const scriptPattern = /\bsrc=["']([^"']*assets\/app-[^"']+\.js)["']/gi;
let currentChunkUrl;
let scriptMatch;
while ((scriptMatch = scriptPattern.exec(html))) {
  const appScriptUrl = new URL(scriptMatch[1], appRoot);
  const appScriptResponse = await fetch(appScriptUrl.href + "?abby-client-llm-recover=" + Date.now(), {
    cache: "no-store",
  });
  if (!appScriptResponse.ok) continue;
  const appScript = await appScriptResponse.text();
  const chunkMatch = /clientLLMWorkerService-[A-Za-z0-9_-]+\.js/.exec(appScript);
  if (chunkMatch) {
    currentChunkUrl = new URL("assets/" + chunkMatch[0], appRoot);
    break;
  }
}
if (!currentChunkUrl) throw new Error("Unable to find the current Abby LLM service chunk.");
const currentModule = await import(currentChunkUrl.href);
export const clientLLMWorkerService = currentModule.clientLLMWorkerService;
export default currentModule.default;
