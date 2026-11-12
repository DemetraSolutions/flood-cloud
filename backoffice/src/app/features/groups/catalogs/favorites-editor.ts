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
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { ReferencePicker } from '../../users/reference-picker';
import { FavoriteProduct, MAX_FAVORITE_PRODUCTS, ProductFavorites } from './catalog.types';
import { editorErrors } from './catalog-errors';
import { sameList } from './catalog-fields';
import { lookupLoader, selectionNames } from './reference-loaders';

/** Body of a favorites list write (`products` is always the whole new list, in order). */
export interface FavoritesBody {
  name?: string;
  products?: FavoriteProduct[];
}

/** Ids of the products of a list in the order they are shown (by position, those without last). */
export function orderedProductIds(products: readonly FavoriteProduct[]): string[] {
  return products
    .map((product, index) => ({ product, index }))
    .sort(
      (a, b) =>
        (a.product.position ?? Number.POSITIVE_INFINITY) -
          (b.product.position ?? Number.POSITIVE_INFINITY) || a.index - b.index,
    )
    .map(({ product }) => product.productId);
}

/**
 * Form of a list of favorite products: the name and the products in the order they are shown at
 * the till. The order is changed with the up and down buttons of the selection (never by dragging
 * alone). On saving, each product gets as `position` its place in the list (0, 1, 2…).
 */
@Component({
  selector: 'fc-favorites-editor',
  imports: [Button, FormError, FormField, ReferencePicker, TextField, TPipe],
  templateUrl: './favorites-editor.html',
  styleUrl: './catalog-editor.css',
})
export class FavoritesEditor {
  protected readonly i18n = inject(I18nService);
  private readonly reference = inject(ReferenceApi);

  /** Group the list belongs to. */
  readonly groupId = input.required<string>();
  /** The list being changed; `null` to create one. */
  readonly item = input<ProductFavorites | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<FavoritesBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => {
    const item = this.item();
    return {
      name: item?.name ?? '',
      productIds: item === null ? [] : orderedProductIds(item.products),
    };
  });
  protected readonly favoritesForm = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, 200);
    validate(path.productIds, ({ value }) =>
      value().length > MAX_FAVORITE_PRODUCTS ? { kind: 'tooMany' } : undefined,
    );
  });

  protected readonly productLoader = computed(() =>
    lookupLoader(this.reference, this.groupId(), 'products'),
  );
  protected readonly productLabels = selectionNames(
    () => this.item()?.products.map((product) => product.productId) ?? [],
    (ids) => this.reference.lookupNames(this.groupId(), 'products', ids),
  );

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), ['name', 'products']),
  );

  protected readonly body = computed<FavoritesBody>(() => {
    const model = this.model();
    const item = this.item();
    const products = model.productIds.map((productId, position) => ({ productId, position }));
    if (item === null) {
      return { name: model.name.trim(), products };
    }
    const body: FavoritesBody = {};
    if (model.name.trim() !== item.name) {
      body.name = model.name.trim();
    }
    if (!sameList(model.productIds, orderedProductIds(item.products))) {
      body.products = products;
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
    await submit(this.favoritesForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.favoritesForm),
    });
  }
}
