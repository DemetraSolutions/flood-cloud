import {
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { TobaccoSyncApi } from './tobacco-sync-api';
import { TobaccoSyncCounts } from './tobacco-sync-counts';
import { syncFailureMessage } from './tobacco-sync-errors';
import { massDisableOf, SyncOptions, SyncOutcome, SyncStatus } from './tobacco-sync.types';

/** Statuses after which the check no longer holds: what was refused has to be checked again (a network error or a `429` can be retried with the same key). */
const REFUSAL_STATUSES: readonly number[] = [403, 409, 413, 422];

/**
 * The window of the synchronization of the tobaccos: the options (move the warehouse, not discountable, points of sale of the availability), the check (`dryRun`) with the counts it predicts, and the synchronization, which is offered only
 * after a successful check that changes something and is asked again with a confirmation that repeats what will happen. Changing an option cancels the check. The synchronization uses the `Idempotency-Key` made when the check succeeds,
 * so a retry after a network error is answered again by the server instead of repeated.
 */
@Component({
  selector: 'fc-tobacco-sync-dialog',
  imports: [Button, Checkbox, ConfirmDialog, Dialog, TobaccoSyncCounts, TPipe],
  templateUrl: './tobacco-sync-dialog.html',
  styleUrl: './tobacco-sync-dialog.css',
})
export class TobaccoSyncDialog {
  private readonly api = inject(TobaccoSyncApi);
  protected readonly i18n = inject(I18nService);

  /** The group. */
  readonly groupId = input.required<string>();
  /** The state of the synchronization (the points of sale to choose from, whether the warehouse is allowed). */
  readonly status = input.required<SyncStatus>();
  /** Whether the window is open (two-way). */
  readonly open = model(false);
  /** Emitted with the counts when the synchronization was applied; the window is then closed. */
  readonly synced = output<SyncOutcome>();

  protected readonly warehouse = signal(true);
  protected readonly noDiscount = signal(true);
  private readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly working = signal<'verify' | 'sync' | null>(null);
  /** The counts of the successful check of the current options; the synchronization is offered only while it holds. */
  protected readonly verified = signal<SyncOutcome | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly confirmOpen = signal(false);
  /** The `Idempotency-Key` of the synchronization of the verified options: the same on every retry of it. */
  private key = '';

  /** The options as they are sent: the warehouse only where it is allowed, the points of sale in the order of the list. */
  private readonly options = computed<SyncOptions>(() => ({
    warehouse: this.status().warehouseAllowed && this.warehouse(),
    noDiscount: this.noDiscount(),
    placeIds: this.status()
      .tobaccoPlaces.filter((place) => this.chosen().has(place.id))
      .map((place) => place.id),
    ...(this.massDisable() === null ? {} : { confirmMassDisable: true as const }),
  }));
  /** The mass deactivation the check reports, `null` when it does not. */
  protected readonly massDisable = computed(() => {
    const outcome = this.verified();
    return outcome === null ? null : massDisableOf(outcome);
  });
  /** Whether the check predicts a change; read only while a check is shown. */
  protected readonly hasChanges = computed(() => {
    const { inserted, updated, disabled, reactivated } = (this.verified() as SyncOutcome).products;
    return inserted + updated + disabled + reactivated > 0;
  });
  protected readonly statusMessage = computed(() => {
    switch (this.working()) {
      case 'verify':
        return this.i18n.t('TOBACCO_SYNC.DIALOG.VERIFYING');
      case 'sync':
        return this.i18n.t('TOBACCO_SYNC.DIALOG.SYNCING');
      default:
        return '';
    }
  });
  protected readonly confirmMessage = computed(() => {
    const outcome = this.verified();
    if (outcome === null) {
      return '';
    }
    const { inserted, updated, disabled, reactivated } = outcome.products;
    const places = this.options().placeIds.length;
    const effect = this.i18n.t('TOBACCO_SYNC.DIALOG.CONFIRM', {
      inserted,
      updated,
      disabled,
      reactivated,
      places:
        places === 0
          ? this.i18n.t('TOBACCO_SYNC.DIALOG.ALL_PLACES')
          : this.i18n.t('TOBACCO_SYNC.DIALOG.SOME_PLACES', { count: places }),
    });
    const mass = this.massDisable();
    return mass === null
      ? effect
      : `${this.i18n.t('TOBACCO_SYNC.DIALOG.MASS_DISABLE', { disable: mass.disable, active: mass.active })} ${effect}`;
  });

  constructor() {
    // Every time the window opens it starts from the defaults, with no check.
    effect(() => {
      if (this.open()) {
        untracked(() => this.reset());
      }
    });
  }

  protected setWarehouse(value: boolean): void {
    this.warehouse.set(value);
    this.optionsChanged();
  }

  protected setNoDiscount(value: boolean): void {
    this.noDiscount.set(value);
    this.optionsChanged();
  }

  protected isChosen(placeId: string): boolean {
    return this.chosen().has(placeId);
  }

  protected setPlace(placeId: string, on: boolean): void {
    this.chosen.update((current) => {
      const next = new Set(current);
      if (on) {
        next.add(placeId);
      } else {
        next.delete(placeId);
      }
      return next;
    });
    this.optionsChanged();
  }

  /** Checks the options with `dryRun`: nothing is written, the answer is what the synchronization would do. */
  protected async verify(): Promise<void> {
    this.working.set('verify');
    this.verified.set(null);
    this.failure.set(null);
    try {
      this.verified.set(
        await this.api.sync(this.groupId(), this.options(), crypto.randomUUID(), true),
      );
      this.key = crypto.randomUUID();
    } catch (error) {
      this.failure.set(syncFailureMessage(this.i18n, error));
    } finally {
      this.working.set(null);
    }
  }

  /** Applies the synchronization of the verified options. */
  protected async apply(): Promise<void> {
    this.working.set('sync');
    this.failure.set(null);
    try {
      const outcome = await this.api.sync(this.groupId(), this.options(), this.key, false);
      this.open.set(false);
      this.synced.emit(outcome);
    } catch (error) {
      this.failure.set(syncFailureMessage(this.i18n, error));
      if (error instanceof ApiError && REFUSAL_STATUSES.includes(error.status)) {
        this.verified.set(null);
      }
    } finally {
      this.working.set(null);
      this.confirmOpen.set(false);
    }
  }

  /** The options changed: the check no longer describes what would be sent. */
  private optionsChanged(): void {
    this.verified.set(null);
    this.failure.set(null);
  }

  private reset(): void {
    this.warehouse.set(true);
    this.noDiscount.set(true);
    this.chosen.set(new Set());
    this.working.set(null);
    this.verified.set(null);
    this.failure.set(null);
    this.confirmOpen.set(false);
  }
}
