import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: { profile: 'local', mediaBaseUrl: 'http://localhost:9000/od-media-local' },
    },
  },
}));

const { mediaUrlFor, resolveMediaBaseUrl } = await import('./mediaUrl');

/** Keys become URLs at render time and nowhere else (P3-42, ADR-023). */
describe('mediaUrlFor', () => {
  it('joins the key onto the origin, one encoded segment at a time', () => {
    expect(
      mediaUrlFor(
        'u/usr_01J8XKQ2M4N5P6R7S8T9V0W1X2/01M1.png',
        'https://media.ordinarydays.app',
      ),
    ).toBe('https://media.ordinarydays.app/u/usr_01J8XKQ2M4N5P6R7S8T9V0W1X2/01M1.png');
  });

  it('tolerates a trailing slash on the origin and never doubles one', () => {
    expect(mediaUrlFor('u/x/y.jpg', 'http://localhost:9000/od-media-local/')).toBe(
      'http://localhost:9000/od-media-local/u/x/y.jpg',
    );
  });

  it('encodes characters a key must not smuggle into a path', () => {
    expect(mediaUrlFor('u/a b/c?d.png', 'https://m')).toBe('https://m/u/a%20b/c%3Fd.png');
  });

  it('defaults to the configured origin', () => {
    expect(resolveMediaBaseUrl()).toBe('http://localhost:9000/od-media-local');
    expect(mediaUrlFor('u/x/y.png')).toBe(
      'http://localhost:9000/od-media-local/u/x/y.png',
    );
  });
});
