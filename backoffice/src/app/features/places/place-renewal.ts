import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { placeActionMessage } from './place-errors';
import { PlacesApi } from './places-api';
import { PlaceListItem } from './place.types';

/**
 * The expiration date of a place edited in its row of the list (renewing the license is the most
 * frequent task of platform administrators and dealers): a date field and a "Rinnova" button that
 * writes the license with the version just read (`If-Match`), so a place changed meanwhile is not
 * overwritten (`412`).
 */
@Component({
  selector: 'fc-place-renewal',
  imports: [Button, TextField, TPipe],
  template: `
    <div class="renewal">
      <fc-text-field
        type="date"
        [label]="label()"
        [value]="draft()"
        [disabled]="busy()"
        (valueChange)="draft.set($event)"
      />
      <button
        fc-button
        variant="secondary"
        [loading]="busy()"
        [disabled]="!changed()"
        [attr.aria-label]="label()"
        (click)="renew()"
      >
        {{ 'PLACES.RENEW.ACTION' | t }}
      </button>
    </div>
  `,
  styles: `
    .renewal {
      display: flex;
      align-items: flex-end;
      gap: var(--space-2);
    }
  `,
})
export class PlaceRenewal {
  private readonly api = inject(PlacesApi);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  /** Group of the place. */
  readonly groupId = input.required<string>();
  /** The place of the row. */
  readonly place = input.required<PlaceListItem>();
  /** Emitted after the license was renewed. */
  readonly renewed = output<void>();

  private readonly stored = computed(() => this.place().expirationDate?.slice(0, 10) ?? '');
  protected readonly draft = linkedSignal(() => this.stored());
  protected readonly changed = computed(() => this.draft() !== this.stored());
  protected readonly busy = signal(false);
  protected readonly label = computed(() =>
    this.i18n.t('PLACES.RENEW.LABEL', { name: this.place().name }),
  );

  protected async renew(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.renew(
        this.groupId(),
        this.place().id,
        this.draft() === '' ? null : this.draft(),
      );
    } catch (error) {
      this.toast.error(placeActionMessage(this.i18n, error));
      return;
    } finally {
      this.busy.set(false);
    }
    this.toast.success(this.i18n.t('PLACES.RENEW.DONE', { name: this.place().name }));
    this.renewed.emit();
  }
}
