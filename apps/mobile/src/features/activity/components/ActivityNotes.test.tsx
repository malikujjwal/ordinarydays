import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useNotesDraft } from '../hooks/useNotesDraft';
import { ActivityNotes } from './ActivityNotes';

it('keeps long pending notes available to read without enabling an unacknowledged edit', () => {
  const value = 'A long offline note. '.repeat(70);
  const persist = vi.fn();
  const { result } = renderHook(() => useNotesDraft(value, persist));
  render(
    <ThemeProvider scheme="light">
      <ActivityNotes notes={result.current} value={value} kind="plan" pending />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show notes' }));
  expect(screen.getByRole('button', { name: 'Show less' })).toBeDefined();
  expect(screen.getByTestId('notes-preview').textContent).toBe(value);
  expect(screen.queryByRole('button', { name: 'Edit notes' })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(persist).not.toHaveBeenCalled();
});

/** 2026-09-10: empty notes are one compact line, not a heading over `No notes yet.` */
it('renders empty notes as one line with Add notes and no heading', () => {
  const { result } = renderHook(() => useNotesDraft('', vi.fn()));
  render(
    <ThemeProvider scheme="light">
      <ActivityNotes notes={result.current} value="" kind="task" pending={false} />
    </ThemeProvider>,
  );
  expect(screen.getByTestId('notes-preview').textContent).toBe('No notes');
  expect(screen.queryByRole('heading', { name: 'Notes' })).toBeNull();
  expect(screen.queryByText('No notes yet.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Add notes' })).toBeDefined();
});

it('offers no action on empty pending notes', () => {
  const { result } = renderHook(() => useNotesDraft('', vi.fn()));
  render(
    <ThemeProvider scheme="light">
      <ActivityNotes notes={result.current} value="" kind="plan" pending />
    </ThemeProvider>,
  );
  expect(screen.getByText('No notes')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});

it('renders written notes under a Notes heading with a trailing Edit', () => {
  const { result } = renderHook(() => useNotesDraft('Bring limes.', vi.fn()));
  const view = render(
    <ThemeProvider scheme="light">
      <ActivityNotes
        notes={result.current}
        value="Bring limes."
        kind="plan"
        pending={false}
        privacyNote="Private to you."
      />
    </ThemeProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Notes' })).toBeDefined();
  const edit = screen.getByRole('button', { name: 'Edit notes' });
  expect(edit.textContent).toBe('Edit');
  expect(screen.getByTestId('notes-preview').textContent).toBe('Bring limes.');
  expect(screen.getByTestId('notes-privacy').textContent).toBe('Private to you.');

  act(() => fireEvent.click(edit));
  view.rerender(
    <ThemeProvider scheme="light">
      <ActivityNotes
        notes={result.current}
        value="Bring limes."
        kind="plan"
        pending={false}
        privacyNote="Private to you."
      />
    </ThemeProvider>,
  );
  expect((screen.getByLabelText('Notes for this plan') as HTMLInputElement).value).toBe(
    'Bring limes.',
  );
  // The privacy note stays with the editor.
  expect(screen.getByTestId('notes-privacy').textContent).toBe('Private to you.');
});
