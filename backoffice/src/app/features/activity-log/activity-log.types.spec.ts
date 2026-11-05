import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import {
  abbreviateId,
  actionLabelKey,
  ACTIVITY_ACTIONS,
  formatChangeValue,
} from './activity-log.types';

describe('activity log types', () => {
  it('lists every catalog action once, including the client error', () => {
    expect(new Set(ACTIVITY_ACTIONS).size).toBe(ACTIVITY_ACTIONS.length);
    expect(ACTIVITY_ACTIONS).toContain('client.error');
    expect(ACTIVITY_ACTIONS).toContain('request.failed');
    expect(ACTIVITY_ACTIONS).toContain('place.deleted');
    expect(ACTIVITY_ACTIONS).toContain('rateLimit.exceeded');
  });

  it('builds dictionary keys from the action names', () => {
    expect(actionLabelKey('auth.loginSucceeded')).toBe('ACTIVITY.ACTION.AUTH_LOGIN_SUCCEEDED');
    expect(actionLabelKey('rateLimit.exceeded')).toBe('ACTIVITY.ACTION.RATE_LIMIT_EXCEEDED');
    expect(actionLabelKey('client.error')).toBe('ACTIVITY.ACTION.CLIENT_ERROR');
  });

  it('has a label in the dictionary for every action', () => {
    const keys = flattenDictionary(
      JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
    );
    expect(ACTIVITY_ACTIONS.filter((action) => !keys.has(actionLabelKey(action)))).toEqual([]);
  });

  it('abbreviates ids and formats change values', () => {
    expect(abbreviateId('665f1c2e9b1d4a0012ab34a1')).toBe('…ab34a1');
    expect(formatChangeValue(undefined)).toBe('');
    expect(formatChangeValue('text')).toBe('text');
    expect(formatChangeValue(['a', 1])).toBe('["a",1]');
    expect(formatChangeValue(null)).toBe('null');
  });
});
