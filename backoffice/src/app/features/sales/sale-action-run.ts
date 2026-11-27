import { computed, effect, inject, signal, Signal, untracked } from '@angular/core';
import { ApiError, fieldErrors } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { conflictKey } from './sale-labels';

/** What went wrong in a write of a sale, as the dialog shows it. */
export interface SaleFailure {
  /** The message for the user (already translated). */
  readonly message: string;
  /** The issue of each field of the form a `422` names. */
  readonly fields: Readonly<Record<string, string>>;
  /** The sale has to be read again: the outcome is not known, or the sale is not as it was. */
  readonly reread: boolean;
  /** The request may have been applied (no answer or a server error): a retry must be the same request. */
  readonly uncertain: boolean;
}

/** The field of the form a field of the request belongs to; `undefined` when it has none. */
export type FieldOf = (field: string) => string | undefined;

/** For a dialog whose request has no fields of its own. */
export const NO_FIELDS: FieldOf = () => undefined;

/**
 * Turns the failure of a write of a sale into what the dialog shows:
 * - no answer or a server error: the outcome is uncertain, so the sale is read again before another try;
 * - `412`: the sale changed, it is read again;
 * - `403`: when the user lacks the permission to write the loyalty cards, the text says so (only
 *   then: with the permission a `403` is any other refusal);
 * - `409`: the text of the first detail the interface knows, and the sale is read again;
 * - `422`: the issues of the fields; a detail that belongs to no field of the form is said in the
 *   message instead;
 * - anything else: the central message.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 * @param fidelityMissing Whether the write moves credit and the user cannot write the loyalty cards.
 * @param fieldOf The field of the form a field of the request belongs to.
 */
export function saleFailure(
  i18n: I18nService,
  error: unknown,
  fidelityMissing: boolean,
  fieldOf: FieldOf,
): SaleFailure {
  if (error instanceof ApiError) {
    if (error.status === 0 || error.status >= 500) {
      return { message: i18n.t('SALES.ACTION.UNCERTAIN'), fields: {}, reread: true, uncertain: true };
    }
    if (error.code === 'PRECONDITION_FAILED') {
      return { message: i18n.t('SALES.ACTION.STALE'), fields: {}, reread: true, uncertain: false };
    }
    if (error.code === 'FORBIDDEN' && fidelityMissing) {
      return { message: i18n.t('SALES.ACTION.FIDELITY_REQUIRED'), fields: {}, reread: false, uncertain: false };
    }
    if (error.code === 'CONFLICT') {
      return { message: i18n.t(conflictKey(error.details)), fields: {}, reread: true, uncertain: false };
    }
    if (error.code === 'VALIDATION_ERROR') {
      const fields: Record<string, string> = {};
      let unmapped = error.details.length === 0;
      for (const [field, issue] of Object.entries(fieldErrors(error))) {
        const name = fieldOf(field);
        if (name === undefined) {
          unmapped = true;
        } else if (!Object.hasOwn(fields, name)) {
          fields[name] = issue;
        }
      }
      const message = unmapped ? i18n.t('SALES.ACTION.INVALID_UNMAPPED') : failureMessage(i18n, error);
      return { message, fields, reread: false, uncertain: false };
    }
  }
  return { message: failureMessage(i18n, error), fields: {}, reread: false, uncertain: false };
}

/**
 * The run of one write of a sale for a dialog: the request in progress, the failure to show and
 * the wait for the sale to be read again. After a failure that leaves the outcome unknown (or the
 * sale changed) the dialog asks the page to read the sale again and cannot send until that read
 * ends. Created in the field initializer of the dialog (it registers an effect).
 */
export class SaleActionRun {
  private readonly i18n = inject(I18nService);
  private readonly waiting = signal(false);
  private sawRefresh = false;

  /** The sale is being read again after a failure; the dialog cannot send until that read ends. */
  readonly rereading = this.waiting.asReadonly();
  /** A request is in progress. */
  readonly busy = signal(false);
  /** The message of the last failure, `null` when there is none. */
  readonly failure = signal<string | null>(null);
  /** The last request may have been applied (no answer or a server error). */
  readonly uncertain = signal(false);
  /** The issue of each field of the form the server refused. */
  readonly fields = signal<Readonly<Record<string, string>>>({});
  /** The dialog cannot send: a request runs or the sale is being read again. */
  readonly blocked = computed(() => this.busy() || this.waiting());

  /**
   * @param refreshing Whether the page is reading the sale.
   * @param reread Asks the page to read the sale again.
   */
  constructor(
    private readonly refreshing: Signal<boolean>,
    private readonly reread: () => void,
  ) {
    effect(() => {
      const refreshing = this.refreshing();
      untracked(() => {
        if (!this.waiting()) {
          return;
        }
        if (refreshing) {
          this.sawRefresh = true;
        } else {
          this.sawRefresh = false;
          this.waiting.set(false);
        }
      });
    });
  }

  /** Starts a new opening of the dialog: no failure and no wait. */
  reset(): void {
    this.busy.set(false);
    this.failure.set(null);
    this.fields.set({});
    this.uncertain.set(false);
    this.waiting.set(false);
    this.sawRefresh = false;
  }

  /**
   * Runs a write.
   *
   * @param operation The request.
   * @param fidelityMissing Whether the write moves credit and the user cannot write the loyalty cards.
   * @param fieldOf The field of the form a field of the request belongs to.
   * @returns `true` when the write was done.
   */
  async run(operation: () => Promise<void>, fidelityMissing: boolean, fieldOf: FieldOf): Promise<boolean> {
    this.busy.set(true);
    this.failure.set(null);
    this.fields.set({});
    this.uncertain.set(false);
    try {
      await operation();
      return true;
    } catch (error) {
      const failure = saleFailure(this.i18n, error, fidelityMissing, fieldOf);
      this.failure.set(failure.message);
      this.fields.set(failure.fields);
      this.uncertain.set(failure.uncertain);
      if (failure.reread) {
        // A read already running ends with a fresh sale too: it counts as the one to wait for.
        this.sawRefresh = this.refreshing();
        this.waiting.set(true);
        this.reread();
      }
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
