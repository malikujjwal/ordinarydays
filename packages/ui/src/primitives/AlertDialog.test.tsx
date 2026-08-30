import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AlertDialog } from './AlertDialog';
import { Button } from './Button';

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <ThemeProvider scheme="light">
      <Button label="Open confirmation" onPress={() => setOpen(true)} />
      <AlertDialog
        open={open}
        label='Delete "Ideas"?'
        initialFocusTestID="safe-choice"
        onRequestClose={() => setOpen(false)}
        testID="alert"
      >
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => setOpen(false)}
          testID="safe-choice"
        />
        <Button label="Delete list" variant="danger" onPress={() => {}} />
      </AlertDialog>
    </ThemeProvider>
  );
}

describe('AlertDialog', () => {
  it('names the modal, focuses the safe choice, traps Tab and restores its trigger', async () => {
    render(<Fixture />);
    const trigger = screen.getByRole('button', { name: 'Open confirmation' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('alertdialog', { name: 'Delete "Ideas"?' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const destructive = screen.getByRole('button', { name: 'Delete list' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(cancel);

    destructive.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(destructive);

    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
