import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';

/** The providers whose `integrations.<provider>.status` decides a service of the activations (the first three are services of their own, the others make the API service). */
export const ACTIVATION_PROVIDERS: readonly string[] = Object.freeze([
  'floodPay',
  'reserveWithGoogle',
  'bizerba',
  'qodeup',
  'googleMaps',
  'yellgo',
  'leggimenu',
  'plateform',
  'cooperto',
  'tomatoai',
  'keenon',
  'phlex',
]);

/**
 * The fields of a place the activations read, and the whole of what leaves the copies of the places for them: the registry fields the statement shows, the date of the activation, and the leaves that decide a service
 * (`devices.type`, the `status` of each provider, the two switches of the reservation widget, `tgm.status`). Never `integrations`, `roomsSettings` or `devices` as a whole: the copies hold credentials and network data.
 */
export const ACTIVATION_PLACE_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  _id: 1,
  groupId: 1,
  companyId: 1,
  name: 1,
  plan: 1,
  expirationDate: 1,
  insertDate: 1,
  'devices.type': 1,
  ...Object.fromEntries(ACTIVATION_PROVIDERS.map((provider) => [`integrations.${provider}.status`, 1 as const])),
  'roomsSettings.reservation.status': 1,
  'roomsSettings.reservation.webWidget.status': 1,
  'tgm.status': 1,
});

/** The fields of a company the activations read: the registry fields the statement shows and the hub of the electronic invoicing (never the rest of `fattura_elettronica`, which holds credentials). */
export const ACTIVATION_COMPANY_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({ _id: 1, groupId: 1, name: 1, trash: 1, status: 1, 'fattura_elettronica.hub': 1 });

/** The places activated in a window: from `from` included (`null` for no lower bound) to `to` excluded. */
export interface ActivationWindow {
  readonly from: Date | null;
  readonly to: Date;
}

/** The `_id` an `ObjectId` created at an instant would start at: the activation date of a place without a valid `insertDate` is the time stored in its id. */
function idAt(date: Date): ObjectId {
  return ObjectId.createFromTime(Math.floor(date.getTime() / 1000));
}

/**
 * The condition on the date of the activation of a place: its `insertDate` when that is a date, otherwise the time of its `_id`.
 *
 * @param window The window.
 */
export function windowCondition(window: ActivationWindow): Filter<Document> {
  const dated: Document = { $type: 'date', ...(window.from === null ? {} : { $gte: window.from }), $lt: window.to };
  const identified: Document = { ...(window.from === null ? {} : { $gte: idAt(window.from) }), $lt: idAt(window.to) };
  return { $or: [{ insertDate: dated }, { insertDate: { $not: { $type: 'date' } }, _id: identified }] };
}

/**
 * The filter of a batch of the places activated in a window: not in the trash, of the given groups (or of any group, `null`), after a position (by `_id`).
 *
 * @param window The window.
 * @param groupIds The groups to read, `null` for every group (the caller drops what is not of a group it counts).
 * @param after The `_id` of the last place already read, or `null`.
 */
export function activationPlacesFilter(window: ActivationWindow, groupIds: readonly ObjectId[] | null, after: ObjectId | null): Filter<Document> {
  return {
    $and: [
      { trash: { $ne: true } },
      groupIds === null ? { groupId: { $type: 'objectId' } } : { groupId: { $in: [...groupIds] } },
      after === null ? { _id: { $type: 'objectId' } } : { _id: { $gt: after } },
      windowCondition(window),
    ],
  };
}
