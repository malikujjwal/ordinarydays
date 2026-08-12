const values = new Map<string, string>();

const asyncStorage = {
  getItem: async (key: string) => values.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: async (key: string) => {
    values.delete(key);
  },
  clear: async () => {
    values.clear();
  },
  getAllKeys: async () => [...values.keys()],
  multiGet: async (keys: readonly string[]) =>
    keys.map((key) => [key, values.get(key) ?? null] as [string, string | null]),
  multiSet: async (entries: readonly (readonly [string, string])[]) => {
    for (const [key, value] of entries) values.set(key, value);
  },
  multiRemove: async (keys: readonly string[]) => {
    for (const key of keys) values.delete(key);
  },
};

export default asyncStorage;
