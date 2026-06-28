export const APP_CACHE_PREFIX = "abby-";

export function shouldDeleteAppCache(cacheName: string, currentCacheNames: ReadonlySet<string>): boolean {
  return cacheName.startsWith(APP_CACHE_PREFIX) && !currentCacheNames.has(cacheName);
}
