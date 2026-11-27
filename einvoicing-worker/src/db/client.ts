import { MongoClient } from 'mongodb';
import type { AppEnv } from '../config.ts';
import type { Secret } from '../secret.ts';

/** The configuration fields {@link createMongoClient} reads. */
export interface MongoClientConfig {
  /** Connection string, a secret. */
  readonly mongodbUri: Secret;
  /** When `production`, the built client is verified to use TLS with full certificate checks. */
  readonly appEnv: AppEnv;
}

/** Application name reported to the server, visible in logs and `currentOp`. */
export const MONGO_APP_NAME = 'flood-cloud-einvoicing-worker';

/** Server selection and connect timeout in milliseconds. */
export const MONGO_TIMEOUT_MS = 5_000;

/**
 * Creates the process-wide MongoDB client. It does not connect: the caller awaits {@link connectAndPing}.
 *
 * @param config Connection string and environment from the validated configuration.
 * @returns A configured, not yet connected client.
 * @throws {Error} If the connection string cannot be parsed (the driver error never echoes credentials),
 * or, in production, if the client does not use TLS with certificate and hostname checks.
 */
export function createMongoClient(config: MongoClientConfig): MongoClient {
  const client = new MongoClient(config.mongodbUri.reveal(), {
    appName: MONGO_APP_NAME,
    retryWrites: true,
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
    serverSelectionTimeoutMS: MONGO_TIMEOUT_MS,
    connectTimeoutMS: MONGO_TIMEOUT_MS,
    maxPoolSize: 5,
  });
  if (config.appEnv === 'production' && !hasStrictTls(client)) {
    throw new Error('MongoDB client is not configured for TLS with full certificate and hostname verification');
  }
  return client;
}

/** Whether the resolved options enable TLS and leave certificate and hostname verification on. */
function hasStrictTls(client: MongoClient): boolean {
  const { tls, tlsInsecure, rejectUnauthorized, checkServerIdentity } = client.options as {
    tls?: boolean;
    tlsInsecure?: boolean;
    rejectUnauthorized?: boolean;
    checkServerIdentity?: unknown;
  };
  return tls === true && tlsInsecure !== true && rejectUnauthorized !== false && checkServerIdentity === undefined;
}

/**
 * Connects the client and checks that the server answers a `ping`.
 *
 * @param client A client from {@link createMongoClient}.
 * @throws {Error} If the server cannot be reached within {@link MONGO_TIMEOUT_MS}.
 */
export async function connectAndPing(client: MongoClient): Promise<void> {
  await client.connect();
  await client.db('admin').command({ ping: 1 });
}
