import { Component, computed, inject, input, output, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { integrationFailure } from './integration-errors';
import { IntegrationsApi } from './integrations-api';
import { IntegrationsStatus } from './integrations-status';
import { TshSyncResult } from './integrations.types';

/**
 * Synchronization of the categories of charge of TS Hospitality ("Scarica categorie TSH"): the
 * backend downloads them with the credentials the place has already saved and keeps them as the
 * copy of the place; the page adopts the copy and the new version of the place and lets the user
 * map the product categories to them. It is shown only when TS Hospitality is configured on the
 * platform and the place exists. A failure is shown as it is and never retried by itself.
 */
@Component({
  selector: 'fc-tsh-sync',
  imports: [Button, TPipe],
  templateUrl: './tsh-sync.html',
  styleUrl: './integration-action.css',
})
export class TshSync {
  private readonly status = inject(IntegrationsStatus);
  private readonly api = inject(IntegrationsApi);
  private readonly i18n = inject(I18nService);

  /** Group of the place. */
  readonly groupId = input.required<string>();
  /** The place; `undefined` while it is not created yet. */
  readonly placeId = input.required<string | undefined>();
  /** Version of the place the page is editing. */
  readonly etag = input.required<string | null>();
  /** Why the action cannot run now (unsaved changes); `null` when it can. */
  readonly blockedBy = input<string | null>(null);
  /** Emitted with the copy of the categories and the new version of the place (`null` when it must be read again). */
  readonly synced = output<TshSyncResult>();
  /** Emitted when the place changed meanwhile (`412`). */
  readonly stale = output<void>();

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly done = signal<string | null>(null);

  protected readonly visible = computed(
    () => this.placeId() !== undefined && this.status.available('tsh'),
  );

  constructor() {
    this.status.need();
  }

  protected async sync(): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    this.done.set(null);
    try {
      const result = await this.api.syncTshCategories(
        this.groupId(),
        this.placeId() as string,
        this.etag(),
      );
      this.done.set(this.i18n.t('INTEGRATIONS.TSH.DONE', { count: result.categories.length }));
      this.synced.emit(result);
    } catch (error) {
      const failure = integrationFailure(this.i18n, error);
      if (failure.stale) {
        this.stale.emit();
      }
      this.failure.set(failure.message);
    } finally {
      this.busy.set(false);
    }
  }
}
