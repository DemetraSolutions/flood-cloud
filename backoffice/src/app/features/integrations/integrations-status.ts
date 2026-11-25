import { httpResource } from '@angular/common/http';
import { computed, inject, Service, signal } from '@angular/core';
import { ApiData } from '../../core/api/api.types';
import { SessionService } from '../../core/session/session.service';
import { ProviderAvailability, ProviderName } from './integrations.types';

/**
 * Which providers the platform has configured (`GET /v1/integrations`, booleans only). It is read
 * once per session, the first time a component of the module asks for it ({@link need}); until
 * the answer arrives, and when it cannot be read, every provider counts as unavailable and no
 * button of the module is shown.
 */
@Service()
export class IntegrationsStatus {
  private readonly session = inject(SessionService);
  private readonly wanted = signal(false);

  private readonly resource = httpResource<ApiData<ProviderAvailability>>(() =>
    this.wanted() && (this.session.can('places:read') || this.session.can('groups:create'))
      ? '/v1/integrations'
      : undefined,
  );

  /** Whether the availability is being read. */
  readonly loading = this.resource.isLoading;
  /** Whether the availability could not be read. */
  readonly failed = computed(() => this.resource.error() !== undefined);

  /** Asks for the availability to be read (idempotent). */
  need(): void {
    this.wanted.set(true);
  }

  /**
   * Whether a provider is configured on the platform.
   *
   * @param provider The provider.
   * @returns `false` until the answer arrives, and when the answer is not available.
   */
  available(provider: ProviderName): boolean {
    return this.resource.hasValue() && this.resource.value().data[provider] === true;
  }
}
