import { deviceTypeKey, isDeviceType } from './diagnostics.types';

describe('device types', () => {
  it('recognizes the known types only', () => {
    expect(isDeviceType('desk')).toBe(true);
    expect(isDeviceType('waiting-list')).toBe(true);
    expect(isDeviceType('other')).toBe(false);
    expect(isDeviceType(null)).toBe(false);
  });

  it('builds the dictionary key of a type', () => {
    expect(deviceTypeKey('room-handheld')).toBe('DIAGNOSTICS.TYPE.ROOM_HANDHELD');
    expect(deviceTypeKey('tgm')).toBe('DIAGNOSTICS.TYPE.TGM');
  });
});
