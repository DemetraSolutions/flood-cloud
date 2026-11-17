import { Component, DestroyRef, inject, signal } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';

/**
 * Dialog that shows the secret of a new key, once. The secret lives only in a signal of this
 * component, from {@link show} until the dialog closes (by any means) or the component is
 * destroyed: it never goes into a resource, a cache, a store, the URL, a log or an error report.
 * Copying is announced in a polite live region inside the dialog.
 */
@Component({
  selector: 'fc-api-key-secret',
  imports: [Button, Checkbox, Dialog, TPipe],
  templateUrl: './api-key-secret.html',
  styleUrl: './api-key-secret.css',
})
export class ApiKeySecret {
  private readonly i18n = inject(I18nService);

  protected readonly open = signal(false);
  protected readonly name = signal('');
  protected readonly secret = signal<string | null>(null);
  protected readonly announcement = signal('');
  /** Whether the user copied the secret or said they saved it: only then "Chiudi" is enabled. */
  protected readonly acknowledged = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.forget());
  }

  /**
   * Opens the dialog with the secret of a key just created.
   *
   * @param name Name of the key, to say which one it is.
   * @param secret The secret, shown here and nowhere else.
   */
  show(name: string, secret: string): void {
    this.name.set(name);
    this.secret.set(secret);
    this.announcement.set('');
    this.acknowledged.set(false);
    this.open.set(true);
  }

  /** The dialog closed, whatever the reason: the secret is forgotten. */
  protected onClosed(): void {
    this.forget();
  }

  protected async copy(): Promise<void> {
    const value = this.secret();
    if (value === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      this.acknowledged.set(true);
      this.announcement.set(this.i18n.t('PUBLIC_API.SECRET.COPIED'));
    } catch {
      // The clipboard can be refused (permissions, insecure context): the user can still select it.
      this.announcement.set(this.i18n.t('PUBLIC_API.SECRET.COPY_FAILED'));
    }
  }

  private forget(): void {
    this.secret.set(null);
    this.name.set('');
    this.announcement.set('');
    this.acknowledged.set(false);
    this.open.set(false);
  }
}
