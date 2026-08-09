import { render, screen } from '@testing-library/react';
import { Pressable, Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

/**
 * The environment is this task's deliverable, so this file tests the environment rather than
 * a component — `@od/ui` has no primitives yet, and building one here would be P1-22's work
 * done in the wrong pull request.
 *
 * It asserts the four things that have to be simultaneously true before a primitive test can
 * be written at all: `react-native` resolves, it renders under jsdom, accessibility
 * information survives the RNW translation into DOM, and interaction works. Each has its own
 * failure mode and each would otherwise be discovered by P1-22 as "the test runner is
 * broken".
 *
 * **P1-22 replaces this file** with real tests over `primitives/`. Keeping it after that
 * would be asserting React Native Web's behaviour rather than the product's.
 */
describe('the React Native test environment', () => {
  it('resolves react-native and renders it to the DOM under jsdom', () => {
    render(
      <View>
        <Text>Ordinary Days</Text>
      </View>,
    );

    expect(screen.getByText('Ordinary Days')).toBeDefined();
  });

  /**
   * The one that matters most. Every query in `testing.md` §5 is by **role and accessible
   * name**, so if `accessibilityRole` did not survive into the DOM, every component test in
   * Phases 1 to 9 would have to fall back to `getByTestId` — which §5 says should be
   * necessary nowhere.
   */
  it('carries accessibilityRole and the accessible name through to the DOM', () => {
    render(
      <View>
        <Text accessibilityRole="header">Today</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Add a task">
          <Text>+</Text>
        </Pressable>
      </View>,
    );

    expect(screen.getByRole('heading', { name: 'Today' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add a task' })).toBeDefined();
  });

  it('dispatches a press to the handler', () => {
    const onPress = vi.fn();
    render(
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save task"
        onPress={onPress}
      >
        <Text>Save task</Text>
      </Pressable>,
    );

    screen.getByRole('button', { name: 'Save task' }).click();

    expect(onPress).toHaveBeenCalledOnce();
  });

  it('does not fire a disabled control, so P1-22 can assert that on every primitive', () => {
    const onPress = vi.fn();
    render(
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save task"
        disabled
        onPress={onPress}
      >
        <Text>Save task</Text>
      </Pressable>,
    );

    screen.getByRole('button', { name: 'Save task' }).click();

    expect(onPress).not.toHaveBeenCalled();
  });
});
