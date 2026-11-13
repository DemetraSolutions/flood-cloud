import { httpResource } from '@angular/common/http';
import { computed, Service, signal } from '@angular/core';
import { ApiPage } from '../api/api.types';

/** A country with its areas (provinces). */
export interface Country {
  readonly code: string;
  readonly name: string;
  readonly areas: readonly { readonly code: string; readonly name: string }[];
}

/**
 * The countries and their areas (`GET /v1/countries`, the codes the company addresses accept),
 * read once, when a page first asks for them, and kept for the whole session.
 */
@Service()
export class Countries {
  private readonly wanted = signal(false);
  private readonly resource = httpResource<ApiPage<Country>>(() =>
    this.wanted() ? '/v1/countries' : undefined,
  );

  /** The countries, empty until read. */
  readonly list = computed(() => (this.resource.hasValue() ? this.resource.value().data : []));
  /** Whether the read failed. */
  readonly failed = computed(() => this.resource.error() !== undefined);

  /** Starts reading the countries (once). */
  need(): void {
    this.wanted.set(true);
  }

  /**
   * The areas of a country.
   *
   * @param code ISO alpha-2 code of the country.
   */
  areas(code: string): Country['areas'] {
    return this.list().find((country) => country.code === code)?.areas ?? [];
  }
}
