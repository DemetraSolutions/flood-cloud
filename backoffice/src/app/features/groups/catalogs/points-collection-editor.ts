import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  form,
  FormField,
  maxLength,
  ReadonlyFieldTree,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import { ApiData } from '../../../core/api/api.types';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Select, SelectOption } from '../../../shared/ui/select/select';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { PointsCollection, PrizeCatalogue } from './catalog.types';
import { editorErrors } from './catalog-errors';
import {
  dateIssue,
  datesReversed,
  fromLocalInput,
  numberIssue,
  numberOrNull,
  numberText,
  toLocalInput,
} from './catalog-fields';
import { CatalogsApi } from './catalogs-api';

/** Body of a points collection write (creation: the filled fields; modification: what changed). */
export interface PointsCollectionBody {
  name?: string;
  enabled?: boolean;
  pointConversion?: number | null;
  minAmount?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  pointsExpirationDate?: string | null;
  prizeCatalogueId?: string | null;
}

const DATES = ['dateFrom', 'dateTo', 'pointsExpirationDate'] as const;
const NUMBERS = ['pointConversion', 'minAmount'] as const;

/**
 * Form of a points collection: how much money earns a point, the minimum amount, when it is
 * valid and when the points expire, and the prize catalogue the points can be spent on. The dates
 * are chosen in the time zone of the browser and sent as ISO 8601 (UTC); a stored date that the
 * input cannot show is left as it is unless the user fills the field.
 */
@Component({
  selector: 'fc-points-collection-editor',
  imports: [Button, Checkbox, FormError, FormField, Select, TextField, TPipe],
  templateUrl: './points-collection-editor.html',
  styleUrl: './catalog-editor.css',
})
export class PointsCollectionEditor {
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(CatalogsApi);

  /** Group the collection belongs to. */
  readonly groupId = input.required<string>();
  /** The collection being changed; `null` to create one. */
  readonly item = input<PointsCollection | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<PointsCollectionBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => {
    const item = this.item();
    return {
      name: item?.name ?? '',
      enabled: item?.enabled ?? true,
      pointConversion: numberText(item?.pointConversion ?? null),
      minAmount: numberText(item?.minAmount ?? null),
      dateFrom: toLocalInput(item?.dateFrom ?? null),
      dateTo: toLocalInput(item?.dateTo ?? null),
      pointsExpirationDate: toLocalInput(item?.pointsExpirationDate ?? null),
      prizeCatalogueId: item?.prizeCatalogueId ?? '',
    };
  });
  protected readonly collectionForm = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, 200);
    for (const field of [path.pointConversion, path.minAmount]) {
      validate(field, ({ value }) => {
        const kind = numberIssue(value(), { min: 0, optional: true });
        return kind === undefined ? undefined : { kind };
      });
    }
    for (const key of DATES) {
      validate(path[key], ({ value }) => {
        const kind = dateIssue(value());
        return kind === undefined ? undefined : { kind };
      });
    }
    validate(path.dateTo, ({ value, valueOf }) =>
      datesReversed(valueOf(path.dateFrom), value()) ? { kind: 'incorrect' } : undefined,
    );
  });

  private readonly catalogues = httpResource<ApiData<PrizeCatalogue[]>>(() =>
    this.api.url(this.groupId(), 'fidelity/prize-catalogues'),
  );
  protected readonly cataloguesFailed = computed(() => this.catalogues.error() !== undefined);
  protected readonly catalogueOptions = computed<SelectOption[]>(() => {
    const list = this.catalogues.hasValue() ? this.catalogues.value().data : [];
    const stored = this.item()?.prizeCatalogueId;
    const options = list.map((catalogue) => ({ value: catalogue.id, label: catalogue.name }));
    // A catalogue that is not in the group any more is kept visible, so it can be replaced.
    return stored && !list.some((catalogue) => catalogue.id === stored)
      ? [
          { value: stored, label: this.i18n.t('CATALOG.POINTS_COLLECTIONS.UNKNOWN_CATALOGUE') },
          ...options,
        ]
      : options;
  });

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), [
      'name',
      'enabled',
      'pointConversion',
      'minAmount',
      ...DATES,
      'prizeCatalogueId',
    ]),
  );

  protected readonly body = computed<PointsCollectionBody>(() => {
    const model = this.model();
    const item = this.item();
    const values = {
      name: model.name.trim(),
      enabled: model.enabled,
      pointConversion: numberOrNull(model.pointConversion),
      minAmount: numberOrNull(model.minAmount),
      dateFrom: fromLocalInput(model.dateFrom),
      dateTo: fromLocalInput(model.dateTo),
      pointsExpirationDate: fromLocalInput(model.pointsExpirationDate),
      prizeCatalogueId: model.prizeCatalogueId === '' ? null : model.prizeCatalogueId,
    };
    if (item === null) {
      return {
        name: values.name,
        enabled: values.enabled,
        ...Object.fromEntries(
          [...NUMBERS, ...DATES, 'prizeCatalogueId' as const]
            .filter((key) => values[key] !== null)
            .map((key) => [key, values[key]]),
        ),
      };
    }
    const body: PointsCollectionBody = {};
    if (values.name !== item.name) {
      body.name = values.name;
    }
    if (values.enabled !== item.enabled) {
      body.enabled = values.enabled;
    }
    for (const key of NUMBERS) {
      if (values[key] !== item[key]) {
        body[key] = values[key];
      }
    }
    for (const key of DATES) {
      // Compared as typed: a stored value the input cannot show stays untouched.
      if (model[key] !== toLocalInput(item[key])) {
        body[key] = values[key];
      }
    }
    if (values.prizeCatalogueId !== item.prizeCatalogueId) {
      body.prizeCatalogueId = values.prizeCatalogueId;
    }
    return body;
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.collectionForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.collectionForm),
    });
  }
}
