import { load211DocumentGeoClusters } from "./corpus";
import type { DocumentGeoClusterManifest, SearchCoordinates } from "./types";

const LOCATION_BIASED_QUERY_PATTERN =
  /\b(?:near me|nearby|closest|close by|around me|in my area|near us|around us|walkable|within \d+\s*(?:mi|mile|miles|km|kilometer|kilometers))\b/i;
const BROWSER_LOCATION_TTL_MS = 5 * 60 * 1000;

let cachedCoordinates: SearchCoordinates | null = null;
let cachedCoordinatesAt = 0;
let pendingCoordinatesPromise: Promise<SearchCoordinates | null> | null = null;

export async function resolvePreferred211ServiceClusterIds(query: string, limit = 8): Promise<number[]> {
  const clusterManifest = await load211DocumentGeoClusters().catch(() => null);
  if (!clusterManifest?.clusters?.length) {
    return [];
  }
  const coordinates = await resolvePreferred211SearchCoordinates(query, { allowPrompt: true });
  if (!coordinates) {
    return [];
  }
  return rankClustersByDistance(clusterManifest, coordinates)
    .slice(0, Math.max(1, limit))
    .map((cluster) => cluster.clusterId);
}

export async function resolvePreferred211SearchCoordinates(
  query: string,
  options: { allowPrompt?: boolean } = {},
): Promise<SearchCoordinates | null> {
  return getPreferredBrowserCoordinates(query, options.allowPrompt === true);
}

export function isLocationBiasedSearchQuery(query: string): boolean {
  return LOCATION_BIASED_QUERY_PATTERN.test(query);
}

async function getPreferredBrowserCoordinates(query: string, allowPrompt: boolean): Promise<SearchCoordinates | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return null;
  }
  if (cachedCoordinates && Date.now() - cachedCoordinatesAt < BROWSER_LOCATION_TTL_MS) {
    return cachedCoordinates;
  }
  if (pendingCoordinatesPromise) {
    return pendingCoordinatesPromise;
  }

  const permissionState = await queryGeolocationPermissionState();
  const shouldPrompt = allowPrompt || isLocationBiasedSearchQuery(query);
  if (permissionState === "denied") {
    return null;
  }
  if (!shouldPrompt && permissionState !== "granted") {
    return null;
  }

  pendingCoordinatesPromise = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextCoordinates = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        cachedCoordinates = nextCoordinates;
        cachedCoordinatesAt = Date.now();
        resolve(nextCoordinates);
      },
      () => resolve(null),
      {
        enableHighAccuracy: false,
        maximumAge: BROWSER_LOCATION_TTL_MS,
        timeout: shouldPrompt ? 10000 : 2500,
      },
    );
  });

  try {
    return await pendingCoordinatesPromise;
  } finally {
    pendingCoordinatesPromise = null;
  }
}

async function queryGeolocationPermissionState(): Promise<PermissionState | null> {
  if (typeof navigator === "undefined") {
    return null;
  }
  const permissions = (navigator as Navigator & {
    permissions?: { query?: (descriptor: { name: string }) => Promise<{ state: PermissionState }> };
  }).permissions;
  if (!permissions?.query) {
    return null;
  }
  try {
    const status = await permissions.query({ name: "geolocation" });
    return status.state;
  } catch {
    return null;
  }
}

function rankClustersByDistance(
  clusterManifest: DocumentGeoClusterManifest,
  coordinates: SearchCoordinates,
) {
  return clusterManifest.clusters
    .filter(
      (cluster) =>
        cluster.kind === "service_cluster" &&
        cluster.centroid.lat != null &&
        cluster.centroid.lon != null &&
        cluster.clusterId >= 0,
    )
    .map((cluster) => ({
      ...cluster,
      distanceMiles: haversineMiles(coordinates, {
        lat: cluster.centroid.lat as number,
        lon: cluster.centroid.lon as number,
      }),
    }))
    .sort((left, right) => left.distanceMiles - right.distanceMiles || left.clusterId - right.clusterId);
}

export function haversineMiles(from: SearchCoordinates, to: SearchCoordinates): number {
  const earthRadiusMiles = 3958.7613;
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(to.lon - from.lon);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusMiles * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
