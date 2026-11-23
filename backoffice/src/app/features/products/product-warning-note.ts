import { Component, computed, inject, input, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ProductWarning, productRoute } from './product.types';

/**
 * The warning of a code, PLU or barcode that other products use too: "also used by …" with a link
 * to each product the user can see and "and N other products" for the rest. It never blocks
 * anything. The names are read from the compact read of the products; when that fails the links
 * show the short ids, and only a warning with the error code is logged.
 */
@Component({
  selector: 'fc-product-warning-note',
  imports: [RouterLink, TPipe],
  templateUrl: './product-warning-note.html',
  styleUrl: './product-section.css',
})
export class ProductWarningNote {
  private readonly reference = inject(ReferenceApi);

  /** Group of the products. */
  readonly groupId = input.required<string>();
  /** The warning; nothing is shown without one. */
  readonly warning = input<ProductWarning | undefined>();

  private readonly names = resource({
    params: () => {
      const warning = this.warning();
      return warning === undefined || warning.productIds.length === 0
        ? undefined
        : { groupId: this.groupId(), ids: warning.productIds };
    },
    loader: async ({ params }) => {
      try {
        return await this.reference.lookupNames(params.groupId, 'products', params.ids);
      } catch (error) {
        // Only the code: the error would carry the URL with the ids.
        console.warn('Cannot read the names of the products that use the same value', error instanceof ApiError ? error.code : 'unexpected');
        return {};
      }
    },
  });

  /** The products to link to: name (or short id) and route. */
  protected readonly links = computed(() => {
    const warning = this.warning();
    const names = this.names.hasValue() ? this.names.value() : {};
    return warning!.productIds.map((id) => ({
      id,
      label: names[id] || `…${id.slice(-6)}`,
      route: productRoute(this.groupId(), 'products', id),
    }));
  });
}
