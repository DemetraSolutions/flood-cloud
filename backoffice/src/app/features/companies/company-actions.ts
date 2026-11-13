import { Component, computed, inject, input, output, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CompaniesApi } from './companies-api';
import { companyActionMessage } from './company-errors';
import { CompanyListItem } from './company.types';

/** An action on the state of one company of the list. */
export type CompanyAction = 'trash' | 'restore' | 'delete';

/**
 * Hosts the dialogs of the actions on a company of the list: trash and delete for good ask for
 * confirmation (restoring does not), then the action runs with the version of the company
 * (`If-Match`), the outcome is shown in a toast and `done` tells the page to reload.
 */
@Component({
  selector: 'fc-company-actions',
  imports: [ConfirmDialog],
  template: `
    <fc-confirm-dialog
      [heading]="heading()"
      [message]="message()"
      [confirmLabel]="label()"
      [danger]="true"
      [busy]="busy()"
      [open]="confirmOpen()"
      (openChange)="confirmOpen.set($event)"
      (confirmed)="execute()"
    />
  `,
})
export class CompanyActions {
  private readonly api = inject(CompaniesApi);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  /** Group of the companies. */
  readonly groupId = input.required<string>();
  /** Emitted after an action succeeded, with the action that ran. */
  readonly done = output<CompanyAction>();

  private readonly action = signal<CompanyAction>('trash');
  private readonly target = signal<CompanyListItem | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirmOpen = signal(false);

  private readonly key = computed(() => this.action().toUpperCase());
  protected readonly heading = computed(() => this.i18n.t(`COMPANIES.ACTION.TITLE.${this.key()}`));
  protected readonly label = computed(() => this.i18n.t(`COMPANIES.ACTION.LABEL.${this.key()}`));
  protected readonly message = computed(() =>
    this.i18n.t(`COMPANIES.ACTION.CONFIRM.${this.key()}`, { name: this.target()?.name ?? '' }),
  );

  /** Starts an action on a company: it asks for confirmation, except to restore. */
  run(action: CompanyAction, company: CompanyListItem): void {
    this.action.set(action);
    this.target.set(company);
    if (action === 'restore') {
      void this.execute();
    } else {
      this.confirmOpen.set(true);
    }
  }

  protected async execute(): Promise<void> {
    const company = this.target() as CompanyListItem;
    const action = this.action();
    this.busy.set(true);
    try {
      await this.api[action === 'delete' ? 'remove' : action](this.groupId(), company.id);
    } catch (error) {
      this.toast.error(companyActionMessage(this.i18n, error));
      return;
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
    this.toast.success(this.i18n.t(`COMPANIES.ACTION.DONE.${this.key()}`, { name: company.name }));
    this.done.emit(action);
  }
}
