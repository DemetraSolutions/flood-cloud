import { Component, computed, effect, inject, input, model, output, untracked } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Icon } from '../../shared/ui/icon/icon';
import { NO_FIELDS, SaleActionRun } from './sale-action-run';
import { saleDialogText } from './sale-dialog-support';
import { movesCreditOf } from './sale-forms';
import { SaleApi } from './sale-api';
import { SaleDetail } from './sale.types';

/** The two actions that only ask for a confirmation. */
export type ConfirmKind = 'cancel' | 'delete';

/**
 * The confirmation of the cancellation of a sale (`POST …/cancellation`) or of the definitive
 * deletion of a quote (`DELETE`): its title names the sale and a line gives its date and total; it
 * says what happens (stock and loyalty card go back as before the sale; the cancellation cannot
 * be revoked, the deletion cannot be undone; the cancellation of a fiscal sale does not issue the
 * fiscal cancellation at the cash desk) and sends the request with the version of the sale in
 * `If-Match`. It is an alert dialog (the focus starts on "Torna indietro", the safe answer),
 * locked while the request runs; after an uncertain outcome, a `412` or a `409` the page reads
 * the sale again and the dialog cannot confirm until that read ends.
 */
@Component({
  selector: 'fc-sale-confirm-dialog',
  imports: [Button, Dialog, FormError, Icon, TPipe],
  templateUrl: './sale-confirm-dialog.html',
  styleUrl: './sale-dialog.css',
})
export class SaleConfirmDialog {
  private readonly api = inject(SaleApi);
  private readonly session = inject(SessionService);

  readonly kind = input.required<ConfirmKind>();
  readonly groupId = input.required<string>();
  readonly sale = input.required<SaleDetail>();
  /** Currency of the amounts. */
  readonly currency = input.required<string>();
  /** The page is reading the sale. */
  readonly refreshing = input.required<boolean>();
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** The action was done. */
  readonly done = output<void>();
  /** The sale has to be read again. */
  readonly reread = output<void>();

  protected readonly run = new SaleActionRun(this.refreshing, () => this.reread.emit());
  protected readonly text = saleDialogText(this.sale, this.currency);
  protected readonly key = computed(() => (this.kind() === 'cancel' ? 'CANCEL' : 'DELETE'));
  /** The cancellation gives credit back and takes top-ups away, and so does the deletion: it needs the permission to write the cards. */
  protected readonly fidelityMissing = computed(
    () => movesCreditOf(this.sale()) && !this.session.can('fidelity:update'),
  );
  /** The cancellation of a fiscal sale does not cancel the receipt at the cash desk: the dialog says so. */
  protected readonly fiscalNote = computed(() => this.kind() === 'cancel' && !this.sale().nonFiscal);

  constructor() {
    effect(() => {
      if (this.open()) {
        untracked(() => this.run.reset());
      }
    });
  }

  protected async confirm(): Promise<void> {
    if (this.run.blocked()) {
      return;
    }
    const sale = this.sale();
    const operation =
      this.kind() === 'cancel'
        ? () =>
            this.api.cancel(this.groupId(), sale.id, sale.version, sale.nonFiscal, {
              date: new Date().toISOString(),
            })
        : () => this.api.remove(this.groupId(), sale.id, sale.version);
    const done = await this.run.run(operation, this.fidelityMissing(), NO_FIELDS);
    if (done) {
      this.open.set(false);
      this.done.emit();
    }
  }
}
