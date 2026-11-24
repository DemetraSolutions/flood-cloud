import { SecurityPolicy } from '../app/features/security-policy/security-policy.types';

/**
 * A security policy as the backend returns it, with every setting at its default. Shared by the
 * specs of the security policy API and page: a spec file must never be imported by another spec,
 * or Vitest finds no suite in it when it runs on its own.
 */
export const POLICY: SecurityPolicy = {
  nonBrowserRequests: 'report',
  sustainedLimits: 'report',
  sources: { nonBrowserRequests: 'default', sustainedLimits: 'default' },
  limits: { perMinute: 300, perHour: 2000, perDay: 10000 },
};
