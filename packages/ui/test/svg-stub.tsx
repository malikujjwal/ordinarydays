/**
 * A stand-in for `react-native-svg` under test. See the alias note in `vitest.config.ts`.
 *
 * Every export renders a plain host element carrying its props, so an icon still produces a
 * node in the tree — which is all the suite needs, because nothing in it asserts SVG
 * rendering. The real library loads in the app and in the token gallery, where the shapes are
 * actually looked at.
 *
 * Kept as a real component rather than `vi.mock` in a setup file so that it is visible: a
 * stub hidden in `vitest.setup.ts` is one nobody finds when a test starts behaving oddly.
 */
import type { ReactNode } from 'react';

interface StubProps {
  children?: ReactNode;
  [key: string]: unknown;
}

const stub =
  (name: string) =>
  ({ children }: StubProps) => <div data-svg={name}>{children}</div>;

export default stub('svg');
export const Svg = stub('svg');
export const Path = stub('path');
export const Circle = stub('circle');
export const Rect = stub('rect');
export const G = stub('g');
export const Line = stub('line');
export const Polyline = stub('polyline');
export const Polygon = stub('polygon');
export const Defs = stub('defs');
export const LinearGradient = stub('linearGradient');
export const Stop = stub('stop');
