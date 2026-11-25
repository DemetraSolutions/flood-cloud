import { Component, computed, inject, input, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ContactApi } from './contact-api';
import { ContactWarning, contactRoute } from './contact.types';

/**
 * The warning of a code, tax code or VAT number that other contacts use too: "also used by …" with
 * a link to each contact (at most five) and "and N others" for the rest. It never blocks anything.
 * The links are named with one search by the value (the display names of the contacts it returns);
 * a contact the search does not return is "Contact 1", "Contact 2"… and an id is never shown. When
 * the search fails only the error code is logged.
 */
@Component({
  selector: 'fc-contact-warning-note',
  imports: [RouterLink, TPipe],
  templateUrl: './contact-warning-note.html',
  styleUrl: './contact-section.css',
})
export class ContactWarningNote {
  private readonly api = inject(ContactApi);
  private readonly i18n = inject(I18nService);

  /** Group of the contacts. */
  readonly groupId = input.required<string>();
  /** The warning; nothing is shown without one. */
  readonly warning = input<ContactWarning | undefined>();

  private readonly names = resource({
    params: () => {
      const warning = this.warning();
      return warning?.value === undefined || warning.value === '' || warning.contactIds.length === 0
        ? undefined
        : { groupId: this.groupId(), value: warning.value, ids: warning.contactIds };
    },
    loader: async ({ params }) => {
      try {
        return await this.api.namesUsing(params.groupId, params.value, params.ids);
      } catch (error) {
        // Only the code: the error would carry the URL with the value.
        console.warn('Cannot read the names of the contacts that use the same value', error instanceof ApiError ? error.code : 'unexpected');
        return {};
      }
    },
  });

  /** The contacts to link to: name (or "Contact N") and route. */
  protected readonly links = computed(() => {
    const names = this.names.hasValue() ? this.names.value() : {};
    return (this.warning()?.contactIds ?? []).map((id, index) => ({
      id,
      label: names[id] ?? this.i18n.t('CONTACTS.WARNING.CONTACT_N', { number: index + 1 }),
      route: contactRoute(this.groupId(), id),
    }));
  });
}
