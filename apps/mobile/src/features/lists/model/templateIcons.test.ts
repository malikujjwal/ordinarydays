import { listTemplateChoices } from '@od/shared/lists';
import { templateIcons } from '@od/ui';
import { describe, expect, it } from 'vitest';

/**
 * **Every template's icon resolves to a real glyph** (P3-46).
 *
 * This is the assertion that would have caught the gap at P3-02, which shipped a catalogue
 * naming fifteen icons when four existed. Nothing failed for three phases because no screen
 * rendered a list card; P3-25 is the first, and it would have failed on eleven of the
 * seventeen entries — as eleven blank squares in the style chooser, which is the shape of bug
 * that gets shrugged at rather than diagnosed.
 *
 * ## Why it lives here
 *
 * It needs both packages, and only `apps/mobile` can see both. `packages/shared` is a leaf
 * and may not reach `@od/ui`; `packages/ui` is a stricter leaf still and may not reach any
 * workspace package (`repo-structure.md` §2.2), which is exactly why `templateIcons` is keyed
 * by plain strings rather than by the catalogue's own type. The two halves of that contract
 * can only be pinned together from a package that depends on both.
 *
 * ## Why `listTemplateChoices()` rather than the catalogue itself
 *
 * `apps/` may not name `LIST_TEMPLATES` — the catalogue is creation-time data a list must
 * never render from (ADR-032), and `check-forbidden.mjs` fails the build on the identifier.
 * The projection is the array the creation sheet actually renders, and it is **total**: every
 * catalogue record, exactly once, in catalogue order. So asserting over it asserts over every
 * catalogue icon, and it does so through the surface this app is allowed to hold.
 */

const choices = listTemplateChoices();

describe('the template catalogue and the icon registry agree', () => {
  it('projects every catalogue entry, so this assertion covers all of them', () => {
    expect(choices).toHaveLength(17);
    expect(new Set(choices.map((choice) => choice.templateKey)).size).toBe(
      choices.length,
    );
  });

  it.each(choices.map((choice) => [choice.templateKey, choice.icon] as const))(
    '%s names the icon %s, and it is a component',
    (_templateKey, icon) => {
      const glyph = (templateIcons as Record<string, unknown>)[icon];
      expect(glyph, `no glyph exported for the icon "${icon}"`).toBeDefined();
      expect(typeof glyph).toBe('function');
    },
  );

  /**
   * The other direction, and the reason it is worth asserting: a glyph in the map that no
   * template names is a shape nobody agreed on — the registry's own header calls that out —
   * and it is how the map slowly becomes a second, wrong catalogue.
   */
  it('exports no template glyph that no template uses', () => {
    const used = new Set(choices.map((choice) => choice.icon));
    const unused = Object.keys(templateIcons).filter((icon) => !used.has(icon));

    expect(unused).toEqual([]);
  });

  /**
   * Guards the guard. Both assertions above iterate a list, and a list that came back empty
   * would make them pass while proving nothing — the failure mode this whole test exists to
   * have caught three phases ago.
   */
  it('has icons to check', () => {
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.every((choice) => choice.icon.length > 0)).toBe(true);
  });
});
