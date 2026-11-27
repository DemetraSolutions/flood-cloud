import {
  ConfiguredAccount,
  UnconfiguredAccount,
} from '../app/features/einvoicing-accounts/einvoicing-account.types';

/** A configured Aruba account of the platform, as the backend describes it (no password). */
export const CONFIGURED: ConfiguredAccount = {
  hub: 'aruba',
  configured: true,
  enabled: true,
  username: 'flood.user',
  passwordSet: true,
  maxPerHour: 55,
  maxPerYear: 10000,
  updatedAt: '2026-11-27T10:00:00.000Z',
};

/** An account that does not exist yet. */
export const UNCONFIGURED: UnconfiguredAccount = { hub: 'aruba', configured: false };
