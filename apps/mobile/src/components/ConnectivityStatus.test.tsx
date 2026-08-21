import { ThemeProvider } from '@od/ui';
import { onlineManager } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectivityStatus } from './ConnectivityStatus';

const renderIn = (node: React.ReactNode) =>
  render(<ThemeProvider scheme="light">{node}</ThemeProvider>);

beforeEach(() => {
  onlineManager.setOnline(true);
});

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe('ConnectivityStatus', () => {
  it('renders nothing during ordinary online use', () => {
    renderIn(<ConnectivityStatus />);
    expect(screen.queryByTestId('connectivity-status')).toBeNull();
  });

  it('shows Offline without claiming there are writes when the queue is empty', () => {
    onlineManager.setOnline(false);
    renderIn(<ConnectivityStatus />);

    expect(screen.getByTestId('connectivity-status').textContent).toBe('Offline');
  });
});
