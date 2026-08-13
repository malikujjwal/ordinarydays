import { describe, expect, it } from 'vitest';
import { GLOBAL_ADD_SIZE } from '@/components/globalAddLayout';
import { ADD_LABEL, tabs } from './tabs';

/**
 * The three nouns (P1-23).
 *
 * A pure-module test rather than a render test on the navigator, because what is worth
 * protecting is the *set* — Today · Plans · Lists, in that order, and no fourth. A fourth tab
 * is a product decision the founder makes (`agent-playbook.md` §10 trigger 8), so a diff that
 * adds one should fail a test that says so out loud rather than quietly render a wider bar.
 */

describe('the tab bar', () => {
  it('has exactly three tabs', () => {
    expect(tabs).toHaveLength(3);
  });

  it('labels them Today, Plans, Lists, in that order', () => {
    expect(tabs.map((t) => t.label)).toEqual(['Today', 'Plans', 'Lists']);
  });

  /** Today is `index`, so the app opens at `/` with no redirect. */
  it('puts Today at the root route', () => {
    expect(tabs[0]).toEqual({ name: 'index', label: 'Today', path: '/' });
  });

  it('gives Plans and Lists real web paths', () => {
    expect(tabs.map((t) => t.path)).toEqual(['/', '/plans', '/lists']);
  });

  it('is frozen, so a screen cannot add one at runtime', () => {
    expect(Object.isFrozen(tabs)).toBe(true);
  });
});

describe('the global Add control', () => {
  /**
   * `Add`, not `Add task`. The control opens a chooser and commits to nothing; a label
   * naming an object would be the first place the product implied a default.
   */
  it('is labelled Add', () => {
    expect(ADD_LABEL).toBe('Add');
  });

  /** 56 × 56 pt, from `interaction-contract.md` §2's controls table. */
  it('is 56 pt, comfortably over the 44 pt minimum', () => {
    expect(GLOBAL_ADD_SIZE).toBe(56);
  });
});
