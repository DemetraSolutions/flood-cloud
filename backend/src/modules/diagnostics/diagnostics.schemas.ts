import { DEVICE_TYPES } from '../../shared/legacy-write/place-lists.ts';
import { MAX_SEARCH_LENGTH } from '../../shared/http/list.ts';
import { enumOf, integerString, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Largest page of the device table. */
export const DIAGNOSTICS_MAX_LIMIT = 100;

/** Default page of the device table. */
export const DIAGNOSTICS_DEFAULT_LIMIT = 50;

/** The filters the table and its CSV share. */
const filters = {
  groupId: optional(objectId()),
  companyId: optional(objectId()),
  placeId: optional(objectId()),
  type: optional(enumOf(DEVICE_TYPES)),
  q: optional(string({ min: 1, max: MAX_SEARCH_LENGTH, trim: true })),
};

/** Query of `GET /v1/diagnostics/devices`: the filters and the cursor pagination. Unknown parameters are refused. */
export const devicesQuery = object({
  limit: optional(integerString({ min: 1, max: DIAGNOSTICS_MAX_LIMIT })),
  cursor: optional(string({ min: 1, max: 100, normalize: false })),
  ...filters,
});

/** Validated query of the device table. */
export type DevicesQuery = Infer<typeof devicesQuery>;

/** Query of `GET /v1/diagnostics/devices.csv`: the same filters, with no pagination (the whole result is exported, up to the limit of the export). */
export const devicesCsvQuery = object({ ...filters });

/** Validated query of the CSV export. */
export type DevicesCsvQuery = Infer<typeof devicesCsvQuery>;
