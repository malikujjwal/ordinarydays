import type { WallDate } from '@od/shared/time';
import { expect, it } from 'vitest';
import { mergeWindowProgress } from './plansWindowProgress';

it.each([
  ['overlap', '2026-09-01', '2026-11-01', '2026-11-02', '2026-11-02'],
  ['distant', '2027-09-01', '2027-09-30', null, '2026-10-07'],
  ['older', '2026-08-01', '2026-08-31', null, '2026-10-07'],
  ['terminal', '2026-10-07', '2026-12-07', null, null],
])(
  '%s window preserves or advances contiguous progress',
  (_name, from, through, nextFrom, expected) => {
    const result = mergeWindowProgress(
      {
        from: '2026-08-06' as WallDate,
        through: '2026-10-06' as WallDate,
        nextFrom: '2026-10-07' as WallDate,
      },
      {
        from: from as WallDate,
        through: through as WallDate,
        nextFrom: nextFrom as WallDate | null,
      },
    );
    expect(result.nextFrom).toBe(expected);
    expect(result.from).toBe('2026-08-06');
  },
);
