import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import {
  abbreviateId,
  actionLabelKey,
  ACTIVITY_ACTIONS,
  formatChangeValue,
  otherActorLabel,
  alertSummary,
} from './activity-log.types';

describe('activity log types', () => {
  it('lists every catalog action once, including the client error', () => {
    expect(new Set(ACTIVITY_ACTIONS).size).toBe(ACTIVITY_ACTIONS.length);
    expect(ACTIVITY_ACTIONS).toContain('client.error');
    expect(ACTIVITY_ACTIONS).toContain('request.failed');
    expect(ACTIVITY_ACTIONS).toContain('place.deleted');
    expect(ACTIVITY_ACTIONS).toContain('rateLimit.exceeded');
    expect(ACTIVITY_ACTIONS).toContain('store.configurationRead');
    for (const verb of ['created', 'updated', 'revoked']) {
      expect(ACTIVITY_ACTIONS).toContain(`apiKey.${verb}`);
    }
    for (const verb of ['created', 'updated', 'deleted']) {
      expect(ACTIVITY_ACTIONS).toContain(`country.${verb}`);
      expect(ACTIVITY_ACTIONS).toContain(`countryArea.${verb}`);
    }
  });

  it('builds dictionary keys from the action names', () => {
    expect(actionLabelKey('auth.loginSucceeded')).toBe('ACTIVITY.ACTION.AUTH_LOGIN_SUCCEEDED');
    expect(actionLabelKey('rateLimit.exceeded')).toBe('ACTIVITY.ACTION.RATE_LIMIT_EXCEEDED');
    expect(actionLabelKey('store.configurationRead')).toBe(
      'ACTIVITY.ACTION.STORE_CONFIGURATION_READ',
    );
    expect(actionLabelKey('client.error')).toBe('ACTIVITY.ACTION.CLIENT_ERROR');
    expect(actionLabelKey('apiKey.revoked')).toBe('ACTIVITY.ACTION.API_KEY_REVOKED');
    expect(actionLabelKey('countryArea.created')).toBe('ACTIVITY.ACTION.COUNTRY_AREA_CREATED');
  });

  it('has a label in the dictionary for every action', () => {
    const keys = flattenDictionary(
      JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
    );
    expect(ACTIVITY_ACTIONS.filter((action) => !keys.has(actionLabelKey(action)))).toEqual([]);
  });

  it('lists the alert, store and catalog actions with a key for every dot', () => {
    for (const action of [
      'rateLimit.sustainedExceeded',
      'store.operatorRejected',
      'store.activationCodeForActivePlace',
      'store.activeKeyReplaced',
      'group.tax.realignmentIncomplete',
      'product.duplicated',
      'productCategory.deleted',
      'productDepartment.created',
      'productBrand.updated',
      'productAttributeGroup.deleted',
    ]) {
      expect(ACTIVITY_ACTIONS).toContain(action);
    }
    expect(ACTIVITY_ACTIONS).not.toContain('productCategory.trashed');
    expect(actionLabelKey('group.tax.realignmentIncomplete')).toBe(
      'ACTIVITY.ACTION.GROUP_TAX_REALIGNMENT_INCOMPLETE',
    );
    expect(actionLabelKey('productAttributeGroup.created')).toBe(
      'ACTIVITY.ACTION.PRODUCT_ATTRIBUTE_GROUP_CREATED',
    );
  });

  it('summarises a sustained limit entry and nothing else', () => {
    const i18n = {
      t: (key: string, params?: object) => `${key}${params ? JSON.stringify(params) : ''}`,
    };
    const entry = (
      metadata: Record<string, string | number | boolean | null> | null,
      action = 'rateLimit.sustainedExceeded',
    ) => ({ action, metadata });
    expect(alertSummary(i18n, entry({ window: 'hour', limit: 600, mode: 'report' }))).toBe(
      'ACTIVITY.ALERTS.DETAIL{"limit":600,"window":"ACTIVITY.ALERTS.WINDOW_HOUR","mode":"ACTIVITY.ALERTS.MODE_REPORT"}',
    );
    expect(alertSummary(i18n, entry({ window: 'day', limit: 5000, mode: 'enforce' }))).toBe(
      'ACTIVITY.ALERTS.DETAIL{"limit":5000,"window":"ACTIVITY.ALERTS.WINDOW_DAY","mode":"ACTIVITY.ALERTS.MODE_ENFORCE"}',
    );
    expect(alertSummary(i18n, entry(null))).toBeNull();
    expect(alertSummary(i18n, entry({ window: 'week', limit: 1, mode: 'report' }))).toBeNull();
    expect(alertSummary(i18n, entry({ window: 'hour', limit: '1', mode: 'report' }))).toBeNull();
    expect(alertSummary(i18n, entry({ window: 'hour', limit: 1, mode: 'x' }))).toBeNull();
    expect(
      alertSummary(i18n, entry({ window: 'hour', limit: 1, mode: 'report' }, 'user.updated')),
    ).toBeNull();
  });

  it('describes the key of the store alerts', () => {
    const i18n = { t: (key: string, params?: object) => `${key}${JSON.stringify(params)}` };
    const entry = (action: string, keyHint: unknown) => ({
      action,
      metadata: { keyHint } as never,
    });
    expect(alertSummary(i18n, entry('store.activationCodeForActivePlace', 'fc_sk_AbC1'))).toBe(
      'ACTIVITY.ALERTS.CODE_FOR_ACTIVE{"hint":"fc_sk_AbC1"}',
    );
    expect(alertSummary(i18n, entry('store.activeKeyReplaced', 'fc_sk_AbC1'))).toBe(
      'ACTIVITY.ALERTS.KEY_REPLACED{"hint":"fc_sk_AbC1"}',
    );
    expect(alertSummary(i18n, entry('store.activeKeyReplaced', ''))).toBeNull();
    expect(alertSummary(i18n, entry('store.activeKeyReplaced', 5))).toBeNull();
    expect(alertSummary(i18n, { action: 'store.activeKeyReplaced', metadata: null })).toBeNull();
  });

  it('describes a request that did not come from a browser, the program as plain text', () => {
    const i18n = { t: (key: string, params?: object) => `${key}${JSON.stringify(params ?? {})}` };
    const entry = (metadata: Record<string, unknown> | null) => ({
      action: 'request.nonBrowser',
      metadata: metadata as never,
    });
    expect(
      alertSummary(
        i18n,
        entry({ reason: 'noOrigin', source: 'login', userAgent: '<b>curl/8</b>' }),
      ),
    ).toBe(
      'ACTIVITY.ALERTS.NON_BROWSER{"source":"ACTIVITY.ALERTS.SOURCE_LOGIN{}","reason":"ACTIVITY.ALERTS.REASON_NO_ORIGIN{}"} ' +
        'ACTIVITY.ALERTS.PROGRAM{"agent":"<b>curl/8</b>"}',
    );
    for (const userAgent of [null, '']) {
      expect(
        alertSummary(i18n, entry({ reason: 'foreignOrigin', source: 'refresh', userAgent })),
      ).toBe(
        'ACTIVITY.ALERTS.NON_BROWSER{"source":"ACTIVITY.ALERTS.SOURCE_REFRESH{}","reason":"ACTIVITY.ALERTS.REASON_FOREIGN_ORIGIN{}"}',
      );
    }
    expect(
      alertSummary(i18n, entry({ reason: 'inconsistentFetchMetadata', source: 'api' })),
    ).toContain('REASON_INCONSISTENT');
    expect(alertSummary(i18n, entry({ reason: 'x', source: 'api' }))).toBeNull();
    expect(alertSummary(i18n, entry({ reason: 'noOrigin', source: 'constructor' }))).toBeNull();
    expect(alertSummary(i18n, entry({ reason: 5, source: 'api' }))).toBeNull();
    expect(alertSummary(i18n, entry({ reason: 'noOrigin', source: null }))).toBeNull();
    expect(alertSummary(i18n, entry(null))).toBeNull();
  });

  it('describes what a security policy change turned from and to', () => {
    const i18n = { t: (key: string, params?: object) => `${key}${JSON.stringify(params ?? {})}` };
    const entry = (
      changes: readonly { field: string; before?: unknown; after?: unknown }[] | null,
    ) => ({
      action: 'settings.securityPolicyUpdated',
      metadata: null,
      changes,
    });
    const text = alertSummary(
      i18n,
      entry([
        { field: 'nonBrowserRequests', before: 'report', after: 'block' },
        { field: 'sustainedLimits', before: 'enforce', after: 'report' },
      ]),
    ) as string;
    expect(text).toContain(
      '"before":"ACTIVITY.ALERTS.POLICY_REPORT{}","after":"ACTIVITY.ALERTS.POLICY_BLOCK{}"',
    );
    expect(text).toContain('POLICY_LIMITS');
    expect(text).toContain(
      '"before":"ACTIVITY.ALERTS.POLICY_BLOCK{}","after":"ACTIVITY.ALERTS.POLICY_REPORT{}"',
    );
    expect(
      alertSummary(i18n, entry([{ field: 'other', before: 'report', after: 'block' }])),
    ).toBeNull();
    expect(
      alertSummary(i18n, entry([{ field: 'sustainedLimits', before: 1, after: 'block' }])),
    ).toBeNull();
    expect(
      alertSummary(i18n, entry([{ field: 'sustainedLimits', before: 'report', after: 'x' }])),
    ).toBeNull();
    expect(alertSummary(i18n, entry([]))).toBeNull();
    expect(alertSummary(i18n, entry(null))).toBeNull();
    expect(
      alertSummary(i18n, { action: 'settings.securityPolicyUpdated', metadata: null }),
    ).toBeNull();
  });

  it('describes a revoked store key and a login or refresh refused for lack of a browser', () => {
    const i18n = { t: (key: string, params?: object) => `${key}${JSON.stringify(params ?? {})}` };
    expect(
      alertSummary(i18n, {
        action: 'store.activeKeyRevoked',
        metadata: { keyHint: 'fc_sk_Ab', keyId: 'k' },
      }),
    ).toBe('ACTIVITY.ALERTS.KEY_REVOKED{"hint":"fc_sk_Ab"}');
    for (const action of ['auth.loginFailed', 'auth.refreshFailed']) {
      expect(alertSummary(i18n, { action, metadata: { reason: 'browserRequired' } })).toBe(
        'ACTIVITY.ALERTS.BROWSER_REQUIRED{}',
      );
      expect(alertSummary(i18n, { action, metadata: { reason: 'other' } })).toBeNull();
      expect(alertSummary(i18n, { action, metadata: null })).toBeNull();
    }
  });

  it('abbreviates ids and formats change values', () => {
    expect(abbreviateId('665f1c2e9b1d4a0012ab34a1')).toBe('…ab34a1');
    expect(formatChangeValue(undefined)).toBe('');
    expect(formatChangeValue('text')).toBe('text');
    expect(formatChangeValue(['a', 1])).toBe('["a",1]');
    expect(formatChangeValue(null)).toBe('null');
  });

  describe('otherActorLabel', () => {
    const i18n = {
      t: (key: string, params?: Record<string, string | number>) =>
        `${key} ${JSON.stringify(params ?? {})}`,
    };
    const actor = (kind: 'system' | 'anonymous' | 'store' | 'apiKey', id: string | null) => ({
      kind,
      id,
      role: null,
      username: null,
    });

    it('names an integration by its API key, shortened', () => {
      const documentId = ['6650c0a1b2c3', 'd4e5f6a7b8c9'].join('');
      expect(otherActorLabel(i18n, actor('apiKey', documentId))).toBe(
        'ACTIVITY.ACTOR.API_KEY {"id":"…a7b8c9"}',
      );
    });

    it('names a key without id by its kind alone', () => {
      expect(otherActorLabel(i18n, actor('apiKey', null))).toBe('ACTIVITY.ACTOR.API_KEY {"id":""}');
    });

    it.each([
      ['system', 'ACTIVITY.ACTOR.SYSTEM'],
      ['anonymous', 'ACTIVITY.ACTOR.ANONYMOUS'],
      ['store', 'ACTIVITY.ACTOR.STORE'],
    ] as const)('names the %s actor by its kind', (kind, key) => {
      expect(otherActorLabel(i18n, actor(kind, null))).toBe(`${key} {}`);
    });
  });
});
