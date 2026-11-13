import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { StorageError } from '../../integrations/gcs/index.ts';
import type { MediaStorage } from '../../integrations/gcs/index.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { companyInScope } from '../../shared/security/scope/scope-filters.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { IMAGE_FORMATS, detectImageFormat, slugOf, titleOf } from './image-format.ts';
import { processImage } from './image-processing.ts';
import { IMAGE_DIRNAME, filesHostOf, newFileDocument, toImage, toLogoSource } from './media.mapper.ts';
import { IMAGES_LIST } from './media.list.ts';
import type { ImagesQuery } from './media.schemas.ts';
import type { MediaRepository } from './media.repository.ts';
import { IMAGE_SIZE_NAMES } from './image.types.ts';
import type { Image, ImageSize, UploadedFile } from './image.types.ts';

/** A page of images. */
export interface ImagesListing {
  readonly items: readonly Image[];
  readonly page: PageInfo;
}

/** The images of a group (`doc/Tasks.md` area 6, step 6B): upload, list and read, and the descriptor of an image for a logo. */
export interface MediaService {
  /** Whether the media storage is configured: without it an upload is `503` and the list still works. */
  readonly available: boolean;
  /**
   * Stores an uploaded image: finds its format by the magic bytes, builds the five sizes, uploads the five objects, then inserts the `files` document. It is not a
   * transaction: when an upload fails the objects already uploaded are removed (best effort, logged) and the answer is `503`; when the insert fails they are removed
   * and the error goes on to the central handler. An object that cannot be removed stays in the bucket without a document (it is logged).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group of the URL: the image goes there, never into the caller's own group.
   * @param file The uploaded file.
   * @param companyId The company the image belongs to, `null` for an image of the whole group. A company administrator must give one of his own; any company must be one of the group that is not in the trash.
   * @returns The image.
   * @throws {AppError} `SERVICE_UNAVAILABLE` (no storage, or the storage failed), `UNSUPPORTED_MEDIA_TYPE` (not a JPEG, PNG or WebP by its bytes), `VALIDATION_ERROR` (`file` `incorrect`: damaged, too many pixels or too long a side, animated; `companyId` `required` or `incorrect`), `NOT_FOUND` (a company outside the perimeter of the caller).
   */
  upload(principal: AuthPrincipal, access: GroupAccess, file: UploadedFile, companyId: ObjectId | null): Promise<Image>;
  /**
   * A page of the images of the group that are not in the trash. A company administrator sees only the images of his own companies; the others see all of them. `companyId` narrows the list to one company.
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: ImagesQuery): Promise<ImagesListing>;
  /**
   * One image of the group (a company administrator reaches only the images of his own companies).
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  get(principal: AuthPrincipal, access: GroupAccess, imageId: ObjectId): Promise<Image>;
  /**
   * The descriptor a company logo takes from an image of the group, in the domain form. For a company administrator the image must belong to the company the logo is of.
   *
   * @param forCompany The company the logo is of, `null` on a creation.
   * @returns The descriptor, `null` when the image does not exist in the group, is in the trash, is not the caller's to use, or lacks what a logo needs or holds something unsafe.
   */
  logoSource(principal: AuthPrincipal, access: GroupAccess, imageId: ObjectId, forCompany: ObjectId | null): Promise<MediaLogo | null>;
}

/** Collaborators of {@link createMediaService}. */
export interface MediaServiceDeps {
  readonly repository: MediaRepository;
  /** The storage, `null` when it is disabled. */
  readonly storage: MediaStorage | null;
  readonly logger: Logger;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Eight random hexadecimal characters for the file name; `randomBytes(4)` by default. */
  readonly randomSuffix?: () => string;
  /** Whether a company of the group is one an image can belong to: it exists, is inside the caller's perimeter and is not in the trash. */
  readonly companyUsable: (principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId) => Promise<boolean>;
  /** Deadline, in milliseconds, of the uploads of one image (the five objects together, retries included): 60 seconds by default. */
  readonly uploadDeadlineMs?: number;
  /** Deadline, in milliseconds, of each removal of the rollback: 30 seconds by default. */
  readonly rollbackDeadlineMs?: number;
}

/** The path of an object: `<groupHex>/media/image/<size>/<basename>`, the legacy layout, built only from ids and names made by the server. */
const objectPath = (groupHex: string, size: ImageSize, basename: string): string => `${groupHex}${IMAGE_DIRNAME}/${size}/${basename}`;

/**
 * Builds the media service.
 *
 * @param deps Repository, storage, logger, clock.
 */
