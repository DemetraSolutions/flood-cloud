import { listQueryShape } from '../../shared/http/list.ts';
import { integerString, object, objectId, optional } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { IMAGES_LIST } from './media.list.ts';

/** Most images in a page of the list. */
export const MAX_IMAGES_PAGE = 50;

/** Query of `GET /v1/groups/{groupId}/media/images`: the standard list parameters, with a page of at most {@link MAX_IMAGES_PAGE} images, and the `companyId` filter (24 hexadecimal characters). */
export const imagesQuery = object({ ...listQueryShape(IMAGES_LIST), limit: optional(integerString({ min: 1, max: MAX_IMAGES_PAGE })), companyId: optional(objectId()) });

/** Validated query of the image list. */
export type ImagesQuery = Infer<typeof imagesQuery>;

/** Path parameters of the routes on one image; the group was already verified by the route. */
export const imageParams = object({ imageId: objectId() }, { allowUnknown: true });

/** Query of `POST /v1/groups/{groupId}/media/images`: the company the image belongs to (a company administrator must give it; the others may leave it out for an image of the whole group). */
export const uploadQuery = object({ companyId: optional(objectId()) });

/** Validated query of the upload. */
export type UploadQuery = Infer<typeof uploadQuery>;
