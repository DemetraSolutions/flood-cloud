import express from 'express';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { MediaController } from './media.controller.ts';
import { imageParams, imagesQuery, uploadQuery } from './media.schemas.ts';
import { imageUpload } from './upload.ts';
import type { Gate } from './gate.ts';

/**
 * The media routes (`doc/Tasks.md` area 6, step 6B), all on a group: upload, list and read of the images. They are open to who may change an entity that has images,
 * which today is `companies:update` (the list of permissions grows with the products and the places). A company administrator uploads, lists and reads only the images of his own companies. The upload is a `multipart/form-data` request, limited per minute and per day for the user and per day for the group, and goes into the
 * group of the URL; it answers `503` when the media storage is not configured, the lists still work.
 *
 * @param controller Handlers.
 * @param rules The rate limit rules (the upload has its own, per user).
 * @param available Tells whether the media storage is configured.
 * @param gate The gate that bounds the uploads in progress; the one of the process by default.
 * @returns The route definitions to mount on `/v1`.
 */
export function createMediaRoutes(controller: MediaController, rules: Pick<RateLimitRules, 'mediaUploadPerUser' | 'mediaUploadPerUserDaily' | 'mediaUploadPerGroupDaily'>, available: () => boolean, gate?: Gate): RouteDefinition[] {
  const auth = { kind: 'user' as const, anyPermission: ['companies:update'] as const, group: true };
  // The query (the company of the image) is checked before the body is read, then the gate, then the body.
  const upload = express.Router();
  upload.use(validateQuery(uploadQuery), imageUpload(available, gate));
  return [
    defineRoute({ method: 'POST', path: '/groups/:groupId/media/images', auth, rateLimit: [rules.mediaUploadPerUser, rules.mediaUploadPerUserDaily, rules.mediaUploadPerGroupDaily], multipart: upload, handler: controller.upload }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/media/images', auth, middleware: [validateQuery(imagesQuery)], handler: controller.list }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/media/images/:imageId', auth, middleware: [validateParams(imageParams)], handler: controller.get }),
  ];
}
