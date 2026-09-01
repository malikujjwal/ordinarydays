import { describe, expect, it } from 'vitest';
import { type RsvpSummaryGroups, rsvpSummaryLine } from './rsvpSummary';

/** The five §1.3.1 cases the phase task names, plus the group grammar around them. */

const groups = (patch: Partial<RsvpSummaryGroups> = {}): RsvpSummaryGroups => ({
  interested: { count: 0, names: [] },
  maybe: { count: 0, names: [] },
  pass: { count: 0, names: [] },
  pending: { count: 0, names: [] },
  ...patch,
});

describe('rsvpSummaryLine', () => {
  it('renders Just you with no participants — every Phase 3 row', () => {
    expect(rsvpSummaryLine(groups())).toBe('Just you');
  });

  it('names one or two people in full', () => {
    expect(rsvpSummaryLine(groups({ interested: { count: 1, names: ['Alice'] } }))).toBe(
      'Alice interested',
    );
    expect(
      rsvpSummaryLine(groups({ interested: { count: 2, names: ['Alice', 'Ben'] } })),
    ).toBe('Alice and Ben interested');
  });

  it('collapses three or more to a first name and a count', () => {
    expect(
      rsvpSummaryLine(groups({ interested: { count: 3, names: ['Alice', 'Ben'] } })),
    ).toBe('Alice and 2 others interested');
  });

  it('collapses to Nobody has replied when only the no-reply group is populated', () => {
    expect(rsvpSummaryLine(groups({ pending: { count: 3, names: ['Ben'] } }))).toBe(
      'Nobody has replied',
    );
  });

  it('joins the mixed case by interpunct in the fixed order', () => {
    expect(
      rsvpSummaryLine(
        groups({
          interested: { count: 3, names: ['Alice', 'Ben'] },
          maybe: { count: 1, names: ['Cara'] },
          pending: { count: 1, names: ['Dev'] },
        }),
      ),
    ).toBe("Alice and 2 others interested · Cara maybe · Dev hasn't replied");
  });

  it('names the no-reply group by count beyond one person', () => {
    expect(
      rsvpSummaryLine(
        groups({
          interested: { count: 1, names: ['Alice'] },
          pending: { count: 2, names: ['Ben', 'Cara'] },
        }),
      ),
    ).toBe("Alice interested · 2 haven't replied");
  });

  it('omits empty groups rather than rendering 0 maybe', () => {
    expect(
      rsvpSummaryLine(
        groups({
          interested: { count: 1, names: ['Alice'] },
          pass: { count: 1, names: ['Ben'] },
        }),
      ),
    ).toBe('Alice interested · Ben passed');
  });
});
