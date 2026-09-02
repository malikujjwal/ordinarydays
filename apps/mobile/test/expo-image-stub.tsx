/**
 * A stand-in for `expo-image` under test (P3-42). See the alias note in `vitest.config.ts`.
 *
 * The real module reaches native code the moment it loads. The suite needs only what the
 * component tree says about an image — its source URL and its accessible name — so the stub
 * renders a plain `<img>` carrying both, plus the `data-testid` React Native Web would have
 * written for `testID`. Kept as a visible file rather than a `vi.mock` in a setup file, for
 * the same reason the SVG stub is.
 */
import type { CSSProperties } from 'react';

interface StubImageProps {
  source?: { uri?: string } | string | number | null;
  accessibilityLabel?: string;
  accessibilityIgnoresInvertColors?: boolean;
  contentFit?: string;
  style?: unknown;
  testID?: string;
  recyclingKey?: string;
  transition?: number;
}

export function Image({ source, accessibilityLabel, style, testID }: StubImageProps) {
  const uri =
    typeof source === 'object' && source !== null && 'uri' in source
      ? source.uri
      : undefined;
  return (
    <img
      src={uri}
      alt={accessibilityLabel ?? ''}
      data-testid={testID}
      style={
        Array.isArray(style) ? Object.assign({}, ...style) : (style as CSSProperties)
      }
    />
  );
}

export default Image;
