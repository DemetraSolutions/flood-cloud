import { GroupContext } from '../../core/groups/group-context';
import { RecordGroup } from '../groups/record-group';
import { Component, computed, DOCUMENT, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { GroupFeatures } from '../../core/groups/group-features';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ActionsMenu } from '../../shared/ui/actions-menu/actions-menu';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PlaceState } from './place-state';
import { exportSettings, importSettings, MAX_IMPORT_BYTES } from './settings-transfer';

/**
 * Page of a place (`groups/:groupId/places/:placeId`) and of a new one
 * (`…/places/new`): the header with the name, the state, the one "Salva" and, for platform
 * administrators and dealers, the ⋮ menu that downloads and uploads the settings as JSON; the top
 * tabs (the child routes, each marked with its unsaved changes and errors), the messages of the
 * last save and the confirmation shown before leaving with unsaved changes. The tabs share the
 * {@link PlaceState} this page provides.
 */
@Component({
  selector: 'fc-place-page',
  imports: [
    RecordGroup,
    ActionsMenu,
    Button,
    ConfirmDialog,
    ErrorState,
    FormError,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    StatusBadge,
    TPipe,
  ],
  providers: [PlaceState],
  templateUrl: './place-page.html',
  styleUrl: './place-page.css',
})
export class PlacePage {
  protected readonly state = inject(PlaceState);
  private readonly features = inject(GroupFeatures);
  private readonly groups = inject(GroupContext);
  /** Where the back link leads: the cross-group list without a working group, else the group's. */
  protected readonly backRoute = computed(() => this.groups.listRoute(this.groupId(), 'places'));
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly document = inject(DOCUMENT);

  /** Route parameters; the place is absent on the page of a new one. */
  readonly groupId = input.required<string>();
  readonly placeId = input<string>();

  protected readonly leaveOpen = signal(false);
  private pendingLeave: ((leave: boolean) => void) | null = null;

  constructor() {
    this.state.attach(this.groupId, this.placeId);
    // Platform administrators and dealers: the modules of the group decide which tabs exist.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.features.ensure(groupId));
    });
  }

  /**
   * Asked by the route guard when the user leaves the page: leaving is immediate when nothing is
   * unsaved, otherwise the user confirms in a dialog.
   *
   * @returns `true` to leave, `false` to stay.
   */
  confirmLeave(): boolean | Promise<boolean> {
    if (!this.state.anyDirty()) {
      return true;
    }
    this.leaveOpen.set(true);
    return new Promise<boolean>((resolve) => {
      this.pendingLeave = resolve;
    });
  }

  protected onLeave(): void {
    this.settle(true);
    this.leaveOpen.set(false);
  }

  /** The dialog was closed without confirming (cancel, Esc or the close button): stay. */
  protected onLeaveClosed(): void {
    this.leaveOpen.set(false);
    this.settle(false);
  }

  /** Downloads the settings of the form as a JSON file (the file the old backoffice makes). */
  protected download(): void {
    const url = URL.createObjectURL(
      new Blob([exportSettings(this.state.model())], { type: 'application/json' }),
    );
    const link = this.document.createElement('a');
    link.href = url;
    link.download = 'settings.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Reads the chosen file and puts its values in the form (nothing is saved until the user saves). */
  protected async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = (input.files as FileList)[0];
    input.value = '';
    if (file.size > MAX_IMPORT_BYTES) {
      this.toast.error(this.i18n.t('PLACES.TRANSFER.IMPORT_TOO_LARGE'));
      return;
    }
    const result = importSettings(await file.text());
    if (result === null) {
      this.toast.error(this.i18n.t('PLACES.TRANSFER.IMPORT_INVALID'));
      return;
    }
    this.state.edit('cashSettings', (block) => ({
      ...block,
      f: { ...block.f, ...result.cashSettings },
      workshiftNames:
        result.workshiftNames === null
          ? block.workshiftNames
          : result.workshiftNames.map((name) => ({ name })),
    }));
    this.state.edit('printing', (block) => ({ ...block, f: { ...block.f, ...result.printing } }));
    this.state.edit('tables', (block) => ({
      ...block,
      f: { ...block.f, ...result.tables },
      tipValues: result.tipValues ?? block.tipValues,
    }));
    this.toast.success(
      this.i18n.t('PLACES.TRANSFER.IMPORTED', {
        applied: result.applied,
        ignored: result.ignored,
      }),
    );
  }

  protected errorKey(): string {
    const error = this.state.loadError();
    return error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error);
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
