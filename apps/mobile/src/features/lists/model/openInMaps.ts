import type { ListPlace } from '@od/shared/types';
import { Linking, Platform } from 'react-native';

/**
 * Opens a stored place in the platform's maps app (`plans-and-lists.md` §5.7).
 *
 * §5.7 says a place is "rendered under the title and tappable through to the platform maps
 * app", and this is that tap. Apple Maps on iOS, the `geo:` scheme on Android, and Google
 * Maps' web URL everywhere else — three destinations rather than one because a `geo:` link
 * opens nothing in a browser and `maps:` opens nothing on Android.
 *
 * ## It searches by text, and that is the honest read of what we store
 *
 * `location` is a label and an optional address, both typed by a person; `lat`/`lng` exist on
 * the type but no v1 surface collects them. So the query is the address when there is one and
 * the label otherwise — the same string the row displays, which means the user can see what
 * the maps app was asked before they tap.
 *
 * A failure to open is swallowed deliberately. There is no maps app on a simulator and none in
 * a browser tab with the scheme blocked, and a toast saying so is noise about the device
 * rather than about anything the user did.
 */
export function openInMaps(location: ListPlace | undefined): Promise<void> {
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
