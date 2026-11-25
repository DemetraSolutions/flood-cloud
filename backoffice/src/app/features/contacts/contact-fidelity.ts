import {
  booleanAttribute,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { formatNumber } from '../../core/i18n/format';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { focusRow, indexAfterRemoval } from './contact-list-focus';
import { cardCodeIssue } from './contact-model';
import { ContactPointsDialog } from './contact-points-dialog';
import { AdvancedCardInfo, CONTACT_LIMITS, PointsAdjustment } from './contact.types';
import { RouterLink } from '@angular/router';
import { formatMoney } from '../../core/i18n/format';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { fidelityCardRoute } from '../fidelity-cards/fidelity-card.types';

/** A card shown in the list. */
interface CardEntry {
  readonly index: number;
  readonly code: string;
  readonly label: string;
  /** The points of a simple card that is saved, `null` for a new one, an advanced one or one whose code was edited. */
  readonly points: number | null;
  /** The advanced card that has the code, `null` for a simple or a new card. */
  readonly advanced: AdvancedCardInfo | null;
  /** Credit and total points of an advanced card, as text. */
  readonly credit: string;
  readonly totalPoints: string;
  /** Where the card's own page is (only for whoever may read the cards). */
  readonly route: string[] | null;
  readonly error: string | null;
}

/**
 * The loyalty cards of a contact: the codes can be added, edited and removed, and the points are
 * shown but never edited (a sale moves them, or an explicit adjustment: "Adjust points" opens a
 * dialog for each simple card that is saved). A code that is an advanced card shows the card (type,
 * state, credit, total points, link to its page) and no points of the contact. Removing a card that
 * holds points asks for a confirmation that says the balance will be lost; removing an advanced
 * one, that the card keeps its balances and the customer is no longer linked. It implements the Signal Forms value control contract
 * (`value`, `disabled`), so it binds to the `string[]` of the codes in the form model.
 */
@Component({
  selector: 'fc-contact-fidelity',
  imports: [Button, ConfirmDialog, ContactPointsDialog, RouterLink, StatusBadge, TextField, TPipe],
  templateUrl: './contact-fidelity.html',
  styleUrl: './contact-section.css',
})
export class ContactFidelity {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);
  private readonly injector = inject(Injector);

  /** The codes of the cards (two-way). */
  readonly value = model<string[]>([]);
  readonly groupId = input.required<string>();
  /** The contact, `undefined` while it is being created: there is nothing to adjust yet. */
  readonly contactId = input<string>();
  /** The points of each saved simple card by code. */
  readonly points = input<Readonly<Record<string, number>>>({});
  /** The advanced card of each code that has one: their own type, state and balances are shown, no points of the contact, no adjustment. */
  readonly advanced = input<Readonly<Record<string, AdvancedCardInfo>>>({});
  /** The user may open the page of a card. */
  readonly canReadCards = input(false);
  /** Currency of the credit of an advanced card. */
  readonly currency = input('EUR');
  /** The user may adjust the points. */
  readonly canAdjust = input(false);
  /** The message of the whole list (too many, a code twice). */
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  /** A points adjustment succeeded: the card and its new balance. */
  readonly adjusted = output<PointsAdjustment>();
  /** The outcome of an adjustment is not known: the page reads the contact again. */
  readonly uncertain = output<void>();

  protected readonly id = uniqueId('fc-contact-fidelity');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = CONTACT_LIMITS.cards;
  protected readonly entries = computed<CardEntry[]>(() =>
    this.value().map((code, index) => {
      const advanced = Object.hasOwn(this.advanced(), code) ? this.advanced()[code] : null;
      const known = advanced === null && Object.hasOwn(this.points(), code) ? this.points()[code] : null;
      const issue = cardCodeIssue(code, advanced !== null || Object.hasOwn(this.points(), code));
      return {
        index,
        code,
        label: this.i18n.t('CONTACTS.FIDELITY.CODE_N', { number: index + 1 }),
        points: known,
        advanced,
        credit: advanced?.balance == null ? '' : formatMoney(Math.round(advanced.balance * 100), this.currency(), this.i18n.language() ?? DEFAULT_LANGUAGE),
        totalPoints: advanced?.totalPoints == null ? '' : this.format(advanced.totalPoints),
        route: advanced?.cardId != null && this.canReadCards() ? fidelityCardRoute(this.groupId(), advanced.cardId) : null,
        error: issue === undefined ? null : this.i18n.t(issueMessageKey(issue)),
      };
    }),
  );

  // Removing a card that holds points.
  protected readonly removing = signal<CardEntry | null>(null);
  protected readonly removeOpen = signal(false);
  protected readonly removeTitle = computed(() =>
    this.i18n.t('CONTACTS.FIDELITY.REMOVE_TITLE', { code: this.removing()?.code ?? '' }),
  );
  protected readonly removeMessage = computed(() => {
    const removing = this.removing();
    return removing?.advanced == null
      ? this.i18n.t('CONTACTS.FIDELITY.REMOVE_CONFIRM', { points: this.format(removing?.points ?? 0) })
      : this.i18n.t('CONTACTS.FIDELITY.REMOVE_ADVANCED');
  });
  // Adjusting the points of a card.
  private readonly adjustingCode = signal<string | null>(null);
  /** The card being adjusted, with the balance as it is now. */
  protected readonly adjusting = computed(
    () => this.entries().find((entry) => entry.code === this.adjustingCode()) ?? null,
  );
  protected readonly adjustOpen = signal(false);

  /** Focuses the first code (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected format(points: number): string {
    return formatNumber(points, this.i18n.language() ?? DEFAULT_LANGUAGE, { maximumFractionDigits: 0 });
  }

  protected add(): void {
    this.value.update((codes) => [...codes, '']);
    focusRow(this.injector, this.host.nativeElement, this.value().length - 1);
  }

  protected change(index: number, code: string): void {
    this.value.update((codes) => codes.map((current, position) => (position === index ? code : current)));
  }

  /** Removes a card at once, or after the confirmation when it holds points. */
  protected remove(entry: CardEntry): void {
    if (entry.advanced !== null || (entry.points ?? 0) > 0) {
      this.removing.set(entry);
      this.removeOpen.set(true);
    } else {
      this.drop(entry.index);
    }
  }

  protected confirmRemove(): void {
    this.drop((this.removing() as CardEntry).index);
    this.removeOpen.set(false);
  }

  protected adjust(entry: CardEntry): void {
    this.adjustingCode.set(entry.code);
    this.adjustOpen.set(true);
  }

  private drop(index: number): void {
    this.value.update((codes) => codes.filter((_, position) => position !== index));
    focusRow(this.injector, this.host.nativeElement, indexAfterRemoval(index, this.value().length));
  }
}
