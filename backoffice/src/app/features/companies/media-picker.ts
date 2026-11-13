import { httpResource } from '@angular/common/http';
import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import { MediaImage } from './company.types';
import { checkUpload, MediaApi, UPLOAD_TYPES, uploadErrorMessage } from './media-upload';

/** Images shown per page of the picker. */
export const PICKER_PAGE_SIZE = 12;

/**
 * Picker of an image of the media library of a group, in a dialog: search, thumbnails, cursor
 * pagination and upload of a new image (JPEG, PNG or WebP up to 10 MB, checked here only to
 * spare the round trip). Choosing an image emits `picked` and closes the dialog. The images are
 * read only while the dialog is open.
 */
@Component({
  selector: 'fc-media-picker',
  imports: [Button, Dialog, ErrorState, TextField, TPipe],
  templateUrl: './media-picker.html',
  styleUrl: './media-picker.css',
})
export class MediaPicker {
  private readonly api = inject(MediaApi);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  private readonly chooser = viewChild.required<ElementRef<HTMLInputElement>>('chooser');
  protected readonly i18n = inject(I18nService);

  /** Group of the library. */
  readonly groupId = input.required<string>();
  /** Company the page is about: uploads belong to it (a company administrator must give it). */
  readonly companyId = input<string>();
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** Emitted with the image the user chose. */
  readonly picked = output<MediaImage>();

  protected readonly accept = UPLOAD_TYPES.join(',');
  protected readonly searchText = signal('');
  protected readonly query = signal('');
  protected readonly cursor = signal<string | null>(null);
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly uploading = signal(false);
  protected readonly problem = signal<string | null>(null);

  protected readonly images = httpResource<ApiPage<MediaImage>>(() => {
    if (!this.open()) {
      return undefined;
    }
    const params: Record<string, string | number> = { limit: PICKER_PAGE_SIZE, sort: '-createdAt' };
    if (this.query() !== '') {
      params['q'] = this.query();
    }
    const cursor = this.cursor();
    if (cursor !== null) {
      params['cursor'] = cursor;
    }
    return { url: this.api.imagesUrl(this.groupId()), params };
  });

  protected readonly rows = computed(() =>
    this.images.hasValue() ? this.images.value().data : [],
  );
  protected readonly nextCursor = computed(() =>
    this.images.hasValue() ? this.images.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.images.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => {
      this.query.set(text.trim());
      this.cursorStack.set([]);
      this.cursor.set(null);
    });
  }

  protected next(): void {
    this.cursorStack.update((stack) => [...stack, this.cursor()]);
    this.cursor.set(this.nextCursor());
  }

  protected previous(): void {
    const stack = this.cursorStack();
    this.cursorStack.set(stack.slice(0, -1));
    this.cursor.set(stack[stack.length - 1]);
  }

  protected choose(image: MediaImage): void {
    this.picked.emit(image);
    this.open.set(false);
  }

  protected browse(): void {
    this.chooser().nativeElement.click();
  }

  protected async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.item(0) ?? null;
    input.value = '';
    if (file === null) {
      return;
    }
    this.problem.set(null);
    const wrong = checkUpload(file);
    if (wrong !== null) {
      this.problem.set(
        this.i18n.t(wrong === 'type' ? 'COMPANIES.MEDIA.FILE_TYPE' : 'COMPANIES.MEDIA.FILE_SIZE'),
      );
      return;
    }
    this.uploading.set(true);
    try {
      await this.api.upload(this.groupId(), file, this.companyId());
    } catch (error) {
      this.problem.set(uploadErrorMessage(this.i18n, error));
      return;
    } finally {
      this.uploading.set(false);
    }
    this.toast.success(this.i18n.t('COMPANIES.MEDIA.UPLOADED'));
    this.searchText.set('');
    this.query.set('');
    this.cursorStack.set([]);
    this.cursor.set(null);
    this.images.reload();
  }
}
