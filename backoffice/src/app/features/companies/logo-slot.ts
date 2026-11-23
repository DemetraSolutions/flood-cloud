import { httpResource } from '@angular/common/http';
import {
  booleanAttribute,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ApiData } from '../../core/api/api.types';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { LogoModel, pickedLogo } from './company-model';
import { MediaImage } from './company.types';
import { MediaApi } from './media-upload';
import { MediaPicker } from './media-picker';

const OBJECT_ID = /^[0-9a-f]{24}$/;

/**
 * One logo of the customer app (light or dark): a preview, "Scegli" (opens the picker of the
 * media library) and "Rimuovi". The preview of a stored logo is read from the library by the id
 * of its descriptor; when the library has no such image only the file name is shown.
 */
@Component({
  selector: 'fc-logo-slot',
  imports: [Button, MediaPicker, TPipe],
  templateUrl: './logo-slot.html',
  styleUrl: './logo-slot.css',
})
export class LogoSlot {
  private readonly api = inject(MediaApi);

  /** Name of the slot (already translated). */
  readonly label = input.required<string>();
  /** The logo, `null` for none. */
  readonly logo = input.required<LogoModel | null>();
  /** Group of the library. */
  readonly groupId = input.required<string>();
  /** Company the logo belongs to. */
  readonly companyId = input<string>();
  /** Whether the picker offers the upload of a new image. */
  readonly canUpload = input(true);
  /** Disables the buttons. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted with the new logo (`null` to remove it). */
  readonly logoChange = output<LogoModel | null>();

  protected readonly pickerOpen = signal(false);

  private readonly stored = httpResource<ApiData<MediaImage>>(() => {
    const descriptor = this.logo()?.descriptor;
    return descriptor !== undefined && descriptor !== null && OBJECT_ID.test(descriptor._id)
      ? `${this.api.imagesUrl(this.groupId())}/${descriptor._id}`
      : undefined;
  });

  /** The image to show: the one just picked, or the stored one read from the library. */
  protected readonly preview = computed(() => {
    const logo = this.logo();
    if (logo === null) {
      return null;
    }
    const stored = this.stored.hasValue() ? this.stored.value().data.urls?.s : null;
    const url = logo.previewUrl ?? stored ?? null;
    return url === null ? null : { url, label: logo.label };
  });

  protected choose(image: MediaImage): void {
    this.logoChange.emit(pickedLogo(image));
  }

  protected remove(): void {
    this.logoChange.emit(null);
  }
}
