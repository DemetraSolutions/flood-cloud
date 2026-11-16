import { Component, computed, inject, input, output, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { placeActionMessage } from './place-errors';
import { PlacesApi } from './places-api';
import { PlaceListItem } from './place.types';

/** An action on the state of one place of the list. */
export type PlaceAction = 'trash' | 'restore' | 'delete' | 'duplicate';

/** What an action did: which one, and the id of the copy for a duplication. */
export interface PlaceActionResult {
  readonly action: PlaceAction;
  readonly copyId: string | null;
}

/**
 * Hosts the dialogs of the actions on a place of the list: trash, delete for good and duplicate
 * ask for confirmation (restoring does not), then the action runs with the version of the place
 * (`If-Match`) or, for the duplication, with an `Idempotency-Key` that a retry of the same action
 * reuses; the outcome is shown in a toast and `done` tells the page what happened.
 */
@Component({
  selector: 'fc-place-actions',
  imports: [ConfirmDialog],
  template: `
    <fc-confirm-dialog
      [heading]="heading()"
      [message]="message()"
      [confirmLabel]="label()"
      [danger]="action() !== 'duplicate'"
      [busy]="busy()"
      [open]="confirmOpen()"
      (openChange)="confirmOpen.set($event)"
      (confirmed)="execute()"
    />
  `,
})
export class PlaceActions {
  private readonly api = inject(PlacesApi);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  /** The keys of the duplications that have not succeeded yet, by place. */
  private readonly keys = new Map<string, IdempotencyKey>();

  /** Group of the places. */
  readonly groupId = input.required<string>();
  /** Emitted after an action succeeded. */
  readonly done = output<PlaceActionResult>();

  protected readonly action = signal<PlaceAction>('trash');
  private readonly target = signal<PlaceListItem | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirmOpen = signal(false);

  private readonly key = computed(() => this.action().toUpperCase());
  protected readonly heading = computed(() => this.i18n.t(`PLACES.ACTION.TITLE.${this.key()}`));
  protected readonly label = computed(() => this.i18n.t(`PLACES.ACTION.LABEL.${this.key()}`));
  protected readonly message = computed(() =>
    this.i18n.t(`PLACES.ACTION.CONFIRM.${this.key()}`, { name: this.target()?.name ?? '' }),
  );

  /** Starts an action on a place: it asks for confirmation, except to restore. */
  run(action: PlaceAction, place: PlaceListItem): void {
    this.action.set(action);
    this.target.set(place);
    if (action === 'restore') {
      void this.execute();
    } else {
      this.confirmOpen.set(true);
    }
  }

  protected async execute(): Promise<void> {
    const place = this.target() as PlaceListItem;
    const action = this.action();
    this.busy.set(true);
    let copyId: string | null = null;
    try {
      if (action === 'duplicate') {
        copyId = await this.duplicate(place);
      } else {
        await this.api[action === 'delete' ? 'remove' : action](this.groupId(), place.id);
      }
    } catch (error) {
      this.toast.error(placeActionMessage(this.i18n, error));
      return;
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
    this.toast.success(this.i18n.t(`PLACES.ACTION.DONE.${this.key()}`, { name: place.name }));
    this.done.emit({ action, copyId });
  }

  private async duplicate(place: PlaceListItem): Promise<string> {
    const keys = this.keys.get(place.id) ?? new IdempotencyKey();
    this.keys.set(place.id, keys);
    const copy = await this.api.duplicate(this.groupId(), place.id, keys.forBody(null));
    this.keys.delete(place.id);
    return copy.place.id;
  }
}
