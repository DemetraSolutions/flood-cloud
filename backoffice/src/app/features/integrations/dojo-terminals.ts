import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiData } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { apiErrorOf, integrationFailure } from './integration-errors';
import { IntegrationsApi } from './integrations-api';
import { IntegrationsStatus } from './integrations-status';
import { DojoTerminal } from './integrations.types';

/**
 * The terminals Dojo lists for the account of a place ("Elenco terminali"). The list only shows
 * them: the user copies the `id` of the right one by hand into the Dojo terminal of a device, and
 * nothing is written. The call uses the key the place has already saved, never one typed in the
 * form. It is shown only when Dojo is configured on the platform and the place exists.
 */
@Component({
  selector: 'fc-dojo-terminals',
  imports: [Button, DataTable, RowActionsTemplate, TPipe],
  templateUrl: './dojo-terminals.html',
  styleUrl: './integration-action.css',
})
export class DojoTerminals {
  private readonly status = inject(IntegrationsStatus);
  private readonly api = inject(IntegrationsApi);
  private readonly i18n = inject(I18nService);

  /** Group of the place. */
  readonly groupId = input.required<string>();
  /** The place; `undefined` while it is not created yet. */
  readonly placeId = input.required<string | undefined>();
  /** Why the action cannot run now (unsaved changes, no permission); `null` when it can. */
  readonly blockedBy = input<string | null>(null);

  private readonly requested = signal(false);
  private readonly terminals = httpResource<ApiData<DojoTerminal[]>>(() => {
    const placeId = this.placeId();
    return this.requested() && placeId !== undefined
      ? `${this.api.placeUrl(this.groupId(), placeId)}/integrations/dojo/terminals`
      : undefined;
  });

  /** The id the user copied last, to announce it. */
  protected readonly copied = signal<string | null>(null);
  /** Whether the last copy was refused by the browser. */
  protected readonly copyFailed = signal(false);

  protected readonly visible = computed(
    () => this.placeId() !== undefined && this.status.available('dojo'),
  );
  protected readonly loading = this.terminals.isLoading;
  /** The terminals; read only once {@link loaded} is true. */
  protected readonly rows = computed(
    () => (this.terminals.value() as ApiData<DojoTerminal[]>).data,
  );
  /** Whether the list was read (an empty list is an answer, not a missing one). */
  protected readonly loaded = computed(() => this.terminals.hasValue());
  protected readonly failure = computed(() => {
    const error = this.terminals.error();
    return error === undefined
      ? null
      : integrationFailure(this.i18n, apiErrorOf(error)).message;
  });

  protected readonly rowKey = (row: DojoTerminal): string => row.id;
  protected readonly columns = computed<TableColumn<DojoTerminal>[]>(() => [
    { key: 'id', header: this.i18n.t('INTEGRATIONS.DOJO.ID'), cell: (row) => row.id },
    { key: 'tid', header: this.i18n.t('INTEGRATIONS.DOJO.TID'), cell: (row) => row.tid },
    { key: 'status', header: this.i18n.t('INTEGRATIONS.DOJO.STATUS'), cell: (row) => row.status },
  ]);

  constructor() {
    this.status.need();
  }

  /** Reads the list the first time, and again on every later press. */
  protected load(): void {
    this.copied.set(null);
    this.copyFailed.set(false);
    if (this.requested()) {
      this.terminals.reload();
    } else {
      this.requested.set(true);
    }
  }

  protected async copy(terminal: DojoTerminal): Promise<void> {
    this.copyFailed.set(false);
    try {
      await navigator.clipboard.writeText(terminal.id);
      this.copied.set(terminal.tid);
    } catch (error) {
      console.error(error);
      this.copied.set(null);
      this.copyFailed.set(true);
    }
  }

  protected copyLabel(terminal: DojoTerminal): string {
    return this.i18n.t('INTEGRATIONS.DOJO.COPY_LABEL', { tid: terminal.tid });
  }
}
