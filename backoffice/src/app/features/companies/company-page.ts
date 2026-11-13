import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { GroupContext } from '../../core/groups/group-context';
import { GroupFeatures } from '../../core/groups/group-features';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { CompanyState } from './company-state';

/**
 * Page of a company (`groups/:groupId/companies/:companyId`) and of a new one
 * (`…/companies/new`): the header with the name, the state and "Salva tutto", the navigation
 * between the tabs (the child routes, each marked with its unsaved changes and errors), the
 * messages of the last save and the confirmation shown before leaving with unsaved changes.
 * The tabs share the {@link CompanyState} this page provides.
 */
@Component({
  selector: 'fc-company-page',
  imports: [
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
  providers: [CompanyState],
  templateUrl: './company-page.html',
  styleUrl: './company-page.css',
})
export class CompanyPage {
  protected readonly state = inject(CompanyState);
  private readonly features = inject(GroupFeatures);
  private readonly groups = inject(GroupContext);

  /** Route parameters; the company is absent on the page of a new one. */
  readonly groupId = input.required<string>();
  readonly companyId = input<string>();

  protected readonly leaveOpen = signal(false);
  private pendingLeave: ((leave: boolean) => void) | null = null;

  constructor() {
    this.state.attach(this.groupId, this.companyId);
    // Platform administrators and dealers: the modules of the group decide which tabs exist.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.features.ensure(groupId));
    });
    // The record loaded: its group becomes the working group of the selector.
    effect(() => {
      const company = this.state.company();
      if (company !== null) {
        untracked(() => this.groups.adopt(company.groupId));
      }
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

  protected errorKey(): string {
    const error = this.state.loadError();
    return error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error);
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
