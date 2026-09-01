import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function productDoc(name: string): string {
  return readFileSync(
    new URL(`../../../../docs/01-product/${name}`, import.meta.url),
    'utf8',
  );
}

function implementationDoc(name: string): string {
  return readFileSync(
    new URL(`../../../../docs/03-implementation/${name}`, import.meta.url),
    'utf8',
  );
}

describe('P3-33 canonical product language', () => {
  it('keeps global routing and the one configurable List model in the overview', () => {
    const overview = productDoc('overview.md');
    expect(overview).toContain(
      'The global `+` opens exactly three choices: **Task**, **Plan**, and **Add list**.',
    );
    expect(overview).toContain('Lists have no stored purpose or behaviour enum.');
    expect(overview).not.toContain('List **behaviour** is the same shape');
    expect(overview).not.toContain('Task**, **Plan**, and **List item**');
  });

  it('routes Watch destinations by slot and one explicit Watch Later preset', () => {
    const activities = productDoc('activities.md');
    expect(activities).toContain('Destination resolves through the `watch` slot');
    expect(activities).toContain('single **Watch Later** creation preset');
    expect(activities).not.toContain(
      'Destination must be a list whose behaviour is `watch`',
    );
    expect(activities).not.toContain(
      'exactly **Watchlist / Movies to watch / TV shows**',
    );
  });

  it('pins the destination-labelled rapid-entry row in the List contract', () => {
    const plansAndLists = productDoc('plans-and-lists.md');
    const interactions = productDoc('interaction-contract.md');
    for (const document of [plansAndLists, interactions]) {
      expect(document).toContain('`Add item to <list name>`');
      expect(document).toContain('`Done adding`');
      expect(document).not.toContain(
        'Title and optional multiline Note end with `Add to <list name>`',
      );
    }
  });

  it('keeps the Phase 3 verification contract on the same rapid-entry interaction', () => {
    const phase = implementationDoc('phase-03-plans-and-lists.md');
    expect(phase).toContain('`Add item to <list name>`');
    expect(phase).toContain('`Done adding`');
    expect(phase).not.toContain('contextual inline\n   Title/Note creation');
  });
});
