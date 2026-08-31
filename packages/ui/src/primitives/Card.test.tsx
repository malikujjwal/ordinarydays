import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Card } from './Card';

const forwarded = vi.hoisted(() => ({
  delayLongPress: undefined as number | undefined,
  onLongPress: undefined as (() => void) | undefined,
}));

vi.mock('./Touchable', async () => {
  const { createElement } = await import('react');
  return {
    Touchable: ({
      accessibilityLabel,
      children,
      delayLongPress,
      onLongPress,
    }: {
      accessibilityLabel?: string;
      children: ReactNode;
      delayLongPress?: number;
      onLongPress?: () => void;
    }) => {
      forwarded.delayLongPress = delayLongPress;
      forwarded.onLongPress = onLongPress;
      return createElement('button', { 'aria-label': accessibilityLabel }, children);
    },
  };
});

describe('Card gesture forwarding', () => {
  it('keeps a long press on the same named target as the primary action', () => {
    const onLongPress = vi.fn();
    render(
      <ThemeProvider scheme="light">
        <Card
          onPress={() => {}}
          onLongPress={onLongPress}
          delayLongPress={500}
          accessibilityLabel="Groceries actions"
        >
          Groceries
        </Card>
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Groceries actions' })).toBeTruthy();
    forwarded.onLongPress?.();
    expect(onLongPress).toHaveBeenCalledOnce();
    expect(forwarded.delayLongPress).toBe(500);
  });
});
