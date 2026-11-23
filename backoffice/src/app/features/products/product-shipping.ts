import { Component, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { TextField } from '../../shared/ui/text-field/text-field';
import { CoreModel } from './product-model';

/** The shipping tab of a product: width, height and depth in centimetres and weight in kilograms. */
@Component({
  selector: 'fc-product-shipping',
  imports: [FormField, TextField, TPipe],
  templateUrl: './product-shipping.html',
  styleUrl: './product-section.css',
})
export class ProductShipping {
  private readonly i18n = inject(I18nService);

  readonly form = input.required<FieldTree<CoreModel>>();

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }
}
