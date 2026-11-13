import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/** Whether a value is a non-null object, so that its keys can be read. */
function isObject(value: unknown): value is Document {
  return typeof value === 'object' && value !== null;
}

/**
 * The record of the feed `common.reserve_with_google` of a place, if its integration is active and complete under the rule of the legacy
 * (`ms-places-service`, `insertOne` and `updateMany`): `status`, `category`, `name`, `geo.latitude`, `geo.longitude` and the four keys of
 * `geo.address` (`streetAddress`, `locality`, `postalCode`, `country`) must be all truthy (a latitude of `0` counts as missing, as in the
 * legacy). The place must also have a `companyId` that is an `ObjectId`. `telephone` and `url` fall back to `null`.
 *
 * @param place The place, read with ordinary types (numbers as JavaScript numbers): `companyId` and `integrations.reserveWithGoogle`; `null` when it was not found.
 * @param groupId Group of the verified access, never the `groupId` of the document.
 * @returns The record to upsert, or `null` when there is no place or its integration is not active or not complete.
 */
export function reserveWithGoogleRecord(place: Document | null, groupId: ObjectId): Document | null {
  if (place === null) {
    return null;
  }
  const integrations: unknown = place['integrations'];
  const rwg: unknown = isObject(integrations) ? integrations['reserveWithGoogle'] : undefined;
  if (!isObject(rwg) || !(place['companyId'] instanceof ObjectId)) {
    return null;
  }
  const geo: unknown = rwg['geo'];
  const address: unknown = isObject(geo) ? geo['address'] : undefined;
  if (!isObject(geo) || !isObject(address)) {
    return null;
  }
  const required = [rwg['status'], rwg['category'], rwg['name'], geo['latitude'], geo['longitude'], address['streetAddress'], address['locality'], address['postalCode'], address['country']];
  if (!required.every(Boolean)) {
    return null;
  }
  return {
    groupId,
    companyId: place['companyId'],
    placeId: place['_id'],
    category: rwg['category'],
    name: rwg['name'],
    telephone: rwg['telephone'] || null,
    url: rwg['url'] || null,
    geo: {
      latitude: geo['latitude'],
      longitude: geo['longitude'],
      address: { streetAddress: address['streetAddress'], locality: address['locality'], postalCode: address['postalCode'], country: address['country'] },
    },
  };
}
