import { Text, ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReorderableList } from './ReorderableList';

/**
 * §7.1's hover drag handle and the keyboard path beside it (§P3-30).
 *
 * The web variant, which is the one a test can actually drive: a pointer drag and a native
 * long-press are both unavailable under jsdom, and the keyboard grab is not a lesser stand-in
 * for them — §7.1 requires it to exist ("hover-revealed controls are always **also** reachable
 * by keyboard and are never the only path to an action"), so it is the path under test in its
 * own right.
 *
 * What is asserted is the **index that reaches `onDrop`**. What that index then means — the
 * no-op, the `afterItemId`, the watch refusal — is `reorder.test.ts`'s, and what it costs on
 * the wire is `useReorderItems.test.tsx`'s.
 */

interface Row {
  readonly itemId: string;
  readonly title: string;
}

const rows: Row[] = [
  { itemId: 'itm_a', title: 'Milk' },
  { itemId: 'itm_b', title: 'Eggs' },
  { itemId: 'itm_c', title: 'Bread' },
  { itemId: 'itm_d', title: 'Jam' },
];

const onDrop = vi.fn();

function mount(rangeOf: (itemId: string) => { first: number; last: number } | undefined) {
  render(
    <ThemeProvider scheme="light">
      <ReorderableList
        items={rows}
        keyOf={(row) => row.itemId}
        rangeOf={rangeOf}
        onDrop={onDrop}
        testID="reorderable"
        renderItem={(row) => <Text>{row.title}</Text>}
      />
    </ThemeProvider>,
  );
}

const handle = (itemId: string) => screen.getByTestId(`list-reorder-handle-${itemId}`);

/** The handle listens through one document-level listener, dispatched by what has focus. */
function press(itemId: string, key: string) {
  handle(itemId).focus();
  fireEvent.keyDown(document.activeElement ?? document, { key });
}

const anywhere = () => ({ first: 0, last: rows.length - 1 });

beforeEach(() => {
  onDrop.mockClear();
});

describe('the handle', () => {
  it('is on every draggable row and reachable without a pointer', () => {
    mount(anywhere);

    for (const row of rows) {
      const control = handle(row.itemId);
      expect(control).toBeDefined();
      // In the tab order whether or not anything is hovered: it is only *revealed* by hover.
      expect(control.getAttribute('role')).toBe('button');
    }
  });

  it('is absent on a row that may not be dragged at all', () => {
    mount((itemId) => (itemId === 'itm_b' ? undefined : anywhere()));

    expect(screen.queryByTestId('list-reorder-handle-itm_b')).toBeNull();
    expect(handle('itm_a')).toBeDefined();
  });

  it('names its position, and says what to do once it is held', () => {
    mount(anywhere);

    expect(handle('itm_b').getAttribute('aria-label')).toBe('Reorder, position 2 of 4');
    press('itm_b', 'Enter');
    expect(handle('itm_b').getAttribute('aria-label')).toContain(
      'Moving, position 2 of 4',
    );
    expect(handle('itm_b').getAttribute('aria-label')).toContain('Escape to cancel');
  });
});

describe('one grab, one drop', () => {
  it('drops at the position the arrows reached, in one call', () => {
    mount(anywhere);

    press('itm_a', 'Enter');
    press('itm_a', 'ArrowDown');
    press('itm_a', 'ArrowDown');
    press('itm_a', 'Enter');

    // One mutation for the whole move, not one per keypress.
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('itm_a', 2);
  });

  it('drops nothing until it is let go', () => {
    mount(anywhere);

    press('itm_a', 'Enter');
    press('itm_a', 'ArrowDown');

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('puts the row back on Escape and issues nothing', () => {
    mount(anywhere);

    press('itm_a', 'Enter');
    press('itm_a', 'ArrowDown');
    press('itm_a', 'Escape');

    expect(onDrop).not.toHaveBeenCalled();
    expect(handle('itm_a').getAttribute('aria-label')).toBe('Reorder, position 1 of 4');
  });

  /** A drop back where it started still reaches the hook, which is where the no-op is decided. */
  it('reports a drop back at the same index rather than swallowing it', () => {
    mount(anywhere);

    press('itm_c', 'Enter');
    press('itm_c', 'Enter');

    expect(onDrop).toHaveBeenCalledWith('itm_c', 2);
  });

  /** §7.2's arrows move focus between rows; the override lasts only while a row is held. */
  it('ignores the arrows when nothing is held', () => {
    mount(anywhere);

    handle('itm_a').focus();
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    press('itm_a', 'Enter');
    press('itm_a', 'Enter');

    expect(onDrop).toHaveBeenCalledWith('itm_a', 0);
  });
});

/**
 * §8.1 and §P3-30's recorded decision, as the finger experiences it: the row stops at its own
 * group's edge rather than travelling past a heading and being refused at the end of a drag
 * that looked like it would work.
 */
describe('the watch group guard', () => {
  it('clamps the held row to its own group, however far the arrows are pressed', () => {
    // `itm_a` is a `want` row whose group ends at index 1; the rows below are another status.
    mount((itemId) => (itemId === 'itm_a' ? { first: 0, last: 1 } : anywhere()));

    press('itm_a', 'Enter');
    for (let at = 0; at < 6; at += 1) press('itm_a', 'ArrowDown');
    expect(handle('itm_a').getAttribute('aria-label')).toContain('position 2 of 4');
    press('itm_a', 'Enter');

    expect(onDrop).toHaveBeenCalledWith('itm_a', 1);
  });

  it('pins a row that is the only member of its group', () => {
    mount((itemId) => (itemId === 'itm_d' ? { first: 3, last: 3 } : anywhere()));

    press('itm_d', 'Enter');
    press('itm_d', 'ArrowUp');
    press('itm_d', 'ArrowUp');
    press('itm_d', 'Enter');

    // It reaches the hook at its own index, where `planReorder` reads it as the no-op it is.
    expect(onDrop).toHaveBeenCalledWith('itm_d', 3);
  });
});
