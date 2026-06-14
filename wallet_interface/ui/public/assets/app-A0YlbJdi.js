(async () => {
  const selfUrl = new URL(import.meta.url);
  const appRoot = new URL("../", selfUrl);
  const response = await fetch(new URL("index.html?abby-cache-recover=" + Date.now(), appRoot), { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load the current Abby app shell.");
  const html = await response.text();
  const assetPattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  const assetUrls = [];
  let match;
  while ((match = assetPattern.exec(html))) {
    if (match[1] && !match[1].startsWith("data:") && !match[1].startsWith("blob:")) {
      assetUrls.push(new URL(match[1], appRoot));
    }
  }
  for (const url of assetUrls.filter((candidate) => /\/assets\/app-[^/]+\.css(?:$|\?)/.test(candidate.href))) {
    if (!document.querySelector('link[href="' + url.href + '"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url.href;
      document.head.appendChild(link);
    }
  }
  const currentScript = assetUrls.find(
    (candidate) => /\/assets\/app-[^/]+\.js(?:$|\?)/.test(candidate.href) && candidate.href !== selfUrl.href,
  );
  if (!currentScript) throw new Error("Unable to find the current Abby app bundle.");
  await import(currentScript.href);
})().catch((error) => {
  console.error("[Abby] stale app asset recovery failed", error);
  const url = new URL(window.location.href);
  if (!url.searchParams.has("abbyCacheRecover")) {
    url.searchParams.set("abbyCacheRecover", String(Date.now()));
    window.location.replace(url.href);
  }
});
