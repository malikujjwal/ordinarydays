import { expect, it } from 'vitest';
import { calendarListWindow } from './calendarListWindow';

const sections = [
  { month: '2026-12', data: ['Dec 29', 'Dec 30', 'Dec 31'] },
  { month: '2027-01', data: ['Jan 1', 'Jan 2', 'Jan 3'] },
];

it('keeps the visible month identity when an earlier month is restored', () => {
  const target = { sectionIndex: 1, itemIndex: 1 };
  expect(calendarListWindow(sections, target, 1)[0]).toMatchObject({ key: '2027-01' });
  expect(calendarListWindow(sections, target, 4)[1]).toMatchObject({ key: '2027-01' });
});

it.each([
  {
    target: { sectionIndex: 1, itemIndex: 1 },
    preceding: 1,
    expected: [{ month: '2027-01', data: ['Jan 1', 'Jan 2', 'Jan 3'] }],
  },
  {
    target: { sectionIndex: 1, itemIndex: 0 },
    preceding: 1,
    expected: [
      { month: '2026-12', data: ['Dec 31'] },
      { month: '2027-01', data: ['Jan 1', 'Jan 2', 'Jan 3'] },
    ],
  },
  { target: { sectionIndex: 1, itemIndex: 0 }, preceding: 11, expected: sections },
])(
  'keeps the selected row and restores preceding rows across a year boundary ($preceding)',
  ({ target, preceding, expected }) => {
    expect(calendarListWindow(sections, target, preceding)).toMatchObject(expected);
    expect(sections[0]?.data).toEqual(['Dec 29', 'Dec 30', 'Dec 31']);
  },
);
