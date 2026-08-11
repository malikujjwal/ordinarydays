/** Throws when an allegedly exhaustive branch receives an unknown runtime value. */
export function assertNever(
  value: never,
  label = 'value',
  errorFactory?: (renderedValue: string) => Error,
): never {
  const rendered = String(value);
  throw errorFactory?.(rendered) ?? new Error(`Unhandled ${label}: ${rendered}`);
}
