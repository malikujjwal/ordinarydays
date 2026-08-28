// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme/index';
import { SettingRow } from './SettingRow';

describe('SettingRow switch treatment', () => {
  it('exposes one 44-point switch target with checked state', () => {
    const onPress = vi.fn();
    render(
      <ThemeProvider initialScheme="dark">
        <SettingRow
          label="Progress"
          summary="One optional line on each item"
          switchValue
          onPress={onPress}
        />
      </ThemeProvider>,
    );

    const control = screen.getByRole('switch', { name: /Progress/ });
    expect(control.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(control);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('reports unchecked and disabled state without removing the control', () => {
    render(
      <ThemeProvider initialScheme="light">
        <SettingRow label="Places" switchValue={false} disabled onPress={() => {}} />
      </ThemeProvider>,
    );
    const control = screen.getByRole('switch', { name: 'Places' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.getAttribute('aria-disabled')).toBe('true');
  });
});
