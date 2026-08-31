import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListIndexMenu } from './ListIndexMenu';

function mount(showingArchived: boolean, archivedCount: number) {
  const onToggleArchived = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <ListIndexMenu
        open
        onClose={() => {}}
        showingArchived={showingArchived}
        archivedCount={archivedCount}
        onToggleArchived={onToggleArchived}
      />
    </ThemeProvider>,
  );
  return onToggleArchived;
}

describe('Lists index More menu', () => {
  it('renders the filter as one full-width row with its count summary and checked state', () => {
    const toggle = mount(true, 2);
    const row = screen.getByRole('checkbox', {
      name: 'Hide archived, 2 archived lists. They keep their items and can be restored.',
    });

    expect(row.getAttribute('style')).toContain('min-height: 56px');
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText('2 archived lists. They keep their items and can be restored.'),
    ).toBeTruthy();
    fireEvent.click(row);
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('keeps the zero-count explanation inside the Show archived row', () => {
    mount(false, 0);
    const row = screen.getByRole('checkbox', {
      name: 'Show archived, Archived lists keep their items and can be restored.',
    });
    expect(row.getAttribute('aria-checked')).toBe('false');
  });
});
