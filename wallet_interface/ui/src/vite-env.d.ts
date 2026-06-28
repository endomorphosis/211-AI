/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WORLD_ID_ENABLED?: string;
  readonly VITE_WORLD_ID_APP_ID?: string;
  readonly VITE_WORLD_ID_ACTION?: string;
  readonly VITE_WORLD_ID_ENVIRONMENT?: string;
}

interface Window {
  __ABBY_RUNTIME_CONFIG__?: import("./lib/runtimeConfig").AbbyRuntimeConfig;
}
