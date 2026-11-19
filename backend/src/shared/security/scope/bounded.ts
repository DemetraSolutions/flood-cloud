import { MongoServerError } from 'mongodb';
import { AppError } from '../../http/errors.ts';

/** MongoDB's `MaxTimeMSExpired` error code. */
export const MAX_TIME_EXPIRED = 50;

/**
 * Runs a read, answering `503` when it exceeds its time limit: the answer is unknown, never an empty one.
 *
 * @param read The read.
 * @returns What the read returns.
 * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit; any other failure is rethrown unchanged.
 */
export async function bounded<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw error instanceof MongoServerError && error.code === MAX_TIME_EXPIRED ? new AppError('SERVICE_UNAVAILABLE') : error;
  }
}
