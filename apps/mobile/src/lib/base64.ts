/**
 * Base64 → bytes, for the image bytes `expo-image-picker` hands back (P3-41).
 *
 * The picker returns `base64` on every platform, which is the one representation that avoids
 * a per-platform file reader (`file://` on native, `blob:` on web) and a second dependency.
 * Hermes ships `atob`, but a decoder is twenty lines and a decoder that exists cannot be
 * missing on some runtime, so this one is used everywhere and tested once.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256).fill(255);
for (let i = 0; i < ALPHABET.length; i += 1) LOOKUP[ALPHABET.charCodeAt(i)] = i;
LOOKUP['-'.charCodeAt(0)] = 62;
LOOKUP['_'.charCodeAt(0)] = 63;

export function decodeBase64(encoded: string): Uint8Array {
  // Tolerates a data-URL prefix, whitespace, URL-safe alphabet and missing padding.
  const comma = encoded.indexOf(',');
  const raw = (
    encoded.startsWith('data:') && comma !== -1 ? encoded.slice(comma + 1) : encoded
  ).replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((raw.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let index = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const value = LOOKUP[raw.charCodeAt(i)] ?? 255;
    if (value === 255) throw new Error('Not base64.');
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (acc >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
}
