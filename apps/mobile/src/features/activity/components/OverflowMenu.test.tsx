import type { Activity } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OverflowMenu } from './OverflowMenu';

const task = { objectKind: 'task' } as Activity;

describe('Activity More menu layout', () => {
  it('uses the same compact ruled action rows as the List page', () => {
    render(
      <ThemeProvider scheme="light">
        <OverflowMenu
          open
          onClose={vi.fn()}
          activity={task}
          onChangePlanKind={vi.fn()}
          onChangeObject={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />
      </ThemeProvider>,
    );

    for (const testID of [
      'overflow-change-object',
      'overflow-duplicate',
      'overflow-delete',
    ]) {
      const row = screen.getByTestId(testID);
      expect(row.style.minHeight).toBe('56px');
      expect(row.style.borderBottomWidth).toBe('1px');
    }
    expect(screen.getByTestId('overflow-delete').style.marginTop).toBe('8px');
  });
});
