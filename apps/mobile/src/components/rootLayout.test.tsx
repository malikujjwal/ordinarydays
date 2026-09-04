import type { PropsWithChildren } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RootLayout from '../../app/_layout';

// Keep the real root layout while isolating startup services and native providers.
vi.mock('@od/ui', () => ({
  ThemeProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@tanstack/react-query', () => ({
  QueryClientProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock('expo-router', () => ({ Stack: () => null }));
vi.mock('expo-router/head', () => ({
  default: ({ children }: PropsWithChildren) => {
    // Native Expo Head requires a Handoff origin; this app only needs a web title.
    if (Platform.OS !== 'web') throw new Error('Expo Head: missing handoff origin');
    return children;
  },
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: PropsWithChildren) => children,
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@/components/HydrationGate', () => ({
  HydrationGate: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@/features/reminders/localSchedule', () => ({
  installLocalReminderScheduler: vi.fn(),
}));
vi.mock('@/features/shell/components/SyncStatusBanner', () => ({
  SyncStatusBanner: () => null,
}));
vi.mock('@/hooks/useClock', () => ({
  ClockProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@/lib/fonts', () => ({ useSerifFamily: () => undefined }));
vi.mock('@/lib/onlineManager', () => ({ installOnlineManager: vi.fn() }));
vi.mock('@/lib/queryClient', () => ({ queryClient: {} }));

const originalPlatform = Platform.OS;
afterEach(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

describe('root document metadata', () => {
  it('preserves the accessible document title on web', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web' });
    expect(renderToStaticMarkup(<RootLayout />)).toContain(
      '<title>Ordinary Days</title>',
    );
  });

  it.each(['ios', 'android'])('does not require a Handoff origin on %s', (platform) => {
    Object.defineProperty(Platform, 'OS', { value: platform });
    expect(() => renderToStaticMarkup(<RootLayout />)).not.toThrow();
  });
});
