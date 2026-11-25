import {
  booleanAttribute,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  resource,
  signal,
} from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { ContactApi } from './contact-api';
import { focusRow, indexAfterRemoval } from './contact-list-focus';
import { durationIssue, ServiceRow } from './contact-model';
import { CONTACT_LIMITS } from './contact.types';

/** Duration a service starts with when it is added. */
export const DEFAULT_DURATION = '01:00';

/** Fewest characters that start the search of a service. */
export const SERVICE_SEARCH_MIN_CHARS = 2;

/**
 * The services a contact has its own duration for (a group with the `services` feature): a row for
 * each with the name of the service, its duration `HH:mm` and "remove"; a service is added by
 * searching the service products. It implements the Signal Forms value control contract (`value`,
 * `disabled`), so it binds to the rows of the form model. The names of the services the contact
 * already has are read once from the compact read of the products.
 */
@Component({
  selector: 'fc-contact-services',
  imports: [Button, SearchCombobox, TextField, TPipe],
  templateUrl: './contact-services.html',
  styleUrl: './contact-section.css',
})
export class ContactServices {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ContactApi);
  private readonly reference = inject(ReferenceApi);
  private readonly i18n = inject(I18nService);
  private readonly injector = inject(Injector);

  /** The rows (two-way). */
  readonly value = model<ServiceRow[]>([]);
  readonly groupId = input.required<string>();
  /** The message of the whole list (too many, a service twice). */
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-contact-services');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = CONTACT_LIMITS.services;
  protected readonly minChars = SERVICE_SEARCH_MIN_CHARS;
  /** The names of the services the user added in this session. */
  private readonly added = signal<Readonly<Record<string, string>>>({});
  /** The ids to read the names of: unchanged by an edit of a duration, so the read is not repeated. */
  private readonly unknownIds = computed(
    () =>
      [
        ...new Set(
          this.value()
            .map((row) => row.productId)
            .filter((id) => !Object.hasOwn(this.added(), id)),
        ),
      ].sort(),
    { equal: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) },
  );
  /** The names of the services the contact had when it was opened. */
  private readonly known = resource({
    params: () => {
      const ids = this.unknownIds();
      return ids.length === 0 ? undefined : { groupId: this.groupId(), ids };
    },
    loader: async ({ params }) => {
      try {
        return await this.reference.lookupNames(params.groupId, 'products', params.ids);
      } catch (error) {
        // Only the code: the error would carry the URL with the ids.
        console.warn(
          'Cannot read the names of the services',
          error instanceof ApiError ? error.code : 'unexpected',
        );
        return {};
      }
    },
  });
  protected readonly rows = computed(() => {
    const read = this.known.hasValue() ? this.known.value() : {};
    return this.value().map((row, index) => {
      const issue = durationIssue(row.duration);
      return {
        row,
        index,
        name: this.added()[row.productId] ?? read[row.productId] ?? `…${row.productId.slice(-6)}`,
        error: issue === undefined ? null : this.i18n.t(issueMessageKey(issue)),
      };
    });
  });
  protected readonly search = (text: string): Promise<readonly SearchOption[]> =>
    this.api.searchServices(this.groupId(), text);

  /** Focuses the first duration (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  /** Adds the chosen service, unless the contact has it already. */
  protected add(option: SearchOption | null): void {
    if (option === null || this.value().some((row) => row.productId === option.value)) {
      return;
    }
    this.added.update((names) => ({ ...names, [option.value]: option.label }));
    this.value.update((rows) => [...rows, { productId: option.value, duration: DEFAULT_DURATION }]);
    focusRow(this.injector, this.host.nativeElement, this.value().length - 1);
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
    focusRow(this.injector, this.host.nativeElement, indexAfterRemoval(index, this.value().length));
  }

  protected setDuration(index: number, duration: string): void {
    this.value.update((rows) =>
      rows.map((row, position) => (position === index ? { ...row, duration } : row)),
    );
  }
}
