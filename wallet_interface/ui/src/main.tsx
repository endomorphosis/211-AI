import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { loadRuntimeConfig } from "./lib/runtimeConfig";
import "./styles/global.css";

void bootstrap();

const enablePwaInAutomation = import.meta.env.VITE_ENABLE_PWA_IN_AUTOMATION === "true";
const shouldRegisterServiceWorker =
  "serviceWorker" in navigator &&
  import.meta.env.PROD &&
  (!navigator.webdriver || enablePwaInAutomation);

if (shouldRegisterServiceWorker) {
  const serviceWorkerUrl = new URL("serviceWorker.js", window.location.href);
  const scopeUrl = new URL("./", serviceWorkerUrl);
  const hadServiceWorkerController = Boolean(navigator.serviceWorker.controller);
  let notifiedServiceWorkerUpdate = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadServiceWorkerController || notifiedServiceWorkerUpdate) return;
    notifiedServiceWorkerUpdate = true;
    console.info("[Abby] A new app version is ready and will be used on the next refresh.");
  });

  window.addEventListener("load", () => {
    registerServiceWorker(serviceWorkerUrl, scopeUrl).catch(() => {
      // The app remains usable without PWA support.
    });
  });
}

async function registerServiceWorker(serviceWorkerUrl: URL, scopeUrl: URL): Promise<void> {
  const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {
    scope: scopeUrl.pathname,
    type: "module",
  });
  await registration.update().catch(() => undefined);
}

async function bootstrap(): Promise<void> {
  await loadRuntimeConfig();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
