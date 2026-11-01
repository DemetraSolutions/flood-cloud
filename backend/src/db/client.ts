import { MongoClient } from 'mongodb';
import type { AppEnv, Config } from '../config.ts';

/** The configuration fields {@link createMongoClient} reads. */
export type MongoClientConfig = Pick<Config, 'mongodbUri' | 'mongodbServerSelectionTimeoutMs' | 'mongodbMaxPoolSize'> & {
  /** When `production`, the built client is verified to use TLS with full certificate checks. */
  readonly appEnv?: AppEnv;
};

/** Application name reported to the server, visible in logs and `currentOp`. */
export const MONGO_APP_NAME = 'flood-cloud-backend';

/** Optional behaviour of {@link createMongoClient}. */
export interface MongoClientOptions {
  /** Read preference; `primary` unless a read-only tool asks for `secondaryPreferred`. */
  readonly readPreference?: 'primary' | 'secondaryPreferred';
}

/**
 * Creates the process-wide MongoDB client. It does not connect: the caller awaits `connect()`.
 * There must be exactly one client per process, created at startup and never per request.
 *
 * @param config Connection string and pool/timeout settings from the validated configuration.
 * @param options Optional read preference (read-only tools use `secondaryPreferred`).
 * @returns A configured, not yet connected client.
 * @throws {Error} If the connection string cannot be parsed (the driver error never echoes credentials),
 * or, in production, if the resulting client does not use TLS with certificate and hostname checks.
 * @example
 * const client = createMongoClient(config);
 * await client.connect();
 */
export function createMongoClient(config: MongoClientConfig, options: MongoClientOptions = {}): MongoClient {
  const client = new MongoClient(config.mongodbUri.reveal(), {
    appName: MONGO_APP_NAME,
    retryWrites: true,
    writeConcern: { w: 'majority' },
    readPreference: options.readPreference ?? 'primary',
    serverSelectionTimeoutMS: config.mongodbServerSelectionTimeoutMs,
    connectTimeoutMS: config.mongodbServerSelectionTimeoutMs,
    maxPoolSize: config.mongodbMaxPoolSize,
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
