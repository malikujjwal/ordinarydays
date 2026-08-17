import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme/index';
import { type } from '../theme/tokens';
import { SelectField } from './SelectField';

const options = [
  { value: 'never', label: 'Never' },
  { value: 'daily', label: 'Daily' },
] as const;

describe('SelectField', () => {
  it('renders a labelled native select and returns the chosen value', () => {
    const onChange = vi.fn();
    render(
      <ThemeProvider>
        <SelectField
          label="Repeat"
          value="never"
          options={options}
          onChange={onChange}
          testID="repeat-select"
        />
      </ThemeProvider>,
    );

    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'daily' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('daily');
    /**
     * Read off the token rather than restated: the point of the assertion is that the native
     * `<select>` carries the `body` line height at all — a bare `22px` re-encoded the scale here
     * and failed the moment §3 moved to 16/21.
     */
    expect((screen.getByLabelText('Repeat') as HTMLSelectElement).style.lineHeight).toBe(
      `${type.body.lineHeight}px`,
    );
  });

  it('announces errors and disables the control', () => {
    render(
      <ThemeProvider>
        <SelectField
          label="Ends"
          value="never"
          options={options}
          onChange={() => {}}
          disabled
          error="Choose an ending."
        />
      </ThemeProvider>,
    );

    expect((screen.getByLabelText('Ends') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Choose an ending.');
  });
});
