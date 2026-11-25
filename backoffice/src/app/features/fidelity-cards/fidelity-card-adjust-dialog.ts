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
import { ApiError } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { formatMoney, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { lineIssue } from '../contacts/contact-model';
import { FidelityCardApi } from './fidelity-card-api';
import { CardAdjustment, FIDELITY_CARD_LIMITS, FidelityCard } from './fidelity-card.types';

/** One line of the adjustment: the credit or the points of one collection. */
interface Entry {
  /** `balance` or the id of a collection. */
  readonly id: string;
  readonly label: string;
  direction: 'add' | 'remove';
  amount: string;
}

/**
 * The issue of the amount of one line: empty (nothing to do on this line), or a number above zero
 * and up to a million (whole for points, with two decimals at most for the credit).
 *
 * @param text What the user typed.
 * @param money Whether it is an amount of money.
 */
export function entryIssue(
  text: string,
  money: boolean,
): 'type' | 'incorrect' | 'maximum' | undefined {
  const value = text.trim();
  if (value === '') {
    return undefined;
  }
  if (!(money ? /^\d+(\.\d{1,2})?$/ : /^\d+$/).test(value)) {
    return 'type';
  }
  const number = Number(value);
  if (number === 0) {
    return 'incorrect';
  }
  return number > FIDELITY_CARD_LIMITS.amount ? 'maximum' : undefined;
}

/**
 * Adjusts the credit and the points of a card: for the credit (a prepaid card) and for each points
 * collection of the type, "add" or "take away" a positive amount, with an optional reason (the
 * dialog warns not to put personal data in it) and a preview of the new balances. It is applied at
 * once, without pressing Save. Every opening starts clean with its own `Idempotency-Key`, used for
 * every submission of that opening (`409` `reused` has its own text); a result that arrives for an
 * earlier opening is dropped and the dialog cannot be closed while the request runs. A balance that
 * would go below zero (`409` `insufficient`) is refused before sending and, if the server says it,
 * with its own text. The outcome takes the focus and `adjusted` carries the card.
 */
@Component({
  selector: 'fc-fidelity-card-adjust-dialog',
  imports: [Button, Dialog, FormError, Select, TextField, TPipe],
  templateUrl: './fidelity-card-adjust-dialog.html',
})
export class FidelityCardAdjustDialog {
  private readonly api = inject(FidelityCardApi);
  private readonly i18n = inject(I18nService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private key = crypto.randomUUID();
  private opening = 0;
  private doubtful = false;

  readonly groupId = input.required<string>();
  /** The card, with the balances before the adjustment. */
  readonly card = input.required<FidelityCard>();
  /** The card has a credit (its type is prepaid). */
  readonly prepaid = input.required<boolean>();
  /** Currency of the credit of the group. */
  readonly currency = input('EUR');
  /** The points collections of the type of the card, with their names. */
  readonly collections =
    input.required<readonly { readonly id: string; readonly name: string }[]>();
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** The card as the server answers the adjustment. */
  readonly adjusted = output<FidelityCard>();
  /** The outcome of an adjustment is not known (no answer, a server error or a request still pending): the card and its history have to be read again. Emitted when the dialog is closed. */
  readonly uncertain = output<void>();

  protected readonly entries = signal<Entry[]>([]);
  protected readonly reason = signal('');
  protected readonly touched = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly result = signal<FidelityCard | null>(null);
  protected readonly reasonLimit = FIDELITY_CARD_LIMITS.reason;
  protected readonly directions = computed<SelectOption[]>(() => [
    { value: 'add', label: this.i18n.t('FIDELITY_CARDS.ADJUST.ADD') },
    { value: 'remove', label: this.i18n.t('FIDELITY_CARDS.ADJUST.REMOVE') },
  ]);

  /** For every line: its issue, its signed change and the balance it leads to. */
  protected readonly lines = computed(() =>
    this.entries().map((entry, index) => {
      const money = entry.id === 'balance';
      const issue = entryIssue(entry.amount, money);
      const filled = entry.amount.trim() !== '';
      const delta =
        filled && issue === undefined
          ? Number(entry.amount) * (entry.direction === 'add' ? 1 : -1)
          : null;
      const current = money
        ? (this.card().balance ?? 0)
        : (this.card().points.find((points) => points.collectionId === entry.id)?.points ?? 0);
      const next = delta === null ? null : Math.round((current + delta) * 100) / 100;
      const below = next !== null && next < 0;
      return {
        entry,
        index,
        money,
        delta,
        next,
        error:
          issue !== undefined
            ? this.touched()
              ? this.i18n.t(issueMessageKey(issue))
              : null
            : below
              ? this.i18n.t('FIDELITY_CARDS.ADJUST.INSUFFICIENT')
              : null,
        blocked: issue !== undefined || below,
      };
    }),
  );
  protected readonly reasonError = computed(() => {
    const issue = lineIssue(this.reason(), this.reasonLimit);
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  });
  /** Something to send, and nothing wrong. */
  protected readonly valid = computed(
    () =>
      this.lines().some((line) => line.delta !== null) &&
      !this.lines().some((line) => line.blocked) &&
      this.reasonError() === null,
  );

  constructor() {
    // Every opening starts from an empty form and a new key; what a closed opening still waits for is dropped.
    effect(() => {
      if (this.open()) {
        untracked(() => {
          this.opening++;
          this.doubtful = false;
          this.key = crypto.randomUUID();
          this.entries.set([
            ...(this.prepaid()
              ? [
                  {
                    id: 'balance',
                    label: this.i18n.t('FIDELITY_CARDS.ADJUST.CREDIT'),
                    direction: 'add' as const,
                    amount: '',
                  },
                ]
              : []),
            ...this.collections().map((collection) => ({
              id: collection.id,
              label: this.i18n.t('FIDELITY_CARDS.ADJUST.POINTS_OF', { name: collection.name }),
              direction: 'add' as const,
              amount: '',
            })),
          ]);
          this.reason.set('');
          this.touched.set(false);
          this.busy.set(false);
          this.failure.set(null);
          this.result.set(null);
        });
      }
    });
    // The outcome takes the focus.
    effect(() => {
      if (this.result() !== null) {
        afterNextRender(
          () => this.host.nativeElement.querySelector<HTMLElement>('[data-outcome]')!.focus(),
          { injector: this.injector },
        );
      }
    });
  }

  /** A balance: the credit in the currency of the group, the points as a whole number. */
  protected format(value: number, money = false): string {
    const language = this.i18n.language() ?? DEFAULT_LANGUAGE;
    return money
      ? formatMoney(Math.round(value * 100), this.currency(), language)
      : formatNumber(value, language, { maximumFractionDigits: 0 });
  }

  /** The dialog was closed: when the outcome of the last request is not known the page reads the card again. */
  protected onClosed(): void {
    if (this.doubtful) {
      this.doubtful = false;
      this.uncertain.emit();
    }
  }

  protected setDirection(index: number, direction: string): void {
    this.entries.update((entries) =>
      entries.map((entry, position) =>
        position === index ? { ...entry, direction: direction as Entry['direction'] } : entry,
      ),
    );
  }

  protected setAmount(index: number, amount: string): void {
    this.entries.update((entries) =>
      entries.map((entry, position) => (position === index ? { ...entry, amount } : entry)),
    );
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.touched.set(true);
    if (!this.valid() || this.busy()) {
      return;
    }
    const balance = this.lines().find((line) => line.money && line.delta !== null);
    const points = this.lines().filter((line) => !line.money && line.delta !== null);
    const reason = this.reason().trim();
    const body: CardAdjustment = {
      ...(balance === undefined ? {} : { balanceDelta: balance.delta as number }),
      ...(points.length === 0
        ? {}
        : {
            pointsDeltas: points.map((line) => ({
              collectionId: line.entry.id,
              delta: line.delta as number,
            })),
          }),
      ...(reason === '' ? {} : { reason }),
    };
    const opening = this.opening;
    this.busy.set(true);
    this.failure.set(null);
    try {
      const done = await this.api.adjust(this.groupId(), this.card().id, body, this.key);
      // The adjustment was applied whatever dialog asked for it: the page always learns the new balances.
      this.adjusted.emit(done);
      if (opening === this.opening) {
        this.result.set(done);
      }
    } catch (error) {
      if (this.isUncertain(error)) {
        this.doubtful = true;
      }
      if (opening === this.opening) {
        this.failure.set(this.message(error));
      } else if (this.isUncertain(error)) {
        this.doubtful = false;
        this.uncertain.emit();
      }
    } finally {
      if (opening === this.opening) {
        this.busy.set(false);
      }
    }
  }

  /** No answer, a server error, or an earlier request with the same key still running: the adjustment may or may not have been applied. */
  private isUncertain(error: unknown): boolean {
    return (
      error instanceof ApiError &&
      (error.status === 0 ||
        error.status >= 500 ||
        (error.code === 'CONFLICT' &&
          error.details.some(
            (detail) => detail.field === 'Idempotency-Key' && detail.issue === 'pending',
          )))
    );
  }

  private message(error: unknown): string {
    if (this.isUncertain(error)) {
      return this.i18n.t('FIDELITY_CARDS.ADJUST.UNCERTAIN');
    }
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      if (
        error.details.some(
          (detail) => detail.field === 'Idempotency-Key' && detail.issue === 'reused',
        )
      ) {
        return this.i18n.t('FIDELITY_CARDS.ADJUST.KEY_REUSED');
      }
      return this.i18n.t(
        error.details.some((detail) => detail.issue === 'insufficient')
          ? 'FIDELITY_CARDS.ADJUST.INSUFFICIENT'
          : 'CONTACTS.ERROR.CONCURRENT',
      );
    }
    return failureMessage(this.i18n, error);
  }
}
