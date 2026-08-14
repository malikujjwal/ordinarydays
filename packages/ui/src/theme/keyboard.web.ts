import { useEffect, useState } from 'react';

/**
 * The web fork of `useKeyboardInset` — the full reasoning is in `keyboard.ts`.
 *
 * React Native Web's `Keyboard` module is a no-op: its listeners never fire, so the native file
 * would report `0` forever and every field on a mobile browser would sit under the keyboard.
 * The browser reports the same fact through `visualViewport`, whose height shrinks by the
 * keyboard when one opens.
 *
 * `offsetTop` is subtracted because the visual viewport also *scrolls* within the layout
 * viewport when a focused field is pushed up; without it the inset double-counts and the
 * container lifts twice as far as it should.
 *
 * Desktop browsers have no software keyboard and simply never resize, so this stays `0` and
 * costs two idle listeners.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport =
      typeof window === 'undefined' ? null : (window.visualViewport ?? null);
    if (viewport === null) return;

    const read = () => {
      setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    };

    read();
    viewport.addEventListener('resize', read);
    viewport.addEventListener('scroll', read);
    return () => {
      viewport.removeEventListener('resize', read);
      viewport.removeEventListener('scroll', read);
    };
  }, []);

  return inset;
}
