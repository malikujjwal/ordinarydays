import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddToPlanRow } from './AddToPlanRow';

describe('AddToPlanRow', () => {
  it('renders a Task row with Details only', () => {
    const onPress = vi.fn();
    render(
      <ThemeProvider scheme="light">
        <AddToPlanRow
          label="Add to this task"
          objectKind="task"
          chips={[{ key: 'details', label: 'Details', onPress }]}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText('Add to this task')).toBeDefined();
    expect(screen.getByTestId('add-to-plan-details')).toBeDefined();
    expect(screen.queryByTestId('add-to-plan-prep-task')).toBeNull();
    expect(screen.queryByTestId('add-to-plan-list')).toBeNull();
    expect(screen.queryByTestId('add-to-plan-photo')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add details to this task' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there are no chips', () => {
    render(
      <ThemeProvider scheme="light">
        <AddToPlanRow chips={[]} />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('add-to-plan')).toBeNull();
  });
});
