import { render } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { IconProps } from './index';
import * as icons from './index';
import * as markers from './markers';

/**
 * The 16 pt marker forms (P3-49, `design-system.md` §5.2).
 *
 * Same method as `icons.test.tsx`: `react-native-svg` is stubbed, so the element tree the
 * component returns is inspected for its grammar rather than its look. The properties that
 * matter here are the ones the registry test deliberately does *not* see — the compensated
 * 1.9 weight and the dropped interiors — and that each marker keeps the silhouette of the
 * full glyph it stands for.
 */

type IconComponent = (props: IconProps) => ReactElement;

interface Shape {
  readonly props: Record<string, unknown>;
}

function shapesOf(node: ReactNode): Shape[] {
  if (Array.isArray(node)) return node.flatMap(shapesOf);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode } & Record<string, unknown>;
  const own: Shape[] = 'd' in props || 'cx' in props || 'x' in props ? [{ props }] : [];
  return [...own, ...shapesOf(props.children)];
}

const COLOR = 'rgb(1, 2, 3)';
const shapes16 = (Icon: IconComponent): Shape[] =>
  shapesOf(Icon({ size: 16, color: COLOR }));

const MARKERS = [
  ['BowlMarker', markers.BowlMarker, icons.Bowl],
  ['PlayRectMarker', markers.PlayRectMarker, icons.PlayRect],
  ['MapPinMarker', markers.MapPinMarker, icons.MapPin],
  ['DiamondMarker', markers.DiamondMarker, icons.Diamond],
] as const;

describe('the marker weight', () => {
  it('is 1.9 viewBox units — ~1.27 px at 16 pt, lighter than the 1.5 px checkbox border', () => {
    expect(markers.MARKER_STROKE_WIDTH).toBe(1.9);
    expect(markers.MARKER_SIZE).toBe(16);
    // The rendered stroke at the marker size must stay below the checkbox's 1.5 px border.
    expect((markers.MARKER_STROKE_WIDTH * markers.MARKER_SIZE) / 24).toBeLessThan(1.5);
    // And above the 1.0 px a registry glyph scales down to — the reason the forms exist.
    expect((markers.MARKER_STROKE_WIDTH * markers.MARKER_SIZE) / 24).toBeGreaterThan(1);
  });

  it.each(MARKERS)('%s draws every shape at the marker weight', (_name, Marker) => {
    const shapes = shapes16(Marker);
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.props.strokeWidth).toBe(markers.MARKER_STROKE_WIDTH);
      expect(shape.props.strokeLinecap).toBe('round');
      expect(shape.props.strokeLinejoin).toBe('round');
      expect(shape.props.stroke).toBe(COLOR);
      expect(shape.props.fill).toBeUndefined();
    }
  });
});

describe('each marker keeps its full glyph’s silhouette', () => {
  const outline = (shape: Shape) =>
    shape.props.d ?? [
      shape.props.x,
      shape.props.y,
      shape.props.width,
      shape.props.height,
    ];

  it.each(MARKERS)(
    '%s draws a subset of the full form’s geometry',
    (_name, Marker, Full) => {
      const full = shapesOf(Full({ size: 24, color: COLOR })).map(outline);
      const marker = shapes16(Marker).map(outline);
      for (const shape of marker) expect(full).toContainEqual(shape);
    },
  );

  it('drops the bowl’s steam and the pin’s dot, and nothing from the other two', () => {
    expect(shapes16(markers.BowlMarker)).toHaveLength(1);
    expect(shapes16(markers.MapPinMarker)).toHaveLength(1);
    expect(shapes16(markers.MapPinMarker).some((s) => 'cx' in s.props)).toBe(false);
    expect(shapes16(markers.PlayRectMarker)).toHaveLength(
      shapesOf(icons.PlayRect({ size: 24, color: COLOR })).length,
    );
    expect(shapes16(markers.DiamondMarker)).toHaveLength(1);
  });

  it('gives no two markers the same geometry', () => {
    const seen = new Set(MARKERS.map(([, Marker]) => JSON.stringify(shapes16(Marker))));
    expect(seen.size).toBe(MARKERS.length);
  });
});

describe('every marker mounts at 16', () => {
  it.each(MARKERS)('%s mounts and carries the requested size', (_name, Marker) => {
    const element = Marker({ size: 16, color: COLOR });
    expect(element.props.size).toBe(16);
    const { container } = render(<Marker size={16} color={COLOR} />);
    expect(container.querySelectorAll('[data-svg]').length).toBeGreaterThan(0);
  });
});
