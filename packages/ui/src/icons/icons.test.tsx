import { render } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { IconProps } from './index';
import * as icons from './index';

/**
 * The icon registry's grammar, and the eleven catalogue glyphs P3-45 added to it.
 *
 * ## Why the shapes are inspected rather than snapshotted
 *
 * `react-native-svg` is stubbed under test — see `vitest.config.ts` — so nothing here can
 * assert what a glyph *looks like*. What it can assert, and what actually goes wrong, is the
 * grammar: a shape drawn at the wrong weight, filled when it should be outlined, taking a
 * colour that is not the caller's, or silently sharing another icon's geometry. Every one of
 * those is a property of the element tree, and every one of them ships looking almost right.
 *
 * The shapes themselves are reviewed in the token gallery, in a browser, where the real
 * library loads through Metro.
 */

type IconComponent = (props: IconProps) => ReactElement;

interface Shape {
  readonly kind: string;
  readonly props: Record<string, unknown>;
}

/**
 * Every drawing primitive an icon renders, flattened out of the element tree.
 *
 * Reads the tree the component **returns** rather than the DOM it mounts to, because the
 * stub throws its props away — and the props are the whole subject here.
 */
function shapesOf(node: ReactNode): Shape[] {
  if (Array.isArray(node)) return node.flatMap(shapesOf);
  if (!isValidElement(node)) return [];

  const props = node.props as { children?: ReactNode } & Record<string, unknown>;
  const type = node.type as { name?: string } | string;
  const kind = typeof type === 'string' ? type : (type.name ?? 'unknown');

  // `Frame` and `Svg` carry no geometry; everything below them does.
  const own: Shape[] =
    'd' in props || 'cx' in props || 'x' in props ? [{ kind, props }] : [];

  return [...own, ...shapesOf(props.children)];
}

const COLOR = 'rgb(1, 2, 3)';

const render24 = (Icon: IconComponent): Shape[] =>
  shapesOf(Icon({ size: 24, color: COLOR }));

/** Every icon this module exports, by name. */
const allIcons = Object.entries(icons).filter(
  (entry): entry is [string, IconComponent] => typeof entry[1] === 'function',
);

/** The eleven P3-45 drew, named so a removal fails here rather than at a call site. */
const CATALOGUE_GLYPHS = [
  'Bag',
  'Book',
  'Cart',
  'Cup',
  'Film',
  'Gift',
  'Glass',
  'Heart',
  'List',
  'Star',
  'Suitcase',
] as const;

describe('the eleven catalogue glyphs exist', () => {
  it.each(CATALOGUE_GLYPHS)('exports %s', (name) => {
    expect(typeof (icons as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports all eleven, and nothing was dropped in a merge', () => {
    expect(CATALOGUE_GLYPHS).toHaveLength(11);
  });

  /**
   * `list` is the `simple-list` glyph. `ListLines` is the Lists **tab** — three lines with
   * leading dots — and P3-45's edge case names confusing the two as the failure to avoid.
   */
  it('draws List and ListLines differently', () => {
    // By geometry, not by element name: the stub's exports are anonymous, so `kind` is empty
    // for every shape under test and would make this assertion pass vacuously.
    const hasCircles = (shapes: Shape[]) => shapes.some((s) => 'cx' in s.props);

    expect(render24(icons.List)).not.toEqual(render24(icons.ListLines));
    expect(hasCircles(render24(icons.List))).toBe(false);
    expect(hasCircles(render24(icons.ListLines))).toBe(true);
  });
});

describe('the registry grammar (design-system.md §5.4)', () => {
  /**
   * **`Check` is the one documented exception** — it is the filled completion glyph and
   * draws at 2.25 — and it is excluded by name rather than by a rule, so a second exception
   * has to be added here deliberately instead of slipping in behind a predicate.
   */
  const grammarIcons = allIcons.filter(([name]) => name !== 'Check');

  it('has icons to check', () => {
    expect(grammarIcons.length).toBeGreaterThan(20);
  });

  it.each(grammarIcons)('%s draws at the shared 1.5 weight', (_name, Icon) => {
    const shapes = render24(Icon);
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.props.strokeWidth).toBe(1.5);
    }
  });

  it.each(grammarIcons)('%s uses round caps and joins', (_name, Icon) => {
    for (const shape of render24(Icon)) {
      expect(shape.props.strokeLinecap).toBe('round');
      expect(shape.props.strokeLinejoin).toBe('round');
    }
  });

  /** The colour is the caller's, always. A hard-coded one is invisible until dark mode. */
  it.each(grammarIcons)('%s takes its colour from the prop', (_name, Icon) => {
    for (const shape of render24(Icon)) {
      expect(shape.props.stroke).toBe(COLOR);
    }
  });

  /** Outlines, not fills. The `Frame` sets `fill="none"`; no shape may override it. */
  it.each(allIcons)('%s sets no fill of its own', (_name, Icon) => {
    for (const shape of render24(Icon)) {
      expect(shape.props.fill).toBeUndefined();
    }
  });
});

/**
 * **No glyph borrows another's shape.**
 *
 * P3-45's edge case: the catalogue's seventeen entries are meant to be tellable apart at a
 * glance in the style chooser, so a template must not share a glyph with another to avoid
 * drawing one. Two icons with identical geometry is exactly what that looks like in code,
 * and it is the shortcut a future task under time pressure would take.
 */
describe('every glyph is distinct', () => {
  const signature = (Icon: IconComponent) =>
    JSON.stringify(
      render24(Icon).map((shape) => [
        shape.kind,
        shape.props.d ?? '',
        shape.props.cx ?? '',
        shape.props.cy ?? '',
        shape.props.r ?? '',
        shape.props.x ?? '',
        shape.props.y ?? '',
        shape.props.width ?? '',
        shape.props.height ?? '',
      ]),
    );

  it('gives no two exported icons the same geometry', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const [name, Icon] of allIcons) {
      const key = signature(Icon);
      const first = seen.get(key);
      if (first === undefined) seen.set(key, name);
      else duplicates.push(`${first} and ${name}`);
    }

    expect(duplicates).toEqual([]);
  });
});

describe('every icon renders at 24 and at 44', () => {
  /**
   * 24 is the default type size and 44 is the minimum tap target
   * (`interaction-contract.md` §6). Both are asserted because `size` is forwarded through
   * `Frame`'s default, and a glyph that hard-coded its own would look right at exactly one
   * of them.
   */
  it.each(allIcons)(
    '%s carries the requested size and draws something',
    (_name, Icon) => {
      for (const size of [24, 44]) {
        const element = Icon({ size, color: COLOR });
        expect(element.props.size).toBe(size);

        const shapes = shapesOf(element);
        expect(shapes.length).toBeGreaterThan(0);
        // Non-empty geometry, not merely a shape element: an empty `d` renders nothing.
        for (const shape of shapes) {
          const geometry = shape.props.d ?? shape.props.r ?? shape.props.width;
          expect(geometry).toBeTruthy();
        }
      }
    },
  );

  /** And they mount, which the element-tree walk above does not prove on its own. */
  it.each(allIcons)('%s mounts at both sizes', (_name, Icon) => {
    for (const size of [24, 44]) {
      const { container } = render(<Icon size={size} color={COLOR} />);
      expect(container.querySelectorAll('[data-svg]').length).toBeGreaterThan(0);
    }
  });
});
