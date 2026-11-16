import { randomBytes } from 'node:crypto';

/** A random 32-byte key for the version HMAC of a test run (`VERSION_HMAC_KEY`), as the server reads it from the configuration and decoded. */
export const TEST_VERSION_KEY_TEXT: string = randomBytes(32).toString('base64'); // gitleaks:allow (fake test value)
export const TEST_VERSION_KEY: Buffer = Buffer.from(TEST_VERSION_KEY_TEXT, 'base64');
