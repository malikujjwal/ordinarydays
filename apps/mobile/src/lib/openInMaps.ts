import { Linking, Platform } from 'react-native';

export interface MappablePlace {
  readonly label: string;
  readonly address?: string;
}

/**
 * Opens visible place text in the platform maps app (`plans-and-lists.md` §2.1 and §5.7).
 *
 * The product stores a person-authored label and optional address, not guaranteed coordinates,
 * so the address wins when present and the label is the honest fallback. Apple Maps owns iOS,
 * `geo:` owns Android, and the browser uses Google Maps. Device failures are deliberately
 * absorbed: an unavailable maps app does not invalidate the saved place.
 */
export function openInMaps(location: MappablePlace | undefined): Promise<void> {
  if (location === undefined) return Promise.resolve();
  const query = encodeURIComponent(location.address ?? location.label);
  const url =
    Platform.OS === 'ios'
      ? `maps:0,0?q=${query}`
      : Platform.OS === 'android'
        ? `geo:0,0?q=${query}`
        : `https://www.google.com/maps/search/?api=1&query=${query}`;
  return Linking.openURL(url).catch(() => undefined);
}
