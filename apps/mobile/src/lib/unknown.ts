/**
 * Safe property access over values still typed `unknown` — persisted envelopes, durable
 * intent variables, and error shapes read back from storage or the network. Callers narrow
 * the result themselves; nothing here asserts a shape.
 */
export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

export function stringField(value: unknown, key: string): string | undefined {
  const candidate = field(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
}
