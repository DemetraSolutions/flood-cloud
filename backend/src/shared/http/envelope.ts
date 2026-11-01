import type { Response } from 'express';

/** Cursor pagination metadata of a list response. */
export interface PageInfo {
  /** Page size actually applied. */
  readonly limit: number;
  /** Opaque cursor of the next page, or `null` on the last page. */
  readonly next: string | null;
}

/**
 * Sends a success envelope `{ data }`.
 *
 * @param res Express response.
 * @param data Payload; must already be mapped to its public representation.
 * @param status HTTP status, 200 by default (use 201 on creation).
 */
export function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

/**
 * Sends a list envelope `{ data: [...], page: { limit, next } }`.
 *
 * @param res Express response.
 * @param items Items of the page.
 * @param page Pagination metadata.
 */
export function sendPage(res: Response, items: readonly unknown[], page: PageInfo): void {
  res.status(200).json({ data: items, page: { limit: page.limit, next: page.next } });
}
