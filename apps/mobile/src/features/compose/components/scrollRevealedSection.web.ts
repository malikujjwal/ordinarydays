import type { ScrollView, View } from 'react-native';

/**
 * Scrolls a newly revealed Add-sheet section into view (web).
 *
 * The child is an RN-web host that is also a DOM node. Native never loads this file.
 */
export function scrollRevealedSectionIntoView(
  _scroll: ScrollView | null,
  child: View | null,
): void {
  if (child === null) return;
  const node: unknown = child;
  if (typeof HTMLElement !== 'undefined' && node instanceof HTMLElement) {
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'start', inline: 'nearest' });
    }
  }
}
