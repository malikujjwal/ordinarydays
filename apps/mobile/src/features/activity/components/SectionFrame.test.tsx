import { ThemeProvider } from '@od/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionFrame } from './SectionFrame';

/**
 * Every box between the caption and the section must have a definite width on native.
 *
 * jsdom cannot run Yoga, so this asserts the structural rule instead of the pixels: a box laid
 * out along a row must grow into that row. A content-sized box around `SectionHeader` (whose
 * caption sits in a `flex: 1`, zero-basis box) measures 0 pt wide on iOS — the 2026-09-11
 * device report where DETAILS, INGREDIENTS, NOTES and SETTINGS all disappeared.
 */
function rowChildrenThatDoNotGrow(from: HTMLElement, to: HTMLElement): HTMLElement[] {
  const offenders: HTMLElement[] = [];
  let node: HTMLElement | null = from;
  while (node !== null && node !== to) {
    const parent: HTMLElement | null = node.parentElement;
    if (parent === null) break;
    const direction = getComputedStyle(parent).flexDirection;
    if (direction === 'row' && getComputedStyle(node).flexGrow !== '1')
      offenders.push(node);
    node = parent;
  }
  return offenders;
}

function frame(props: Partial<Parameters<typeof SectionFrame>[0]> = {}) {
  return render(
    <ThemeProvider scheme="light">
      <SectionFrame
        label="Ingredients"
        ruled
        trailing="Edit"
        onTrailingPress={() => undefined}
        testID="section-test"
        {...props}
      >
        {null}
      </SectionFrame>
    </ThemeProvider>,
  );
}

describe('SectionFrame heading row', () => {
  it('gives the caption a growing box on every row, with meta present', () => {
    frame({ meta: '1 of 4 on a list' });
    const heading = screen.getByRole('heading', { name: 'Ingredients' });
    expect(rowChildrenThatDoNotGrow(heading, screen.getByTestId('section-test'))).toEqual(
      [],
    );
    expect(screen.getByTestId('section-test-meta').textContent).toBe('1 of 4 on a list');
  });

  it('gives the caption a growing box without meta', () => {
    frame();
    const heading = screen.getByRole('heading', { name: 'Ingredients' });
    expect(rowChildrenThatDoNotGrow(heading, screen.getByTestId('section-test'))).toEqual(
      [],
    );
    expect(screen.queryByTestId('section-test-meta')).toBeNull();
  });

  it('centres the heading row instead of baseline-aligning it', () => {
    frame({ meta: '4' });
    const section = screen.getByTestId('section-test');
    const row = section.firstElementChild as HTMLElement;
    expect(getComputedStyle(row).alignItems).toBe('center');
    const labelArea = row.firstElementChild as HTMLElement;
    expect(getComputedStyle(labelArea).alignItems).toBe('center');
  });

  it('keeps the ruled hairline and the trailing action', () => {
    frame();
    const row = screen.getByTestId('section-test').firstElementChild as HTMLElement;
    expect(getComputedStyle(row).borderBottomWidth).toBe('1px');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined();
  });
});
