/** A logger for tests that do not care about the validator warning of `ensureIndexes`. */
export const quietLogger = { error: (): void => undefined };
