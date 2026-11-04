import type { Request, Response } from 'express';

/** Longest user agent stored with a session. */
export const MAX_USER_AGENT_LENGTH = 256;

/** What the services need to know about the calling client, without holding the request object. */
export interface ClientContext {
  /** Correlation id of the request. */
  readonly requestId: string;
  /** Client address as resolved by Express (`trust proxy` honored), or `null`. */
  readonly ip: string | null;
  /** The `User-Agent` header cut to {@link MAX_USER_AGENT_LENGTH}, or `null`. */
  readonly userAgent: string | null;
}

/**
 * Extracts the client context of a request for the service layer.
 *
 * @param req The request.
 * @param res The response, whose locals hold the request id.
 * @returns The context.
 */
export function clientContextOf(req: Request, res: Response): ClientContext {
  const userAgent = req.get('user-agent');
  return {
    requestId: res.locals.requestId,
    ip: req.ip ?? null,
    userAgent: userAgent === undefined || userAgent === '' ? null : userAgent.slice(0, MAX_USER_AGENT_LENGTH),
  };
}
