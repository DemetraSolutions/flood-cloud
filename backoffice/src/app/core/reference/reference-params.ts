import type { ReferenceQuery } from './reference-api';

/**
 * Query string of a reference read: the trimmed search text, the cursor, the company filter and
 * the ids are sent only when present, and the limit only when given.
 *
 * @param query Parameters of the read.
 * @returns The parameters in a fixed order (so equal reads give equal parameters).
 */
export function referenceParams(query: ReferenceQuery): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (query.limit !== undefined) {
    params['limit'] = query.limit;
  }
  const text = query.q?.trim();
  if (text) {
    params['q'] = text;
  }
  if (query.cursor) {
    params['cursor'] = query.cursor;
  }
  if (query.companyId) {
    params['companyId'] = query.companyId;
  }
  if (query.ids !== undefined && query.ids.length > 0) {
    params['ids'] = query.ids.join(',');
  }
  return params;
}
