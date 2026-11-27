/**
 * What the operator commands (`shadow:report`, `ops:inflight`) share: configuration, a connected MongoDB client and
 * an output that never carries a secret. The commands only read.
 *
 * @module
 */
import type { MongoClient } from 'mongodb';
import { loadConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { connectAndPing, createMongoClient } from '../db/client.ts';
import { describeError } from '../engine/context.ts';
import { commonDatabaseName, queueDatabaseName } from '../db/names.ts';

/** Longest any query of an operator command may run on the server, in milliseconds (they scan collections the worker never indexes). */
export const TOOL_MAX_TIME_MS = 60_000;

/** The parts of the Node `process` the commands use (replaceable in tests). */
export interface ToolProcess {
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

/** Collaborators the tests replace. */
export interface ToolDeps {
  /** Builds the MongoDB client ({@link createMongoClient} by default). */
  readonly createClient?: typeof createMongoClient;
  /** The clock (`Date.now` by default). */
  readonly clock?: () => number;
}

/** A configured, connected command. */
export interface ToolContext {
  readonly config: Config;
  readonly client: MongoClient;
  /** Name of the common database. */
  readonly commonDatabase: string;
  /** Name of the queue database. */
  readonly queueDatabase: string;
  close(): Promise<void>;
}

/**
 * Loads the configuration and connects. The commands read only: they need neither credentials nor a hub, so the
 * configuration is loaded as for the shadow mode, and the instance id defaults to `tool`.
 *
 * @param proc The process.
 * @param deps Replaceable collaborators.
 * @returns The context, or `undefined` after the problem (variable and reason, never a value) was written to stderr.
 */
export async function openToolContext(proc: ToolProcess, deps: ToolDeps = {}): Promise<ToolContext | undefined> {
  const instance = proc.env['WORKER_INSTANCE_ID'];
  const result = loadConfig({ ...proc.env, WORKER_MODE: 'shadow', WORKER_INSTANCE_ID: instance === undefined || instance === '' ? 'tool' : instance });
  if (!result.ok) {
    proc.stderr.write(`invalid configuration:\n${result.issues.map((entry) => `  ${entry.variable} ${entry.reason}`).join('\n')}\n`);
    return undefined;
  }
  const { config } = result;
  let client: MongoClient;
  try {
    client = (deps.createClient ?? createMongoClient)(config);
    await connectAndPing(client);
  } catch (error) {
    proc.stderr.write(`MongoDB is not available (${describeError(error).errorName})\n`);
    return undefined;
  }
  const names = { prefix: config.dbNamePrefix, appEnv: config.appEnv };
  return { config, client, commonDatabase: commonDatabaseName(names), queueDatabase: queueDatabaseName(names), close: () => client.close() };
}
