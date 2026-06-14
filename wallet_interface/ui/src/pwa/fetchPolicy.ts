export function shouldHandleServiceWorkerRequest(requestUrl: string, registrationScope: string): boolean {
  if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
    return false;
  }

  return new URL(requestUrl).origin === new URL(registrationScope).origin;
}