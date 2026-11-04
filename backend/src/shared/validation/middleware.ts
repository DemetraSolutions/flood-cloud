import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../http/errors.ts';
import { validate } from './schema.ts';
import type { Schema } from './schema.ts';

/** The parts of a request that can be validated. */
export type InputPart = 'body' | 'query' | 'params';

/** Validated, converted parts of the current request, stored in `res.locals.input`. */
export type ValidatedInput = Partial<Record<InputPart, unknown>>;

/** Label of the root of each part in the `field` of an error. */
const ROOT_LABEL: Readonly<Record<InputPart, string>> = { body: '(body)', query: '(query)', params: '(params)' };

/** Builds the middleware of one part: validates it and stores the converted value. */
function validatePart<S extends Schema<unknown>>(part: InputPart, schema: S, read: (req: Request) => unknown): RequestHandler {
  return (req, res, next) => {
    const raw = read(req);
    if (raw === undefined) {
      // `req.body` is undefined when no body parser ran or the request had no body.
      throw new AppError('VALIDATION_ERROR', { details: [{ field: ROOT_LABEL[part], issue: 'required' }] });
    }
    res.locals.input = { ...res.locals.input, [part]: validate(schema, raw, ROOT_LABEL[part]) };
    next();
  };
}

/**
 * Middleware validating `req.body`. A missing body is a `422` with `field: '(body)'` and
 * `issue: 'required'`. The converted value is read with `inputOf<Infer<typeof schema>>(res, 'body')`.
 *
 * @param schema Schema of the body.
 * @throws {AppError} `VALIDATION_ERROR` (through Express), with a detail for every problem.
 */
export function validateBody<S extends Schema<unknown>>(schema: S): RequestHandler {
  return validatePart('body', schema, (req) => req.body as unknown);
}

/**
 * Middleware validating `req.query` (read only: the converted value goes to `res.locals.input`).
 *
 * @param schema Schema of the query string; query values are strings or arrays of strings.
 */
export function validateQuery<S extends Schema<unknown>>(schema: S): RequestHandler {
  return validatePart('query', schema, (req) => req.query);
}

/**
 * Middleware validating `req.params`.
 *
 * @param schema Schema of the path parameters.
 */
export function validateParams<S extends Schema<unknown>>(schema: S): RequestHandler {
  return validatePart('params', schema, (req) => req.params);
}

/**
 * Reads the validated value of a request part. Controllers use this and never the raw request.
 *
 * @param res The response of the current request.
 * @param part Which part to read.
 * @returns The converted value, typed as `T` (use `Infer<typeof schema>`).
 * @throws {Error} If the route did not validate that part (a programming error, never client-induced).
 */
export function inputOf<T = unknown>(res: Response, part: InputPart): T {
  const input = res.locals.input;
  if (input === undefined || !(part in input)) {
    throw new Error(`The route did not validate the ${part}`);
  }
  return input[part] as T;
}