export function createMediaService(deps: MediaServiceDeps): MediaService {
  const { repository, storage, logger, now, companyUsable } = deps;
  const randomSuffix = deps.randomSuffix ?? (() => randomBytes(4).toString('hex'));
  const uploadDeadlineMs = deps.uploadDeadlineMs ?? 60_000;
  const rollbackDeadlineMs = deps.rollbackDeadlineMs ?? 30_000;

  const filesHost = async (access: GroupAccess): Promise<string | null> => filesHostOf(await repository.filesHost(access.groupId));

  /** What the caller may see: a company administrator only the images of his own companies (an image without a company, as every legacy one, is not his); the others all. */
  const visibleTo = (principal: AuthPrincipal): Filter<Document> => (principal.scope.kind === 'companies' ? { companyId: { $in: [...principal.scope.companyIds] } } : {});

  /** Logs a storage failure by what it says (the operation, the reason, the HTTP status) and nothing else. */
  const logStorageFailure = (message: string, error: unknown): void => {
    const failure = error instanceof StorageError ? error : null;
    logger.error(message, { operation: failure?.operation ?? 'unknown', reason: failure?.reason ?? 'unknown', status: failure?.status ?? null });
  };

  /** One removal of the rollback, best effort: a failure is logged and the others are still tried. */
  const attemptRemoval = async (removal: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    try {
      await removal(AbortSignal.timeout(rollbackDeadlineMs));
    } catch (error) {
      logStorageFailure('an uploaded object could not be removed after a failed upload', error);
    }
  };

  /** The objects of an image and the bytes of each, in the order of the sizes. */
  interface Planned {
    readonly basename: string;
    readonly objects: readonly string[];
  }

  /** The result of putting the five objects: the generations of what was stored, or why it failed. */
  type Put = { readonly ok: true; readonly planned: Planned; readonly generations: readonly string[] } | { readonly ok: false; readonly failure: unknown; readonly taken: boolean };

  return {
    available: storage !== null,

    upload: async (principal, access, file, companyId) => {
      if (storage === null) {
        throw new AppError('SERVICE_UNAVAILABLE');
      }
      if (companyId === null && principal.scope.kind === 'companies') {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'companyId', issue: 'required' }] });
      }
      if (companyId !== null) {
        if (!companyInScope(principal.scope, companyId)) {
          throw new AppError('NOT_FOUND');
        }
        if (!(await companyUsable(principal, access, companyId))) {
          throw new AppError('VALIDATION_ERROR', { details: [{ field: 'companyId', issue: 'incorrect' }] });
        }
      }
      const format = detectImageFormat(file.buffer);
      if (format === null) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      }
      const { extension, mimetype } = IMAGE_FORMATS[format];
      const sizes = await processImage(file.buffer, format);
      const slug = slugOf(file.originalName);
      const title = titleOf(file.originalName, slug);
      const groupHex = access.groupId.toHexString();

      /** Uploads the five objects under a new name. A failure rolls back what this call stored (and only that); a name that is taken is reported so the caller can try another. */
      const put = async (): Promise<Put> => {
        const basename = `${slug}-${randomSuffix()}.${extension}`;
        const objects = IMAGE_SIZE_NAMES.map((size) => objectPath(groupHex, size, basename));
        const signal = AbortSignal.timeout(uploadDeadlineMs);
        const results = await Promise.allSettled(IMAGE_SIZE_NAMES.map((size, index) => storage.upload(objects[index]!, sizes[size], mimetype, { signal })));
        const failed = results.find((result) => result.status === 'rejected');
        if (failed === undefined) {
          return { ok: true, planned: { basename, objects }, generations: results.map((result) => (result as PromiseFulfilledResult<{ generation: string }>).value.generation) };
        }
        let taken = false;
        for (const [index, result] of results.entries()) {
          const object = objects[index]!;
          if (result.status === 'fulfilled') {
            await attemptRemoval((limit) => storage.remove(object, result.value.generation, { signal: limit }));
          } else if (result.reason instanceof StorageError && result.reason.reason === 'exists') {
            // The name belongs to another object: it is never removed.
            taken = true;
          } else {
            // Unknown outcome (the answer may have been lost): removed only if it is the very bytes sent.
            await attemptRemoval((limit) => storage.removeIfSame(object, sizes[IMAGE_SIZE_NAMES[index]!], { signal: limit }));
          }
        }
        return { ok: false, failure: failed.reason, taken };
      };

      let stored = await put();
      if (!stored.ok && stored.taken) {
        // A name collision (32 bits of suffix): one more try under another name.
        stored = await put();
      }
      if (!stored.ok) {
        logStorageFailure('image upload to the storage failed', stored.failure);
        throw new AppError('SERVICE_UNAVAILABLE');
      }

      const document = newFileDocument({ id: new ObjectId(), groupId: access.groupId, basename: stored.planned.basename, title, extension, mimetype, now: new Date(now()), createdBy: principal.userId, companyId });
      try {
        await repository.insert(principal, access, document);
      } catch (error) {
        // The insert may have happened even though it failed (the answer was lost): a document that exists must not be left with its objects removed.
        let present: boolean;
        try {
          present = await repository.hasFile(principal, access, document['_id'] as ObjectId);
        } catch {
          logger.error('the result of a failed image insert could not be checked, the uploaded objects are kept');
          throw error;
        }
        if (!present) {
          const { objects } = stored.planned;
          for (const [index, object] of objects.entries()) {
            await attemptRemoval((limit) => storage.remove(object, stored.generations[index]!, { signal: limit }));
          }
          throw error;
        }
      }
      return toImage(document, await filesHost(access), groupHex);
    },

    list: async (principal, access, query) => {
      const owner: Filter<Document>[] = [visibleTo(principal)];
      if (query.companyId !== undefined) {
        owner.push({ companyId: query.companyId });
      }
      const { items, page } = await repository.list(principal, access, listParamsOf(query, IMAGES_LIST), { $and: owner });
      const host = await filesHost(access);
      const groupHex = access.groupId.toHexString();
      return { items: items.map((document) => toImage(document, host, groupHex)), page };
    },

    get: async (principal, access, imageId) => {
      const document = await repository.findImage(principal, access, imageId, visibleTo(principal));
      if (document === null) {
        throw new AppError('NOT_FOUND');
      }
      return toImage(document, await filesHost(access), access.groupId.toHexString());
    },

    logoSource: async (principal, access, imageId, forCompany) => {
      if (principal.scope.kind === 'companies' && forCompany === null) {
        return null;
      }
      const owner: Filter<Document> = principal.scope.kind === 'companies' ? { companyId: forCompany } : {};
      const document = await repository.findImage(principal, access, imageId, owner);
      return document === null ? null : toLogoSource(document);
    },
  };
}
