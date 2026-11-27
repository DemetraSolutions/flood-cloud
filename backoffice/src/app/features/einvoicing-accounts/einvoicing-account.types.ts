import { Versioned } from '../price-list/price-list.types';

/** Defaults of a new account: enabled, 55 uploads per hour, 10 000 per year (Tier 0). */
export const DEFAULT_MAX_PER_HOUR = 55;
export const DEFAULT_MAX_PER_YEAR = 10000;
/** Bounds of the upload ceilings (as the backend allowlist). */
export const MAX_PER_HOUR_LIMIT = 1000;
export const MAX_PER_YEAR_LIMIT = 100_000_000;
/** Longest username and password. */
export const MAX_USERNAME_LENGTH = 100;
export const MAX_PASSWORD_LENGTH = 256;

/** An account that does not exist yet (`GET` answers only the hub). */
export interface UnconfiguredAccount {
  readonly hub: string;
  readonly configured: false;
}

/** An account as the backend describes it: never the password, only whether one is set. */
export interface ConfiguredAccount {
  readonly hub: string;
  readonly configured: true;
  readonly enabled: boolean;
  readonly username: string;
  readonly passwordSet: boolean;
  readonly maxPerHour: number;
  readonly maxPerYear: number | null;
  readonly updatedAt: string;
}

/** `GET` of an account of a dealer or of the platform. */
export type EInvoicingAccount = UnconfiguredAccount | ConfiguredAccount;

/** The account with the version (`ETag`) it was read with. */
export type VersionedAccount = Versioned<EInvoicingAccount>;

/** Body of a `PUT`: `password` is left out to keep the stored one. */
export interface EInvoicingAccountChange {
  readonly enabled: boolean;
  readonly username: string;
  readonly password?: string;
  readonly maxPerHour: number;
  readonly maxPerYear: number | null;
}

/** Model of the account form: numbers are typed as text, the password is always empty after a read. */
export interface EInvoicingFormModel {
  enabled: boolean;
  username: string;
  password: string;
  maxPerHour: string;
  maxPerYear: string;
}

/** Reasons a field of the form is refused (names of `FORM.ISSUE.*`). */
export type AccountIssue = 'required' | 'pattern' | 'maxLength' | 'minimum' | 'maximum';

/**
 * The form model that starts from an account: its values, or the defaults of a new one. The
 * password is never filled in.
 *
 * @param account The account read, `null` before the first read.
 */
export function toFormModel(account: EInvoicingAccount | null): EInvoicingFormModel {
  return account?.configured === true
    ? {
        enabled: account.enabled,
        username: account.username,
        password: '',
        maxPerHour: String(account.maxPerHour),
        maxPerYear: account.maxPerYear === null ? '' : String(account.maxPerYear),
      }
    : {
        enabled: true,
        username: '',
        password: '',
        maxPerHour: String(DEFAULT_MAX_PER_HOUR),
        maxPerYear: String(DEFAULT_MAX_PER_YEAR),
      };
}

/** Why a typed username is refused: printable ASCII without spaces, 1 to 100 characters. */
export function usernameIssue(text: string): AccountIssue | undefined {
  if (text === '') {
    return 'required';
  }
  if (!/^[\x21-\x7e]+$/.test(text)) {
    return 'pattern';
  }
  return text.length > MAX_USERNAME_LENGTH ? 'maxLength' : undefined;
}

/**
 * Why a typed password is refused: printable characters, 1 to 256; empty is fine when an account
 * already holds one (it stays as it is).
 *
 * @param text What the user typed.
 * @param required Whether the account has no password yet.
 */
export function passwordIssue(text: string, required: boolean): AccountIssue | undefined {
  if (text === '') {
    return required ? 'required' : undefined;
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(text)) {
    return 'pattern';
  }
  return text.length > MAX_PASSWORD_LENGTH ? 'maxLength' : undefined;
}

/**
 * Why a typed ceiling is refused: a whole number from 1 to `max`.
 *
 * @param text What the user typed.
 * @param max Highest value.
 * @param optional Whether an empty text is fine (no ceiling).
 */
export function limitIssue(text: string, max: number, optional: boolean): AccountIssue | undefined {
  if (text.trim() === '') {
    return optional ? undefined : 'required';
  }
  if (!/^\d{1,12}$/.test(text.trim())) {
    return 'pattern';
  }
  const value = Number(text.trim());
  if (value < 1) {
    return 'minimum';
  }
  return value > max ? 'maximum' : undefined;
}

/**
 * The body of a `PUT` from the form. The password is sent only when typed.
 *
 * @param model Form values, already validated.
 */
export function toChange(model: EInvoicingFormModel): EInvoicingAccountChange {
  return {
    enabled: model.enabled,
    username: model.username,
    ...(model.password === '' ? {} : { password: model.password }),
    maxPerHour: Number(model.maxPerHour.trim()),
    maxPerYear: model.maxPerYear.trim() === '' ? null : Number(model.maxPerYear.trim()),
  };
}
