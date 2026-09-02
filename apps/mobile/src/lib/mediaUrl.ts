import Constants from 'expo-constants';
import { metroLanHost } from '@/lib/apiClient';

/**
 * Where an attachment's bytes are read from (P3-42, ADR-023).
 *
 * A row stores a **key** — `u/<userId>/<ulid>.<ext>` — and never a URL. The URL is composed
 * here, at render time, from the profile's media origin: `media.ordinarydays.app` (and its
 * `dev.` twin) once Phase 5 puts CloudFront in front of the bucket, and the local MinIO
 * bucket path until then. Nothing about the origin is persisted, so moving the media host
 * is a config change and every stored row keeps working.
 *
 * Local follows `apiClient`'s rule: on a physical device `localhost` is the phone, so the
 * origin is rewritten to the LAN host Metro is already serving from. `dev` and `prod` name
 * real hostnames and are never rewritten.
 */
const LOCAL_MEDIA_PORT = 9000;
const LOCAL_MEDIA_BUCKET = 'od-media-local';

const extra: Record<string, unknown> = Constants.expoConfig?.extra ?? {};
const profile = typeof extra.profile === 'string' ? extra.profile : 'local';

export function resolveMediaBaseUrl(): string {
  const configured =
    typeof extra.mediaBaseUrl === 'string'
      ? extra.mediaBaseUrl
      : `http://localhost:${LOCAL_MEDIA_PORT}/${LOCAL_MEDIA_BUCKET}`;
  if (profile !== 'local') return configured;

  const lanHost = metroLanHost();
  return lanHost === undefined
    ? configured
    : `http://${lanHost}:${LOCAL_MEDIA_PORT}/${LOCAL_MEDIA_BUCKET}`;
}

export const mediaBaseUrl = resolveMediaBaseUrl();

/** The URL for one stored key against a media origin. Each path segment is encoded once. */
export function mediaUrlFor(key: string, base: string = mediaBaseUrl): string {
  const path = key
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${base.replace(/\/+$/, '')}/${path}`;
}
