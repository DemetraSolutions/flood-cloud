import { Component, computed, inject, output, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupStateAction, GroupsApi } from './groups-api';

/** The group an action applies to. */
export interface GroupTarget {
  readonly id: string;
  readonly name: string;
}

/**
 * Hosts the confirmation of the state actions of a group (suspend, reactivate, trash, restore):
 * place it once in a page and call {@link run}. It explains the effect (all the users of the
 * group are signed out), calls the API, tells the outcome in a toast and emits `done` so that
 * the page reloads. A `409` (the group is already in that state) is reported and also reloads.
 */
@Component({
  selector: 'fc-group-actions',
  imports: [ConfirmDialog],
  template: `<fc-confirm-dialog
    [heading]="heading()"
    [message]="message()"
    [confirmLabel]="confirmLabel()"
    [danger]="danger()"
    [busy]="busy()"
    [open]="open()"
    (openChange)="open.set($event)"
    (confirmed)="confirm()"
  />`,
})
export class GroupActions {
  private readonly api = inject(GroupsApi);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  /** Emitted after the state changed (or turned out to be already so), with the action. */
  readonly done = output<GroupStateAction>();

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  private readonly action = signal<GroupStateAction>('suspend');
  private readonly target = signal<GroupTarget>({ id: '', name: '' });

  private readonly key = computed(() => this.action().toUpperCase());
  protected readonly heading = computed(() => this.i18n.t(`GROUP_ACTIONS.TITLE.${this.key()}`));
  protected readonly message = computed(() =>
    this.i18n.t(`GROUP_ACTIONS.CONFIRM.${this.key()}`, { name: this.target().name }),
  );
  protected readonly confirmLabel = computed(() =>
    this.i18n.t(`GROUP_ACTIONS.LABEL.${this.key()}`),
  );
  protected readonly danger = computed(
    () => this.action() === 'suspend' || this.action() === 'trash',
  );

  /** Opens the confirmation of an action on a group. */
  run(action: GroupStateAction, group: GroupTarget): void {
    this.action.set(action);
    this.target.set(group);
    this.open.set(true);
  }

  protected async confirm(): Promise<void> {
    const action = this.action();
    this.busy.set(true);
    try {
      await this.api.changeState(this.target().id, action);
      this.toast.success(this.i18n.t(`GROUP_ACTIONS.DONE.${this.key()}`));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        this.toast.info(this.i18n.t(`GROUP_ACTIONS.ALREADY.${this.key()}`));
      } else {
        this.busy.set(false);
        this.open.set(false);
        this.toast.error(failureMessage(this.i18n, error));
        return;
      }
    }
    this.busy.set(false);
    this.open.set(false);
    this.done.emit(action);
  }
}
