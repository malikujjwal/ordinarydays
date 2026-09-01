import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PrepSection } from './PrepSection';

describe('PrepSection optimistic completion', () => {
  it('absorbs a rejecting action and restores the exact checkbox projection', async () => {
    let reject!: (cause: unknown) => void;
    const response = new Promise<boolean>((_resolve, onReject) => {
      reject = onReject;
    });
    const onToggleChild = vi.fn(() => response);
    render(
      <ThemeProvider scheme="light">
        <PrepSection
          prepTasks={[
            {
              activityId: 'act_01J0000000000000000000000A',
              title: 'Pack a bag',
              status: 'saved',
              restoredStatus: 'saved',
              isRecurring: false,
            },
          ]}
          onOpenChild={() => undefined}
          onToggleChild={onToggleChild}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Pack a bag, not completed' }));
    expect(
      screen.queryByRole('checkbox', { name: 'Pack a bag, not completed' }),
    ).toBeNull();

    reject(new Error('storage detail that must not escape'));
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'Pack a bag, not completed' }),
      ).toBeDefined(),
    );
    expect(onToggleChild).toHaveBeenCalledTimes(1);
  });
});
