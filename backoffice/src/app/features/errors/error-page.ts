import { Location } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';

/** Kinds of error page; each maps to `ERRORS.<KIND>.TITLE` and `.MESSAGE` in the dictionary. */
export type ErrorPageKind = 'NOT_FOUND' | 'FORBIDDEN' | 'GENERIC';

/**
 * Extracts the optional request id passed in the navigation state
 * (`router.navigate(['/error'], { state: { requestId } })`).
 *
 * @param state Value of `history.state`.
 * @returns The request id, or `null` when absent or not a string.
 */
export function requestIdFromState(state: unknown): string | null {
  const id = (state as { requestId?: unknown } | null)?.requestId;
  return typeof id === 'string' ? id : null;
}

/** Full-page error: not found (404), forbidden (403) or generic, chosen by the route `data.kind`. */
@Component({
  selector: 'fc-error-page',
  imports: [RouterLink, TPipe],
  templateUrl: './error-page.html',
})
export class ErrorPage {
  private readonly i18n = inject(I18nService);
  private readonly kind = inject(ActivatedRoute).snapshot.data['kind'] as ErrorPageKind;

  protected readonly title = computed(() => this.i18n.t(`ERRORS.${this.kind}.TITLE`));
  protected readonly message = computed(() => this.i18n.t(`ERRORS.${this.kind}.MESSAGE`));
  protected readonly requestId = requestIdFromState(inject(Location).getState());
}
