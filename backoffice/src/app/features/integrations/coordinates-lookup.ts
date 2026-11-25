import { Component, computed, inject, input, output, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { integrationFailure } from './integration-errors';
import { IntegrationsApi } from './integrations-api';
import { IntegrationsStatus } from './integrations-status';
import { ADDRESS_FIELDS, AddressField, Coordinates, GeocodingAddress } from './integrations.types';

/**
 * "Calcola coordinate": asks the backend for the latitude and longitude of the address in the
 * form. When one of the five fields of the address is empty it lists the missing ones and calls
 * nothing. The coordinates are only handed to the page (`located`), which puts them in the form:
 * the user saves them. It is shown only when the geocoding is configured on the platform and the
 * place exists; no key of any map service is ever in the browser.
 */
@Component({
  selector: 'fc-coordinates-lookup',
  imports: [Button, TPipe],
  templateUrl: './coordinates-lookup.html',
  styleUrl: './integration-action.css',
})
export class CoordinatesLookup {
  private readonly status = inject(IntegrationsStatus);
  private readonly api = inject(IntegrationsApi);
  private readonly i18n = inject(I18nService);

  /** Group of the place. */
  readonly groupId = input.required<string>();
  /** The place; `undefined` while it is not created yet. */
  readonly placeId = input.required<string | undefined>();
  /** The address as the form holds it now. */
  readonly address = input.required<GeocodingAddress>();
  /** Why the action cannot run now; `null` when it can. */
  readonly blockedBy = input<string | null>(null);
  /** Emitted with the coordinates found. */
  readonly located = output<Coordinates>();

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly warning = signal<string | null>(null);
  protected readonly done = signal(false);

  protected readonly visible = computed(
    () => this.placeId() !== undefined && this.status.available('geocoding'),
  );

  constructor() {
    this.status.need();
  }

  protected async locate(): Promise<void> {
    this.failure.set(null);
    this.warning.set(null);
    this.done.set(false);
    const address = this.address();
    const missing = ADDRESS_FIELDS.filter((field) => address[field].trim() === '');
    if (missing.length > 0) {
      this.warning.set(
        this.i18n.t('INTEGRATIONS.COORDINATES.MISSING', {
          fields: missing.map((field) => this.fieldLabel(field)).join(', '),
        }),
      );
      return;
    }
    this.busy.set(true);
    try {
      const found = await this.api.geocode(this.groupId(), this.placeId() as string, {
        street: address.street.trim(),
        postcode: address.postcode.trim(),
        city: address.city.trim(),
        province: address.province.trim(),
        country: address.country.trim(),
      });
      this.located.emit(found);
      this.done.set(true);
    } catch (error) {
      this.failure.set(this.failureOf(error));
    } finally {
      this.busy.set(false);
    }
  }

  private fieldLabel(field: AddressField): string {
    return this.i18n.t(`INTEGRATIONS.COORDINATES.FIELD.${field.toUpperCase()}`);
  }

  private failureOf(error: unknown): string {
    if (
      error instanceof ApiError &&
      error.code === 'VALIDATION_ERROR' &&
      error.details.some((detail) => detail.field === 'street' && detail.issue === 'incorrect')
    ) {
      return this.i18n.t('INTEGRATIONS.COORDINATES.NOT_FOUND');
    }
    return integrationFailure(this.i18n, error).message;
  }
}
