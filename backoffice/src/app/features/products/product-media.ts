import { Component, computed, inject, input, signal } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { LogoModel, pickedLogo } from '../companies/company-model';
import { LogoSlot } from '../companies/logo-slot';
import { MediaPicker } from '../companies/media-picker';
import { MediaImage } from '../companies/company.types';
import { CoreModel } from './product-model';
import { PRODUCT_LIMITS } from './product.types';

/**
 * The media of a product: the main image and, outside the quick view, the gallery (up to twenty
 * images of the library, each can be removed), the internal file name and the external link
 * (`https` only). An image is chosen from the media library of the group; uploading a new one is
 * offered only when `canUpload` is set (store administrators cannot attach images). The main
 * image alone is shown with `imageOnly`, which the quick view uses.
 */
@Component({
  selector: 'fc-product-media',
  imports: [Button, FormField, LogoSlot, MediaPicker, TextField, TPipe],
  templateUrl: './product-media.html',
  styleUrl: './product-section.css',
})
export class ProductMedia {
  private readonly i18n = inject(I18nService);

  readonly form = input.required<FieldTree<CoreModel>>();
  readonly groupId = input.required<string>();
  /** Whether the picker offers the upload of a new image. */
  readonly canUpload = input(true);
  /** Only the main image (the quick view). */
  readonly imageOnly = input(false);

  protected readonly pickerOpen = signal(false);
  protected readonly limit = PRODUCT_LIMITS.gallery;
  protected readonly readOnly = computed(() => this.form().image().disabled());
  protected readonly gallery = computed(() => this.form().gallery().value());

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected setImage(logo: LogoModel | null): void {
    this.form().image().value.set(logo);
  }

  protected replace(index: number, logo: LogoModel | null): void {
    this.form()
      .gallery()
      .value.update((images) =>
        logo === null ? images.filter((_, position) => position !== index) : images.map((image, position) => (position === index ? logo : image)),
      );
  }

  protected addToGallery(image: MediaImage): void {
    this.form()
      .gallery()
      .value.update((images) => (images.length >= this.limit ? images : [...images, pickedLogo(image)]));
  }
}
