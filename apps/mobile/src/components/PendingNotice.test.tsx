import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PendingNotice } from './PendingNotice';

const renderIn = (node: React.ReactNode) =>
  render(<ThemeProvider scheme="light">{node}</ThemeProvider>);

describe('PendingNotice', () => {
  it('announces the explanation rather than relying on styling', () => {
    const message = 'Waiting to sync — you can cancel it.';
    renderIn(<PendingNotice message={message} onCancel={() => undefined} />);

    const notice = screen.getByTestId('pending-notice');
    /**
     * §6.4: a disabled control is never the only signal. The words carry the meaning, they
     * are announced when they appear, and they are reachable as one element — none of which
     * a colour or an opacity can do.
     */
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.getAttribute('aria-label')).toBe(message);
    expect(notice.textContent).toContain(message);
  });

  it('offers cancel only when one is given, so in flight shows none', () => {
    renderIn(
      <PendingNotice message="Syncing now — everything else unlocks once it’s synced." />,
    );

    // No cancel: a request already on the wire cannot be retracted.
    expect(screen.queryByTestId('pending-cancel')).toBeNull();
    expect(screen.getByTestId('pending-notice').textContent).toContain('Syncing now');
  });

  it('takes its copy as a parameter, so later phases are not second systems', () => {
    renderIn(<PendingNotice message="Plan will finish syncing." />);

    expect(screen.getByTestId('pending-notice').textContent).toContain(
      'Plan will finish syncing.',
    );
  });

  it('invokes cancel when the offered control is used', () => {
    const onCancel = vi.fn();
    renderIn(<PendingNotice message="Waiting to sync." onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId('pending-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
