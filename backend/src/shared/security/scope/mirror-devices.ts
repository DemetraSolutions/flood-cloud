import type { Document, Filter, ObjectId } from 'mongodb';
import { escapeRegExp } from '../../http/list.ts';
import type { UserScope } from './scope.ts';
import { placesScopeFilter } from './scope-filters.ts';

/** Name of the computed key that holds the position of a device in the `devices` list of its place. */
export const DEVICE_INDEX = '__index';

/** Where a page of device rows continues from: after this device of this place (places by `_id`, devices by position). */
export interface DeviceAfter {
  readonly placeId: ObjectId;
  readonly index: number;
}

/**
 * The groups a read covers: the ones listed (a non-empty list: the groups of a caller whose perimeter is one or a few groups), or every group but the ones listed (the platform view,
 * which leaves out the demo groups and the groups in the trash without reading all the others).
 */
export type GroupSelection = { readonly kind: 'include'; readonly ids: readonly ObjectId[] } | { readonly kind: 'exclude'; readonly ids: readonly ObjectId[] };

/** The condition on `groupId` of a selection (an `ObjectId` that is not an array: a malformed `groupId` never matches). */
export function selectionCondition(selection: GroupSelection): Filter<Document> {
  return { $and: [{ groupId: selection.kind === 'include' ? { $in: [...selection.ids] } : { $nin: [...selection.ids] } }, { groupId: { $type: 'objectId' } }] };
}

/**
 * What a read of the device rows needs. Everything in it comes from the server: the groups are the ones of the caller's perimeter already resolved, the place filter is the
 * perimeter of the caller on the places, and the optional filters are validated ids and text.
 */
export interface DeviceRowsQuery {
  /** The groups to read, already restricted to the caller's perimeter. */
  readonly groups: GroupSelection;
  /** The data perimeter of the caller: the filter on the places is computed from it here, so no caller can pass a wider one. */
  readonly scope: UserScope;
  readonly companyId?: ObjectId | undefined;
  readonly placeId?: ObjectId | undefined;
  /** Device type, from the closed list of the types. */
  readonly type?: string | undefined;
  /** Text looked for, literally and without regard to case, in the name of the place and in the name of the device. */
  readonly q?: string | undefined;
  /** Companies in the trash of those groups: their places are left out. */
  readonly trashedCompanyIds: readonly ObjectId[];
}

/** The fields of a device a row may carry: the only ones the pipeline lets out of the document of the place (never a host, a serial number or a credential). */
const DEVICE_FIELDS = Object.freeze({
  'devices.id': 1,
  'devices.name': 1,
  'devices.type': 1,
  'devices.server': 1,
  'devices.info.appVersion': 1,
  'devices.info.system.platform': 1,
  'devices.info.system.platformVersion': 1,
  'devices.info.system.model': 1,
  'devices.info.lastDataDownload': 1,
  'devices.info.date': 1,
});

/** The condition on the places, before the devices are unwound. */
function placeMatch(query: DeviceRowsQuery, after: DeviceAfter | null): Filter<Document> {
  const conditions: Filter<Document>[] = [
    selectionCondition(query.groups),
    { trash: { $ne: true } },
    { devices: { $type: 'array' } },
    placesScopeFilter(query.scope),
  ];
  if (query.trashedCompanyIds.length > 0) {
    conditions.push({ companyId: { $nin: [...query.trashedCompanyIds] } });
  }
  if (query.companyId !== undefined) {
    conditions.push({ companyId: query.companyId });
  }
  if (query.placeId !== undefined) {
    conditions.push({ _id: query.placeId });
  }
  if (after !== null) {
    conditions.push({ _id: { $gte: after.placeId } });
  }
  return { $and: conditions };
}

/** The condition on the unwound devices: type, text and the position the page continues from. */
function deviceMatch(query: DeviceRowsQuery, after: DeviceAfter | null): Filter<Document> {
  const conditions: Filter<Document>[] = [];
  if (query.type !== undefined) {
    conditions.push({ 'devices.type': query.type });
  }
  if (query.q !== undefined) {
    const pattern = { $regex: escapeRegExp(query.q), $options: 'i' };
    conditions.push({ $or: [{ name: pattern }, { 'devices.name': pattern }] });
  }
  if (after !== null) {
    conditions.push({ $or: [{ _id: { $gt: after.placeId } }, { _id: after.placeId, [DEVICE_INDEX]: { $gt: after.index } }] });
  }
  return conditions.length === 0 ? {} : { $and: conditions };
}

/** The stages shared by the page and the count: the places in the perimeter, the devices unwound and cut to their allowed fields, then filtered. */
function deviceStages(query: DeviceRowsQuery, after: DeviceAfter | null): Document[] {
  return [
    { $match: placeMatch(query, after) },
    // The places in the order of the index on `_id`; `$unwind` keeps the order of the places and of the devices, so nothing is sorted after it.
    { $project: { groupId: 1, companyId: 1, name: 1, devices: 1 } },
    { $sort: { _id: 1 } },
    { $unwind: { path: '$devices', includeArrayIndex: DEVICE_INDEX } },
    { $project: { groupId: 1, companyId: 1, name: 1, [DEVICE_INDEX]: 1, ...DEVICE_FIELDS } },
    { $match: deviceMatch(query, after) },
  ];
}

/**
 * The pipeline of a page of device rows: one document per device of the places in the perimeter, in the order of the places' `_id` and of the position of the device (the order of the `$sort` before the unwind),
 * cut to `limit` documents, each joined with the name and the code of its company (read from the copy of the companies, only for the page). The pipeline is built here and never takes a
 * stage from a caller; the output holds only the allowed fields of the device.
 *
 * @param query The perimeter and the filters.
 * @param after Where to continue from, or `null` for the first page.
 * @param limit How many rows to read (a positive integer; the caller asks one more than a page to know whether another follows).
 * @returns The stages.
 */
export function deviceRowsPipeline(query: DeviceRowsQuery, after: DeviceAfter | null, limit: number): Document[] {
  return [
    ...deviceStages(query, after),
    { $limit: limit },
    // The company of the place, and only if it belongs to the group of the place: a `companyId` that points into another group is not resolved.
    {
      $lookup: {
        from: 'companies',
        localField: 'companyId',
        foreignField: '_id',
        let: { groupId: '$groupId' },
        pipeline: [{ $match: { $expr: { $eq: ['$groupId', '$$groupId'] } } }, { $project: { _id: 0, name: 1, code: 1 } }],
        as: 'company',
      },
    },
    {
      $project: {
        groupId: 1,
        companyId: 1,
        placeName: '$name',
        index: `$${DEVICE_INDEX}`,
        company: { $first: '$company' },
        deviceId: '$devices.id',
        deviceName: '$devices.name',
        deviceType: '$devices.type',
        server: '$devices.server',
        appVersion: '$devices.info.appVersion',
        platform: '$devices.info.system.platform',
        platformVersion: '$devices.info.system.platformVersion',
        model: '$devices.info.system.model',
        lastDataDownload: '$devices.info.lastDataDownload',
        lastSession: '$devices.info.date',
      },
    },
  ];
}

/**
 * The pipeline that counts the device rows of a query, stopping at `cap + 1` (so that a huge result costs no more than the cap).
 *
 * @param query The perimeter and the filters.
 * @param cap The largest count that matters.
 * @returns The stages; the result is `[{ total }]` or `[]`.
 */
export function deviceCountPipeline(query: DeviceRowsQuery, cap: number): Document[] {
  return [...deviceStages(query, null), { $limit: cap + 1 }, { $count: 'total' }];
}
