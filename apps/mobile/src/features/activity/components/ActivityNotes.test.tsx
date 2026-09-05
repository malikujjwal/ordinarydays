import { ThemeProvider } from '@od/ui';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
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
