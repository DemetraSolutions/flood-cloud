import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18nService } from '../i18n/i18n.service';
import { TPipe } from '../i18n/t-pipe';
import { SessionService } from '../session/session.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { Icon } from '../../shared/ui/icon/icon';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Header menu of the signed-in user: profile, change password, sign out and sign out of every
 * device (after a confirmation). While a temporary password is pending only the sign-out
 * entries are offered. It is a disclosure button (not an ARIA menu): a list of links and
 * buttons that closes with Escape, an outside click or after choosing an entry.
 */
@Component({
  selector: 'fc-user-menu',
  imports: [ConfirmDialog, Icon, RouterLink, TPipe],
  templateUrl: './user-menu.html',
  styleUrl: './user-menu.css',
  host: {
    '(keydown.escape)': 'onEscape()',
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class UserMenu {
  protected readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly toggle = viewChild.required<ElementRef<HTMLButtonElement>>('toggle');

  protected readonly open = signal(false);
  protected readonly confirmOpen = signal(false);
  protected readonly busy = signal(false);

  protected close(): void {
    this.open.set(false);
  }

  protected onEscape(): void {
    if (this.open()) {
      this.open.set(false);
      this.toggle().nativeElement.focus();
    }
  }

  protected onDocumentClick(event: Event): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  protected async logout(): Promise<void> {
    this.open.set(false);
    await this.session.logout();
  }

  protected askLogoutAll(): void {
    this.open.set(false);
    this.confirmOpen.set(true);
  }

  protected async logoutAll(): Promise<void> {
    this.busy.set(true);
    try {
      await this.session.logoutAll();
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
  }
}
