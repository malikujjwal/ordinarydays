import { Text, ThemeProvider } from '@od/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ListCardGrid } from './ListCardGrid';

function mount(labels: readonly string[]) {
  render(
    <ThemeProvider scheme="light">
      <ListCardGrid>
        {labels.map((label) => (
          <Text key={label}>{label}</Text>
        ))}
      </ListCardGrid>
    </ThemeProvider>,
  );
}

describe('the full-width Lists stack', () => {
  it('keeps canonical source and accessibility order in one vertical column', () => {
    mount(['One', 'Two', 'Three', 'Four', 'Five']);

    const grid = screen.getByTestId('list-card-grid');
    expect(grid.textContent).toBe('OneTwoThreeFourFive');
    expect(getComputedStyle(grid).flexDirection).toBe('column');
    expect(screen.queryByTestId('list-card-column-0')).toBeNull();
    expect(screen.queryByTestId('list-card-column-1')).toBeNull();
  });

  it('lets row separators define the rhythm without card-grid gaps', () => {
    mount(['One', 'Two', 'Three', 'Four']);

    expect(getComputedStyle(screen.getByTestId('list-card-grid')).gap).toBe('0px');
  });
});
