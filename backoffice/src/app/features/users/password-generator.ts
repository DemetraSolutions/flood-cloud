import { Component, inject, output, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ToastService } from '../../shared/ui/toast/toast.service';

/** Characters of generated passwords: alphanumerics without look-alikes (0/O, 1/l/I). */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // gitleaks:allow (character set, not a secret)

/** Length of generated passwords (the policy asks 12 to 128). */
export const GENERATED_PASSWORD_LENGTH = 16;

/**
 * Generates a random password with `crypto.getRandomValues`. Bytes that would bias the choice
 * are discarded (rejection sampling).
 *
 * @param length Number of characters.
 */
export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  const size = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % size);
  let password = '';
  while (password.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && password.length < length) {
        password += PASSWORD_ALPHABET[byte % size];
      }
    }
  }
  return password;
}

/**
 * "Generate a random password" button. The password is shown once, with a copy button, and
 * emitted so that the form can fill its field. It is never stored or logged.
 */
@Component({
  selector: 'fc-password-generator',
  imports: [Button, TPipe],
  template: `
    <button fc-button variant="secondary" (click)="generate()">
      {{ 'PASSWORD_GENERATOR.GENERATE' | t }}
    </button>
    @if (value(); as password) {
      <p class="shown">
        <span>{{ 'PASSWORD_GENERATOR.SHOWN_ONCE' | t }}</span>
        <output class="value">{{ password }}</output>
        <button fc-button variant="ghost" (click)="copy(password)">
          {{ 'PASSWORD_GENERATOR.COPY' | t }}
        </button>
      </p>
    }
  `,
  styles: `
    .shown {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin: var(--space-2) 0 0;
    }
    .value {
      font-family: var(--font-mono);
      padding: var(--space-1) var(--space-2);
      background: var(--color-surface-muted);
      border-radius: var(--radius-sm);
    }
  `,
})
export class PasswordGenerator {
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  /** Emitted with each generated password. */
  readonly generated = output<string>();

  protected readonly value = signal<string | null>(null);

  protected generate(): void {
    const password = generatePassword();
    this.value.set(password);
    this.generated.emit(password);
  }

  protected async copy(password: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(password);
      this.toast.success(this.i18n.t('PASSWORD_GENERATOR.COPIED'));
    } catch (error) {
      console.warn('Cannot copy to the clipboard', error);
      this.toast.error(this.i18n.t('PASSWORD_GENERATOR.COPY_FAILED'));
    }
  }
}
