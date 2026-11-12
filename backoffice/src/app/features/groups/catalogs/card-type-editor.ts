import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  disabled,
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
import { ReferenceApi, ReferenceItem } from '../../../core/reference/reference-api';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Select, SelectOption } from '../../../shared/ui/select/select';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { ReferencePicker } from '../../users/reference-picker';
import {
  CardType,
  MAX_CARD_COLLECTIONS,
  MAX_CARD_PLACES,
  PointsCollection,
  PrepaidType,
} from './catalog.types';
import { editorErrors } from './catalog-errors';
import { numberIssue, numberOrNull, numberText, sameList } from './catalog-fields';
import { CatalogsApi } from './catalogs-api';
import { PlacePerimeter } from './place-perimeter';
import { placesLoader, selectionNames, staticLoader } from './reference-loaders';

/** Body of a card type write (creation: the whole element; modification: what changed). */
export interface CardTypeBody {
  name?: string;
  enabled?: boolean;
  discountPercentage?: number;
  priceListId?: string | null;
  prepaid?: { enabled: boolean; type?: PrepaidType; taxPercentage: number | null };
  pointsCollect?: { enabled: boolean; collectionIds: string[] };
  placeIds?: string[];
}

/** Price list as the compact read gives it. */
interface PriceListRef {
  readonly id: string;
  readonly name: string;
}

const PREPAID_TYPES: readonly PrepaidType[] = ['multi', 'mono'];

/** Names of the fields of the form (the backend names, for the errors of the server). */
const FIELDS = [
  'name',
  'enabled',
  'discountPercentage',
  'priceListId',
  'prepaid.enabled',
  'prepaid.type',
  'prepaid.taxPercentage',
  'pointsCollect.enabled',
  'pointsCollect.collectionIds',
  'placeIds',
];

/**
 * Form of a loyalty-card type: name, discount, price list, prepaid and points settings, and the
 * stores where the card is valid. An empty list of stores means every store of the group, which a
 * company or store administrator may not choose: for them the selector lists their stores only
 * and at least one is required (the server checks again).
 */
@Component({
  selector: 'fc-card-type-editor',
  imports: [Button, Checkbox, FormError, FormField, ReferencePicker, Select, TextField, TPipe],
  templateUrl: './card-type-editor.html',
  styleUrl: './catalog-editor.css',
})
export class CardTypeEditor {
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(CatalogsApi);
  private readonly reference = inject(ReferenceApi);
  protected readonly perimeter = inject(PlacePerimeter);

