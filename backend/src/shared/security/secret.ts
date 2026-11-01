import { inspect } from 'node:util';

/** Placeholder printed in place of any secret value. */
export const REDACTED = '[REDACTED]';

/**
 * Wraps a sensitive string so that it cannot leak by accident into logs,
 * JSON serializations, template strings or `util.inspect` output.
 * The raw value is only reachable through {@link Secret.reveal}.
 *
 * @example
 * const uri = new Secret('mongodb://user:pass@host/db');
 * `${uri}`;            // '[REDACTED]'
 * JSON.stringify(uri); // '"[REDACTED]"'
 * uri.reveal();        // 'mongodb://user:pass@host/db'
 */
export class Secret {
  readonly #value: string;

  /**
   * @param value The raw sensitive value.
   */
  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  /**
   * Returns the raw value. Call it only at the exact point of use.
   *
   * @returns The wrapped string.
   */
  reveal(): string {
    return this.#value;
  }

  /**
   * @returns Always {@link REDACTED}.
   */
  toString(): string {
    return REDACTED;
  }

  /**
   * @returns Always {@link REDACTED}.
   */
  toJSON(): string {
    return REDACTED;
  }

  /**
   * Hook used by `util.inspect` and `console.log`.
   *
   * @returns Always {@link REDACTED}.
   */
  [inspect.custom](): string {
    return REDACTED;
  }
}
