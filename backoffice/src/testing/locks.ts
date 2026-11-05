/** In-memory stand-in for `navigator.locks` (jsdom has none), supporting `ifAvailable`. */
export interface FakeLocks {
  /** Names currently held. */
  readonly held: Set<string>;
  /** Makes a lock look held by another tab. */
  holdExternally(name: string): void;
  /** Removes the fake, restoring the absence of the API. */
  uninstall(): void;
}

export function installFakeLocks(options: { failRequests?: boolean } = {}): FakeLocks {
  const held = new Set<string>();
  const request = (
    name: string,
    a: LockOptions | LockGrantedCallback<unknown>,
    b?: LockGrantedCallback<unknown>,
  ): Promise<unknown> => {
    const callback = (typeof a === 'function' ? a : b) as LockGrantedCallback<unknown>;
    if (options.failRequests === true) {
      return Promise.reject(new Error('locks unavailable'));
    }
    if (held.has(name)) {
      return Promise.resolve(callback(null));
    }
    held.add(name);
    return Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)).finally(() =>
      held.delete(name),
    );
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return {
    held,
    holdExternally: (name) => held.add(name),
    uninstall: () => Reflect.deleteProperty(navigator, 'locks'),
  };
}
