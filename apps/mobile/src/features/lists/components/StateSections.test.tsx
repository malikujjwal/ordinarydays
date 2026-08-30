import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  StateSections,
  stateGroupDropIndex,
  stateGroupReorderRange,
} from './StateSections';

const list = {
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Saved', active: 'Reading', done: 'Read' },
    groupByState: true,
  },
  featureConfig: {},
} as List & { itemStateMode: Extract<List['itemStateMode'], { mode: 'stages' }> };

const item = (id: string, state: ListItemView['state']): ListItemView => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  itemId: `itm_01J8XKQ2M4N5P6R7S8T9V0W${id}`,
  rank: `a${id}`,
  title: id,
  state,
});

describe('StateSections', () => {
  it('keeps each stage drag in section-local index space and translates the drop once', () => {
    const rows = [
      item('1X1', 'open'),
      item('1X2', 'active'),
      item('1X3', 'active'),
      item('1X4', 'done'),
    ];

    expect(stateGroupReorderRange(rows, rows[2]?.itemId ?? '')).toEqual({
      first: 0,
      last: 1,
    });
    expect(stateGroupDropIndex(rows, rows[2]?.itemId ?? '', 0)).toBe(1);
  });

  it('renders populated groups in intrinsic state order and hides empty groups', () => {
    render(
      <ThemeProvider scheme="light">
        <StateSections
          list={list}
          items={[item('1X5', 'active'), item('1X3', 'open')]}
          onOpen={vi.fn()}
          onDrop={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reading').length).toBeGreaterThan(0);
    expect(screen.queryByText('Read')).toBeNull();
    expect(screen.getByTestId('stage-heading-open').textContent).toContain('Saved');
    expect(screen.getByTestId('stage-heading-open').textContent).toContain('1');
    expect(screen.getByTestId('stage-heading-open-icon')).toBeTruthy();
    expect(screen.getByTestId('stage-heading-active').textContent).toContain('Reading');
    expect(
      screen
        .getByTestId('list-state-open')
        .compareDocumentPosition(screen.getByTestId('list-state-active')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
