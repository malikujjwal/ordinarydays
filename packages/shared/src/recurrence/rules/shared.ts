export interface RuleWindow {
  from: string;
  to: string;
  maxOccurrences: number;
  step(): void;
}

export function firstAlignedDate(
  anchor: string,
  from: string,
  intervalDays: number,
  differenceInDays: (later: string, earlier: string) => number,
  addDays: (value: string, amount: number) => string,
): string {
  const distance = differenceInDays(from, anchor);
  if (distance <= 0) return anchor;
  return addDays(anchor, Math.ceil(distance / intervalDays) * intervalDays);
}
