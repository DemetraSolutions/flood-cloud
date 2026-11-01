import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../logging/logger.ts';
import { AppError, DEFAULT_MESSAGES } from './errors.ts';
import type { ErrorCode } from './errors.ts';

/** Maps the `type` of body-parser errors to API error codes. */
export const BODY_PARSER_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  'entity.parse.failed': 'MALFORMED_JSON',
  'entity.too.large': 'PAYLOAD_TOO_LARGE',
  'request.size.invalid': 'BAD_REQUEST',
  'charset.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
  'encoding.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
};

/** Maps the status of exposable client errors (http-errors) to API error codes; others become INTERNAL_ERROR. */
const CLIENT_STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

type Classification =
  | { readonly kind: 'known'; readonly error: AppError; readonly log: boolean }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unexpected' };

/** Decides how a thrown value must be answered. */
function classify(error: unknown): Classification {
  if (error instanceof AppError) {
    return { kind: 'known', error, log: false };
  }
  const { type, status, expose } = (error ?? {}) as { type?: unknown; status?: unknown; expose?: unknown };
  if (type === 'request.aborted') {
    return { kind: 'aborted' };
  }
  const parserCode = typeof type === 'string' ? BODY_PARSER_ERROR_CODES[type] : undefined;
  if (parserCode !== undefined) {
    return { kind: 'known', error: new AppError(parserCode), log: false };
  }
  if (error instanceof URIError) {
    return { kind: 'known', error: new AppError('BAD_REQUEST'), log: false };
  }
  if (typeof status === 'number' && status >= 400 && status < 500 && expose === true) {
    const code = CLIENT_STATUS_CODES[status];
    return { kind: 'known', error: new AppError(code ?? 'INTERNAL_ERROR'), log: code === undefined };
  }
  return { kind: 'unexpected' };
}

/**
 * Creates the central Express error handler. Known errors become the standard
 * `{ error }` envelope; client errors raised by body-parser or the router map to
 * 4xx codes; an aborted request is only logged (`debug`) and its socket closed;
 * anything else becomes a generic 500 and is logged with its stack (log only,
 * never in the response). If the response has already started, the failure is
 * logged and the socket destroyed: no double response. If the handler itself
 * fails (for example an invalid header in an `AppError`), the failure is logged and
 * a hand-written 500 JSON is sent, so Express never renders its own error page.
 *
 * @param logger Logger receiving unexpected errors.
 * @returns Express error-handling middleware.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const requestId = res.locals.requestId;
    try {
      const outcome = classify(error);
      if (outcome.kind === 'aborted') {
        logger.debug('request aborted by the client', { requestId });
        req.socket.destroy();
        return;
      }
      if (res.headersSent) {
        logger.error('error after response started', { requestId, error });
        req.socket.destroy();
        return;
      }
      if (outcome.kind === 'unexpected') {
        logger.error('unhandled error', { requestId, error });
      } else if (outcome.log) {
        logger.warn('unmapped client error', { requestId, error });
      }
      const appError = outcome.kind === 'known' ? outcome.error : new AppError('INTERNAL_ERROR');
      res.set(appError.headers);
      res.status(appError.status).json({
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details === undefined ? {} : { details: appError.details }),
        },
      });
    } catch (failure) {
      logger.error('error handler failed', { requestId, error: failure });
      if (res.headersSent) {
        req.socket.destroy();
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: DEFAULT_MESSAGES.INTERNAL_ERROR } }));
    }
  };
}
