/** Device types a diagnostic row can report (filter allowlist and label keys). */
export const DEVICE_TYPES = [
  'desk',
  'handheld',
  'ordering',
  'room-handheld',
  'selfordering',
  'waiting-list',
  'external-display',
  'kiosk',
  'tgm',
] as const;

/** A device type of {@link DEVICE_TYPES}. */
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** Whether a value is a known device type. */
export function isDeviceType(value: unknown): value is DeviceType {
  return DEVICE_TYPES.some((type) => type === value);
}

/** Dictionary key of the label of a device type (`room-handheld` becomes `ROOM_HANDHELD`). */
export function deviceTypeKey(type: DeviceType): string {
  return `DIAGNOSTICS.TYPE.${type.toUpperCase().replace(/-/g, '_')}`;
}

/** State of the store key of a place. */
export interface StoreKeyStatus {
  readonly status: 'active' | 'none';
  /** ISO date of the last use of the key. */
  readonly lastSeenAt: string | null;
  readonly appVersion: string | null;
}

/** One row of `GET /v1/diagnostics/devices`: a device of a place with its group and company. */
export interface DiagnosticRow {
  /** `<placeId>:<index>`, unique. */
  readonly id: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  /** Company VAT number (P.IVA). */
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
  readonly storeKey: StoreKeyStatus;
}
