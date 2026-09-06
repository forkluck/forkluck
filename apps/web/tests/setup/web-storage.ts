// One storage on every Node: 26 shadows jsdom's with an undefined global, and
// jsdom's own cannot be spied on (assigning a method stores an item instead).
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  }
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: memoryStorage() })
  Object.defineProperty(window, "sessionStorage", { value: memoryStorage() })
}
