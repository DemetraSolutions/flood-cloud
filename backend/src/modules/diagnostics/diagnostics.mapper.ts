import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { ActiveKeySummary } from '../store-keys/store-keys.types.ts';

/** The store key of a place as the diagnostics show it. */
export interface DeviceKeyView {
  readonly status: 'active' | 'none';
  readonly lastSeenAt: string | null;
  readonly appVersion: string | null;
}

/** One row of the diagnostics: a device of a place, with its group, its company and the store key of its place. The only representation that leaves the server. */
export interface DeviceRowView {
  /** `<placeId>:<position of the device>`: unique, stable for a given list of devices. */
  readonly id: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  /** The VAT code of the company. */
  readonly companyCode: string | null;
  readonly placeId: string;
  readonly placeName: string;
  readonly deviceId: string | null;
  readonly deviceName: string;
  readonly deviceType: string | null;
  readonly appVersion: string | null;
  readonly server: boolean;
  readonly platform: string | null;
  readonly platformVersion: string | null;
  readonly model: string | null;
  readonly lastDataDownload: string | null;
  readonly lastSession: string | null;
  readonly storeKey: DeviceKeyView;
}

/** Longest text a row carries from the stored data. */
const MAX_TEXT = 200;

/** A stored text (or number) as a trimmed, cut text, `null` when it is not one or is empty. */
function text(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_TEXT);
}

/** A stored date (a date, or a text or a number a date can be made of) as an ISO text, `null` when it is none. */
function isoDate(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return date === null || Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The key of a place: active with what it declared, or none. */
function keyView(key: ActiveKeySummary | undefined): DeviceKeyView {
  return key === undefined ? { status: 'none', lastSeenAt: null, appVersion: null } : { status: 'active', lastSeenAt: isoDate(key.lastSeenAt), appVersion: text(key.appVersion) };
}

/**
 * Maps a document read by the device pipeline to its public row, field by field: nothing of the stored data goes out that is not named here, and every value is checked for its type.
 *
 * @param row The document of `deviceRowsPipeline`.
 * @param groupNames Names of the groups of the page, by hexadecimal id.
 * @param keys The active key of the places of the page, by hexadecimal id of the place.
 */
export function toDeviceRow(row: Document, groupNames: ReadonlyMap<string, string>, keys: ReadonlyMap<string, ActiveKeySummary>): DeviceRowView {
  const placeId = (row['_id'] as ObjectId).toHexString();
  const groupId = (row['groupId'] as ObjectId).toHexString();
  const company = row['company'] as { name?: unknown; code?: unknown } | undefined;
  const companyId: unknown = row['companyId'];
  return {
    id: `${placeId}:${String(Number(row['index']))}`,
    groupId,
    groupName: text(groupNames.get(groupId)) ?? '',
    companyId: companyId instanceof ObjectId ? companyId.toHexString() : null,
    companyName: text(company?.name),
    companyCode: text(company?.code),
    placeId,
    placeName: text(row['placeName']) ?? '',
    deviceId: text(row['deviceId']),
    deviceName: text(row['deviceName']) ?? '',
    deviceType: text(row['deviceType']),
    appVersion: text(row['appVersion']),
    server: row['server'] === true,
    platform: text(row['platform']),
    platformVersion: text(row['platformVersion']),
    model: text(row['model']),
    lastDataDownload: isoDate(row['lastDataDownload']),
    lastSession: isoDate(row['lastSession']),
    storeKey: keyView(keys.get(placeId)),
  };
}