  /** Group the card type belongs to. */
  readonly groupId = input.required<string>();
  /** The card type being changed; `null` to create one. */
  readonly item = input<CardType | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** Shows the element for reading only: every field is disabled and nothing can be saved. */
  readonly readOnly = input(false);
  /** The body to send. */
  readonly save = output<CardTypeBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => {
    const item = this.item();
    return {
      name: item?.name ?? '',
      enabled: item?.enabled ?? true,
      discountPercentage: item === null ? '0' : numberText(item.discountPercentage),
      priceListId: item?.priceListId ?? '',
      prepaidEnabled: item?.prepaid.enabled ?? false,
      prepaidType: item === null ? 'multi' : (item.prepaid.type ?? ''),
      prepaidTax: numberText(item?.prepaid.taxPercentage ?? null),
      collectEnabled: item?.pointsCollect.enabled ?? false,
      collectionIds: [...(item?.pointsCollect.collectionIds ?? [])],
      placeIds: [...(item?.placeIds ?? [])],
    };
  });
  protected readonly cardForm = form(this.model, (path) => {
    disabled(path, () => this.readOnly());
    required(path.name);
    maxLength(path.name, 200);
    validate(path.discountPercentage, ({ value }) => {
      const kind = numberIssue(value(), { min: 0, max: 100 });
      return kind === undefined ? undefined : { kind };
    });
    validate(path.prepaidTax, ({ value }) => {
      const kind = numberIssue(value(), { min: 0, max: 100, optional: true });
      return kind === undefined ? undefined : { kind };
    });
    validate(path.collectionIds, ({ value }) =>
      value().length > MAX_CARD_COLLECTIONS ? { kind: 'tooMany' } : undefined,
    );
    validate(path.placeIds, ({ value }) => {
      if (value().length > MAX_CARD_PLACES) {
        return { kind: 'tooMany' };
      }
      return this.perimeter.restricted() && value().length === 0 ? { kind: 'required' } : undefined;
    });
  });

  // Price lists and points collections of the group, for the choices.
  private readonly priceLists = httpResource<ApiData<PriceListRef[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/price-lists`,
  );
  private readonly collections = httpResource<ApiData<PointsCollection[]>>(() =>
    this.api.url(this.groupId(), 'fidelity/points-collections'),
  );
  protected readonly priceListsFailed = computed(() => this.priceLists.error() !== undefined);
  protected readonly collectionsFailed = computed(() => this.collections.error() !== undefined);

  protected readonly priceListOptions = computed<SelectOption[]>(() => {
    const lists = this.priceLists.hasValue() ? this.priceLists.value().data : [];
    const stored = this.item()?.priceListId;
    const options = lists.map((list) => ({ value: list.id, label: list.name }));
    // A price list that is not in the group any more is kept visible, so it can be replaced.
    return stored && !lists.some((list) => list.id === stored)
      ? [{ value: stored, label: this.i18n.t('CATALOG.CARD_TYPES.UNKNOWN_PRICE_LIST') }, ...options]
      : options;
  });
  protected readonly prepaidOptions = computed<SelectOption[]>(() => {
    const options = PREPAID_TYPES.map((value) => ({
      value,
      label: this.i18n.t(`CATALOG.CARD_TYPES.PREPAID.${value.toUpperCase()}`),
    }));
    return this.item()?.prepaid.type == null
      ? [{ value: '', label: this.i18n.t('CATALOG.CARD_TYPES.PREPAID.NONE') }, ...options]
      : options;
  });
  private readonly collectionItems = computed<ReferenceItem[]>(() =>
    (this.collections.hasValue() ? this.collections.value().data : []).map((collection) => ({
      id: collection.id,
      name: collection.name,
    })),
  );
  protected readonly collectionLoader = computed(() => staticLoader(this.collectionItems()));
  protected readonly collectionLabels = computed(() =>
    Object.fromEntries(
      this.collectionItems().map((collection) => [collection.id, collection.name]),
    ),
  );
  protected readonly placeLoader = computed(() => placesLoader(this.reference, this.groupId()));
  protected readonly placeLabels = selectionNames(
    () => this.item()?.placeIds ?? [],
    (ids) => this.reference.placeNames(this.groupId(), ids),
  );

  protected readonly errors = computed(() => editorErrors(this.i18n, this.error(), FIELDS));

  /** The prepaid settings as sent: all of them, so the server needs no merge rule. */
  private prepaidBody(): NonNullable<CardTypeBody['prepaid']> {
    const model = this.model();
    return {
      enabled: model.prepaidEnabled,
      ...(model.prepaidType === '' ? {} : { type: model.prepaidType as PrepaidType }),
      taxPercentage: numberOrNull(model.prepaidTax),
    };
  }

  protected readonly body = computed<CardTypeBody>(() => {
    const model = this.model();
    const item = this.item();
    const values = {
      name: model.name.trim(),
      enabled: model.enabled,
      discountPercentage: Number(model.discountPercentage),
      priceListId: model.priceListId === '' ? null : model.priceListId,
      prepaid: this.prepaidBody(),
      pointsCollect: { enabled: model.collectEnabled, collectionIds: model.collectionIds },
      placeIds: model.placeIds,
    };
    if (item === null) {
      return values;
    }
    const body: CardTypeBody = {};
    if (values.name !== item.name) {
      body.name = values.name;
    }
    if (values.enabled !== item.enabled) {
      body.enabled = values.enabled;
    }
    if (values.discountPercentage !== item.discountPercentage) {
      body.discountPercentage = values.discountPercentage;
    }
    if (values.priceListId !== item.priceListId) {
      body.priceListId = values.priceListId;
    }
    if (
      model.prepaidEnabled !== item.prepaid.enabled ||
      (model.prepaidType === '' ? null : model.prepaidType) !== item.prepaid.type ||
      values.prepaid.taxPercentage !== item.prepaid.taxPercentage
    ) {
      body.prepaid = values.prepaid;
    }
    if (
      model.collectEnabled !== item.pointsCollect.enabled ||
      !sameList(model.collectionIds, item.pointsCollect.collectionIds)
    ) {
      body.pointsCollect = values.pointsCollect;
    }
    if (!sameList(model.placeIds, item.placeIds)) {
      body.placeIds = values.placeIds;
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
    if (this.readOnly()) {
      return;
    }
    await submit(this.cardForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.cardForm),
    });
  }
}
