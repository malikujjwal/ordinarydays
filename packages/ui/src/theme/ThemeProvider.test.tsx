import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeProvider';

vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => 'dark' as const,
}));

function SchemeProbe() {
  const theme = useTheme();
  return <span>{theme.scheme}</span>;
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  vi.restoreAllMocks();
});

describe('ThemeProvider web hydration', () => {
  it('hydrates the light server snapshot before adopting the dark system scheme', async () => {
    const markup = renderToString(
      <ThemeProvider>
        <SchemeProbe />
      </ThemeProvider>,
    );
    expect(markup).toContain('light');

    const container = document.createElement('div');
    container.innerHTML = markup;
    document.body.append(container);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const root = hydrateRoot(
      container,
      <ThemeProvider>
        <SchemeProbe />
      </ThemeProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toBe('dark');
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });
});
