import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { MediaImage } from './company.types';

/** Image types the server accepts (it recognises them from the bytes, not from the name). */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Largest file the server accepts, in bytes (10 MB). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Checks a file before sending it, for the user's convenience only: the server checks the
 * bytes and decides.
 *
 * @param file The chosen file.
 * @returns What is wrong with it, or `null` when it can be sent.
 */
export function checkUpload(file: File): 'type' | 'size' | null {
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) {
    return 'type';
  }
  return file.size > UPLOAD_MAX_BYTES ? 'size' : null;
}

/**
 * User message for a failed upload: the statuses the media route can answer have their own
 * text (`413`, `415`, `422`, `429` with the wait, `503`), everything else uses the central
 * mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function uploadErrorMessage(i18n: I18nService, error: unknown): string {
  if (!(error instanceof ApiError)) {
    return failureMessage(i18n, error);
  }
  switch (error.status) {
    case 413:
      return i18n.t('COMPANIES.MEDIA.UPLOAD_ERROR.TOO_LARGE');
    case 415:
      return i18n.t('COMPANIES.MEDIA.UPLOAD_ERROR.UNSUPPORTED');
    case 422:
      return i18n.t('COMPANIES.MEDIA.UPLOAD_ERROR.INVALID');
    case 429:
      return error.retryAfterSeconds === null
        ? i18n.t('COMPANIES.MEDIA.UPLOAD_ERROR.RATE_LIMITED')
        : i18n.t('COMPANIES.MEDIA.UPLOAD_ERROR.RATE_LIMITED_WAIT', {
            seconds: error.retryAfterSeconds,
          });
    case 503:
      return i18n.t('COMPANIES.MEDIA.UPLOAD_ERROR.UNAVAILABLE');
    default:
      return failureMessage(i18n, error);
  }
}

/** Uploads to the media library of a group (`POST /v1/groups/{groupId}/media/images`). */
@Service()
export class MediaApi {
  private readonly http = inject(HttpClient);

  /** URL of the images of a group. */
  imagesUrl(groupId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/media/images`;
  }

  /**
   * Uploads an image (`multipart/form-data`, one `file` part).
   *
   * @param groupId Group of the library.
   * @param file The image.
   * @param companyId Company the image belongs to (required for a company administrator).
   * @returns The stored image.
   */
  async upload(groupId: string, file: File, companyId?: string): Promise<MediaImage> {
    const body = new FormData();
    body.append('file', file, file.name);
    const response = await firstValueFrom(
      this.http.post<ApiData<MediaImage>>(this.imagesUrl(groupId), body, {
        params: companyId === undefined ? {} : { companyId },
      }),
    );
    return response.data;
  }
}
