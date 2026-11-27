import { afterRenderEffect, Component, computed, ElementRef, inject, input, output, signal, WritableSignal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { uniqueId } from '../../shared/ui/unique-id';
import { SaleAmendDialog } from './sale-amend-dialog';
import { SaleConfirmDialog } from './sale-confirm-dialog';
import { movesCreditOf, returnableLines } from './sale-forms';
import { SaleRefundDialog } from './sale-refund-dialog';
import { SaleDetail } from './sale.types';

/** The actions of the page of a sale. */
export type SaleActionKind = 'amend' | 'refund' | 'cancel' | 'delete';

/** Why an action is not available (each has a note under the actions). */
type Reason = 'canceled' | 'returned';

/** The dictionary key of the note of each reason. */
const NOTE_KEYS: Readonly<Record<Reason, string>> = {
  canceled: 'SALES.ACTION.CANCELED_NOTE',
  returned: 'SALES.ACTION.NOTHING_TO_RETURN_NOTE',
};

/**
 * The actions on a sale (decision VS6), for the actions slot of the header of the page: amend and
 * refund (`sales:write`), cancel (`sales:write`) and delete a quote (`sales:delete`, only a non
 * fiscal sale and only while the UM mode is on). The destructive ones (cancel, delete) sit apart
 * from the others. Nothing is shown to a user who cannot do any of them. An action the sale does
 * not allow (a canceled sale cannot be amended, refunded or canceled again; a sale with nothing left to return cannot be refunded) is
 * announced as disabled (`aria-disabled`, so it keeps the focus) and does nothing: the note that
 * gives the reason is linked to it with `aria-describedby`. After an action the page reads the
 * sale again (`changed`) and a toast confirms it; after a cancellation or a refund that leaves
 * nothing to return the focus goes to the note that says so; after the deletion the sale is gone,
 * so `deleted` asks the page to leave it.
 */
@Component({
  selector: 'fc-sale-actions',
  imports: [Button, SaleAmendDialog, SaleConfirmDialog, SaleRefundDialog, TPipe],
  templateUrl: './sale-actions.html',
  styleUrl: './sale-actions.css',
})
export class SaleActions {
  private readonly session = inject(SessionService);
  private readonly mode = inject(NonFiscalMode);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly id = uniqueId('fc-sale-actions');

  readonly groupId = input.required<string>();
  readonly sale = input.required<SaleDetail>();
  /** Currency of the amounts. */
  readonly currency = input.required<string>();
  /** The page is reading the sale. */
  readonly refreshing = input.required<boolean>();
  /** The sale has to be read again. */
  readonly changed = output<void>();
  /** The sale was deleted: the page has nothing left to show. */
  readonly deleted = output<void>();

  protected readonly dialogs: Readonly<Record<SaleActionKind, WritableSignal<boolean>>> = {
    amend: signal(false),
    refund: signal(false),
    cancel: signal(false),
    delete: signal(false),
  };
  /** An action ended and the focus goes to the note that says what is left, as soon as there is one. */
  private readonly focusNote = signal(false);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly canWrite = computed(() => this.session.can('sales:write'));
  protected readonly canDelete = computed(
    () => this.session.can('sales:delete') && this.sale().nonFiscal && this.mode.nonFiscalVisible(),
  );
  /** Why each action is not available, `null` when it is. */
  protected readonly reasons = computed<Readonly<Record<SaleActionKind, Reason | null>>>(() => {
    const sale = this.sale();
    const stopped = sale.canceled ? 'canceled' : null;
    return {
      amend: stopped,
      refund: sale.canceled ? 'canceled' : returnableLines(sale).length === 0 ? 'returned' : null,
      cancel: stopped,
      delete: null,
    };
  });
  /** The notes to show: the distinct reasons of the actions of whoever can write. */
  protected readonly shownNotes = computed<Reason[]>(() => {
    if (!this.canWrite()) {
      return [];
    }
    const { amend, refund, cancel } = this.reasons();
    return [...new Set([amend, refund, cancel])].filter((reason): reason is Reason => reason !== null);
  });
  /** Undoing the sale may give credit back and the user cannot write the loyalty cards. */
  protected readonly fidelityNote = computed(
    () => movesCreditOf(this.sale()) && !this.session.can('fidelity:update'),
  );
  protected readonly fidelityId = `${this.id}-fidelity`;

  constructor() {
    // After the render, so the notes of the new state of the sale are in the page.
    afterRenderEffect(() => {
      if (!this.focusNote()) {
        return;
      }
      // Reading the notes makes the effect run again when they change.
      this.shownNotes();
      const target = this.element.nativeElement.querySelector<HTMLElement>('[data-note]');
      if (target !== null) {
        target.focus();
        this.focusNote.set(false);
      }
    });
  }

  protected noteId(reason: Reason): string {
    return `${this.id}-${reason}`;
  }

  protected noteKey(reason: Reason): string {
    return NOTE_KEYS[reason];
  }

  /** The note that describes an action: the reason it is not available or, for the ones that undo credit, the loyalty permission. */
  protected describedBy(kind: SaleActionKind): string | null {
    const reason = this.reasons()[kind];
    if (reason !== null) {
      return this.noteId(reason);
    }
    return kind !== 'amend' && this.fidelityNote() ? this.fidelityId : null;
  }

  /** Opens the dialog of an action, unless the sale does not allow it. */
  protected start(kind: SaleActionKind): void {
    if (this.reasons()[kind] === null) {
      this.focusNote.set(false);
      this.dialogs[kind].set(true);
    }
  }

  /** An action was done: the toast says so and the page reads the sale again (the sale is gone after a deletion). */
  protected finished(kind: SaleActionKind): void {
    this.toast.success(this.i18n.t(`SALES.ACTION.DONE_${kind.toUpperCase()}`));
    if (kind === 'delete') {
      this.deleted.emit();
    } else {
      this.focusNote.set(kind === 'cancel' || kind === 'refund');
      this.changed.emit();
    }
  }
}
