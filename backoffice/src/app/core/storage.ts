/**
 * Reads a value from `localStorage`. Storage can be unavailable (private mode, blocked data),
 * so failures are logged and reported as an absent value.
 *
 * @param key Storage key.
 * @returns The stored value, or `null` when absent or unreadable.
 */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn(`Cannot read "${key}" from localStorage`, error);
    return null;
  }
}

/**
 * Writes a value to `localStorage`; failures are logged, never silent and never fatal.
 *
 * @param key Storage key.
 * @param value Value to store.
 */
export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`Cannot write "${key}" to localStorage`, error);
  }
}
