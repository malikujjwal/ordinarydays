import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivityType } from '@od/shared/types';
import {
  BowlMarker,
  DiamondMarker,
  MapPinMarker,
  PlayRectMarker,
  ThemeProvider,
  typeAccents,
} from '@od/ui';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MarkerGlyph, typeMarker } from '../model/typeMarker';
import { RowLeading } from './RowLeading';

const cssColor = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

/**
 * P3-49 — per-type row markers (`design-system.md` §5.2).
 *
 * The §5.2 table, verbatim: one glyph per stored type, `custom` (the visible General kind)
 * the only diamond, and the marker drawn in the type's own accent. The registry stub under
 * test throws SVG props away, so the four marker components are wrapped in spies here and the
 * props the row hands them — size and accent — are what the render tests read. The shapes
 * themselves are looked at in the token gallery and in the browser.
 */
vi.mock('@od/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@od/ui')>();
  return {
    ...actual,
    BowlMarker: vi.fn(actual.BowlMarker),
    PlayRectMarker: vi.fn(actual.PlayRectMarker),
    MapPinMarker: vi.fn(actual.MapPinMarker),
    DiamondMarker: vi.fn(actual.DiamondMarker),
  };
});

type MarkerKind = Exclude<ActivityType, 'task'>;

const MATRIX: ReadonlyArray<[MarkerKind, MarkerGlyph, unknown]> = [
  ['meal', 'bowl', BowlMarker],
  ['watch', 'play-rect', PlayRectMarker],
  ['event', 'map-pin', MapPinMarker],
  ['custom', 'diamond', DiamondMarker],
];

const spies = [BowlMarker, PlayRectMarker, MapPinMarker, DiamondMarker].map((icon) =>
  vi.mocked(icon),
);

/** The props of the most recent render of `icon`, whichever React argument shape is in use. */
const lastProps = (icon: unknown) => {
  const calls = vi.mocked(icon as (...args: unknown[]) => unknown).mock.calls;
  return calls.at(-1)?.[0];
};

function mount(node: React.ReactNode, scheme: 'light' | 'dark' = 'light') {
  return render(<ThemeProvider scheme={scheme}>{node}</ThemeProvider>);
}

beforeEach(() => {
  for (const spy of spies) spy.mockClear();
});

describe('typeMarker (§5.2 table)', () => {
  it.each(MATRIX)('%s resolves to %s', (type, glyph, Icon) => {
    const marker = typeMarker(type);
    expect(marker?.glyph).toBe(glyph);
    expect(marker?.Icon).toBe(Icon);
  });

  it('gives custom the only diamond', () => {
    const diamonds = MATRIX.map(([type]) => typeMarker(type)).filter(
      (marker) => marker?.glyph === 'diamond',
    );
    expect(diamonds).toHaveLength(1);
    expect(typeMarker('custom')?.glyph).toBe('diamond');
  });

  it('draws nothing for a task: its §5.2 icon is the checkbox itself', () => {
    expect(typeMarker('task')).toBeUndefined();
  });
});

describe('RowLeading marker rendering', () => {
  it.each(MATRIX)('renders the %s marker as %s in its accent', (type, glyph, Icon) => {
    mount(
      <RowLeading hasCheckbox={false} checked={false} title="Evening plan" type={type} />,
    );

    expect(screen.getByTestId('agenda-leading-marker')).toBeDefined();
    const visual = screen.getByTestId(`agenda-leading-marker-${glyph}`);
    expect(visual.style.width).toBe('24px');
    expect(visual.style.height).toBe('24px');
    expect(visual.style.backgroundColor).toBe(cssColor(typeAccents.light[type].surface));
    expect(screen.queryByRole('checkbox')).toBeNull();
    // 16 × 16, in the type's light accent — the only colour a marker may take.
    expect(lastProps(Icon)).toEqual(
      expect.objectContaining({ size: 16, color: typeAccents.light[type].accent }),
    );
    // And no other kind's glyph was drawn for this row.
    const drawn = spies.filter((spy) => spy.mock.calls.length > 0);
    expect(drawn).toHaveLength(1);
  });

  it('takes the dark accent under the dark scheme', () => {
    mount(
      <RowLeading
        hasCheckbox={false}
        checked={false}
        title="Evening plan"
        type="event"
      />,
      'dark',
    );

    expect(lastProps(MapPinMarker)).toEqual(
      expect.objectContaining({ color: typeAccents.dark.event.accent }),
    );
  });

  it('keeps the marker hidden from assistive technology and roleless', () => {
    mount(
      <RowLeading
        hasCheckbox={false}
        checked={false}
        title="Evening plan"
        type="watch"
      />,
    );

    const marker = screen.getByTestId('agenda-leading-marker');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(marker.getAttribute('role')).toBeNull();
    expect(marker.querySelector('[role]')).toBeNull();
  });

  /**
   * P2-50's unacknowledged create is the one way a task reaches this branch: the checkbox is
   * *absent rather than disabled*. The column is reserved and empty — no glyph stands in for
   * the control the rule removed.
   */
  it('reserves an empty column for a task whose checkbox is withheld', () => {
    mount(
      <RowLeading
        hasCheckbox={false}
        checked={false}
        title="Renew passport"
        type="task"
      />,
    );

    const slot = screen.getByTestId('agenda-leading-marker');
    expect(slot.querySelector('[data-testid^="agenda-leading-marker-"]')).toBeNull();
    expect(slot.querySelector('[data-svg]')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('RowLeading checkbox decision', () => {
  /**
   * `hasCheckbox` is the server's projection (`type === 'task'`, capability-independent). A
   * task the caller cannot complete still carries it, so it still renders a checkbox — a
   * disabled one — and never falls through to a marker. The kind picks glyphs, not controls.
   */
  it('still renders a checkbox, not a marker, for a non-completable task', () => {
    mount(
      <RowLeading
        hasCheckbox
        checked={false}
        title="Renew passport"
        type="task"
        disabled
      />,
    );

    const checkbox = screen.getByRole('checkbox', {
      name: 'Renew passport, not completed',
    });
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByTestId('agenda-leading-marker')).toBeNull();
  });

  it('follows hasCheckbox even when the kind disagrees', () => {
    // A non-task row the projection says is completable renders the projection's control.
    mount(<RowLeading hasCheckbox checked={false} title="Evening plan" type="event" />);
    expect(screen.getByRole('checkbox')).toBeDefined();
    expect(screen.queryByTestId('agenda-leading-marker')).toBeNull();
    expect(MapPinMarker).not.toHaveBeenCalled();
  });

  it('never decides the control from the kind in source', () => {
    const source = readFileSync(resolve(__dirname, 'RowLeading.tsx'), 'utf8');
    expect(source).toContain('if (hasCheckbox)');
    expect(source).not.toMatch(/type\s*[!=]==?\s*'task'/);
    expect(source).not.toMatch(/hasCheckbox.*\btype\b|\btype\b.*hasCheckbox/);
  });
});
