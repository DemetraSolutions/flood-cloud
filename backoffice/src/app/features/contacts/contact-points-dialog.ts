import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { ApiError } from '../../core/api/api-error';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ContactApi } from './contact-api';
import { lineIssue } from './contact-model';
import { CONTACT_LIMITS, PointsAdjustment } from './contact.types';

/** Whether an adjustment adds points or takes them away. */
export type Direction = 'add' | 'remove';

/**
 * The issue of the amount of a points adjustment: a positive whole number of at most a million
 * (the direction says whether it is added or taken away).
 *
 * @param text What the user typed.
 */
export function amountIssue(text: string): 'required' | 'type' | 'incorrect' | 'maximum' | undefined {
  const value = text.trim();
  if (value === '') {
    return 'required';
  }
  if (!/^\d+$/.test(value)) {
    return 'type';
  }
  const number = Number(value);
  if (number === 0) {
    return 'incorrect';
  }
  return number > CONTACT_LIMITS.pointsDelta ? 'maximum' : undefined;
}

/**
 * Adjusts the points of a loyalty card: "add" or "take away" a positive whole number, with an
 * optional reason (the dialog warns not to put personal data in it) and a preview of the new
 * balance. The adjustment is applied at once, without pressing Save on the page. Every opening
 * starts clean with its own `Idempotency-Key`, used for every submission of that opening (the
 * server answers a submission with other values with `409` `reused`, which has its own text); a
 * result that arrives for an earlier opening is dropped, and the dialog cannot be closed while a
 * request is running. A balance that would go below zero (`409` `insufficient`) and a card the
 * contact has twice (`409` `duplicate`) have their own text. When it succeeds the new balance is
 * shown, takes the focus and `adjusted` carries it.
 */
@Component({
  selector: 'fc-contact-points-dialog',
  imports: [Button, Dialog, FormError, Select, TextField, TPipe],
  templateUrl: './contact-points-dialog.html',
})
export class ContactPointsDialog {
  private readonly api = inject(ContactApi);
  private readonly i18n = inject(I18nService);
  private key = crypto.randomUUID();
  private opening = 0;
  private doubtful = false;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly groupId = input.required<string>();
  readonly contactId = input.required<string>();
  /** Code of the card. */
  readonly code = input.required<string>();
  /** Balance of the card before the adjustment. */
  readonly points = input.required<number>();
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** The balance after a successful adjustment. */
  readonly adjusted = output<PointsAdjustment>();
  /** The outcome of an adjustment is not known (no answer or a server error): the contact has to be read again. Emitted when the dialog is closed. */
  readonly uncertain = output<void>();

  protected readonly direction = signal<Direction>('add');
  protected readonly amount = signal('');
  protected readonly reason = signal('');
  protected readonly touched = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly result = signal<PointsAdjustment | null>(null);
  protected readonly reasonLimit = CONTACT_LIMITS.pointsReason;
  protected readonly directions = computed<SelectOption[]>(() => [
    { value: 'add', label: this.i18n.t('CONTACTS.POINTS.ADD') },
    { value: 'remove', label: this.i18n.t('CONTACTS.POINTS.REMOVE') },
  ]);

  /** The signed change, `null` while the amount is not valid. */
  protected readonly delta = computed(() =>
    amountIssue(this.amount()) === undefined ? Number(this.amount()) * (this.direction() === 'add' ? 1 : -1) : null,
  );
  protected readonly newBalance = computed(() => {
    const delta = this.delta();
    return delta === null ? null : this.points() + delta;
  });
  protected readonly amountError = computed(() => {
    const issue = amountIssue(this.amount());
    if (issue !== undefined) {
      return this.touched() ? this.i18n.t(issueMessageKey(issue)) : null;
    }
    return (this.newBalance() as number) < 0 ? this.i18n.t('CONTACTS.POINTS.INSUFFICIENT') : null;
  });
  protected readonly reasonError = computed(() => {
    const issue = lineIssue(this.reason(), this.reasonLimit);
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  });
  protected readonly valid = computed(
    () => this.delta() !== null && (this.newBalance() as number) >= 0 && lineIssue(this.reason(), this.reasonLimit) === undefined,
  );

  constructor() {
    // Every opening starts from an empty form and a new key; what a closed opening still waits for is dropped.
    effect(() => {
      if (this.open()) {
        untracked(() => {
          this.opening++;
          this.doubtful = false;
          this.key = crypto.randomUUID();
          this.direction.set('add');
          this.amount.set('');
          this.reason.set('');
          this.touched.set(false);
          this.busy.set(false);
          this.failure.set(null);
          this.result.set(null);
        });
      }
    });
    // The outcome is announced and takes the focus.
    effect(() => {
      if (this.result() !== null) {
        afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('[data-outcome]')!.focus(), { injector: this.injector });
      }
    });
  }

  protected format(points: number): string {
    return formatNumber(points, this.i18n.language() ?? DEFAULT_LANGUAGE, { maximumFractionDigits: 0 });
  }

  /** The dialog was closed: when the outcome of the last request is not known the page reads the contact again. */
  protected onClosed(): void {
    if (this.doubtful) {
      this.doubtful = false;
      this.uncertain.emit();
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.touched.set(true);
    const delta = this.delta();
    if (!this.valid() || this.busy()) {
      return;
    }
    const reason = this.reason().trim() === '' ? null : this.reason().trim();
    const opening = this.opening;
    this.busy.set(true);
    this.failure.set(null);
    try {
      const done = await this.api.adjustPoints(this.groupId(), this.contactId(), this.code(), delta as number, reason, this.key);
      // The adjustment was applied whatever dialog asked for it: the page always learns the new balance.
      this.adjusted.emit(done);
      if (opening === this.opening) {
        this.result.set(done);
      }
    } catch (error) {
      if (opening === this.opening) {
        this.doubtful = this.isUncertain(error);
        this.failure.set(this.message(error));
      } else if (this.isUncertain(error)) {
        this.uncertain.emit();
      }
    } finally {
      if (opening === this.opening) {
        this.busy.set(false);
      }
    }
  }

  /** No answer or a server error: the adjustment may or may not have been applied. */
  private isUncertain(error: unknown): boolean {
    return error instanceof ApiError && (error.status === 0 || error.status >= 500);
  }

  private message(error: unknown): string {
    if (this.isUncertain(error)) {
      return this.i18n.t('CONTACTS.POINTS.UNCERTAIN');
    }
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      if (error.details.some((detail) => detail.field === 'Idempotency-Key' && detail.issue === 'reused')) {
        return this.i18n.t('CONTACTS.POINTS.KEY_REUSED');
      }
      const issue = error.details.find((detail) => detail.field === 'points' || detail.field === 'code')?.issue;
      const keys: Record<string, string> = {
        insufficient: 'CONTACTS.POINTS.INSUFFICIENT',
        duplicate: 'CONTACTS.POINTS.DUPLICATE',
        advancedCard: 'CONTACTS.POINTS.ADVANCED_CARD',
      };
      return this.i18n.t(issue !== undefined && Object.hasOwn(keys, issue) ? keys[issue] : 'CONTACTS.ERROR.CONCURRENT');
    }
    return failureMessage(this.i18n, error);
  }
}
