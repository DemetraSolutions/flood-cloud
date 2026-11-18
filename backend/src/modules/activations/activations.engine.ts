import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { MAX_CLOSURE_LINES } from '../../db/billing-closures-schema.ts';
import { monthOf, monthsLeft } from './activations.period.ts';
import { feeFactsOf, monthlyFee } from './activations.pricing.ts';
import type { ActivationsRepository, GroupFacts, PlaceRecord } from './activations.repository.ts';
import { cleanName } from './activations.names.ts';
import type { ActivationTotals, Line, LineFlag, RenewalTotals, Section } from './activations.types.ts';
import type { ActivationWindow } from '../../shared/security/scope/mirror-activations.ts';
import type { PriceList } from '../settings/price-list.ts';

/** The key of the dealer of a group in the buckets: the hexadecimal id of the dealer, or `none` for the groups with no dealer. */
export const dealerKeyOf = (group: Pick<GroupFacts, 'dealerId'>): string => (group.dealerId === null ? 'none' : group.dealerId.toHexString());

/** Limits of a computation (tests lower them). */
export interface EngineLimits {
  /** Most places one computation reads: more is a data problem and an error. */
  readonly maxPlaces: number;
  /** Most lines one dealer keeps: the 16 MB limit of a closure document is far above it. */
  readonly maxLines: number;
  /** Places read from the database at a time. */
  readonly batch: number;
}

/** The limits in force. */
export const DEFAULT_LIMITS: EngineLimits = Object.freeze({ maxPlaces: 200_000, maxLines: MAX_CLOSURE_LINES, batch: 500 });

/** What a computation gathers for one dealer. */
export interface Bucket {
  readonly dealerId: ObjectId | null;
  readonly lines: Line[];
  /** More lines than the limit: the lines are incomplete and must not be used (the totals are complete). */
  overflow: boolean;
  places: number;
  monthlyCents: number;
  amountCents: number;
  anomalies: number;
}

/** What a computation reads and decides. */
export interface Computation {
  readonly repository: Pick<ActivationsRepository, 'readPlaces'>;
  /** The groups that count, by hexadecimal id. */
  readonly groups: ReadonlyMap<string, GroupFacts>;
  /** The groups to read (`null`: every group, the others are dropped here). */
  readonly groupIds: readonly ObjectId[] | null;
  /** The window of the activation date. */
  readonly window: ActivationWindow;
  /** The invoice the lines are for. */
  readonly section: Section;
  /** The prices a dealer pays, by dealer key. */
  readonly pricesOf: (dealerKey: string) => PriceList;
  /** The instant that decides `expired`. */
  readonly now: Date;
  /** Whether to keep the lines (a summary needs the totals only). */
  readonly keepLines: boolean;
  readonly limits: EngineLimits;
}

function lineOf(computation: Computation, place: Document, company: Document, group: GroupFacts, prices: PriceList): Line {
  const insertDate: unknown = place['insertDate'];
  const dated = insertDate instanceof Date && !Number.isNaN(insertDate.getTime());
  const activatedAt = dated ? insertDate : (place['_id'] as ObjectId).getTimestamp();
  const facts = feeFactsOf(place, company, group.switches);
  const fee = monthlyFee(facts, prices);
  const expiration: unknown = place['expirationDate'];
  const flagged: ReadonlyArray<readonly [LineFlag, boolean]> = [
    ['unpricedPlan', fee.unpricedPlan],
    ['activationDateFromId', !dated],
    ['expired', expiration instanceof Date && expiration.getTime() < computation.now.getTime()],
    ['groupSuspended', group.suspended],
    ['companyDisabled', company['status'] === false],
  ];
  // The month of the activation is never paid: an activation of May pays June to December; a place of the renewals pays one instalment.
  const months = computation.section === 'activations' ? monthsLeft(monthOf(activatedAt)) : 1;
  return {
    groupId: group.id,
    groupName: group.name,
    companyId: company['_id'] as ObjectId,
    companyName: cleanName(company['name']),
    placeId: place['_id'] as ObjectId,
    placeName: cleanName(place['name']),
    activatedAt,
    plan: facts.plan,
    items: fee.items,
    monthlyCents: fee.monthlyCents,
    months,
    amountCents: fee.monthlyCents * months,
    flags: flagged.filter(([, on]) => on).map(([flag]) => flag),
    devices: { desks: facts.desks, kiosks: facts.kiosks, handhelds: facts.handhelds },
  };
}

/**
 * Computes the lines of one section for the groups that count: reads the places activated in the window batch by batch, joins each with its company and its group, prices it with the prices of its dealer and gathers
 * the lines and the totals by dealer. A place whose company is missing, in another group or in the trash is left out and counted as an anomaly; a place whose group does not count is dropped without a trace.
 *
 * @param computation What to read and how.
 * @returns The bucket of every dealer that has a place or an anomaly, by dealer key.
 * @throws {AppError} `SERVICE_UNAVAILABLE` when a read exceeds its time limit.
 * @throws {Error} When the window holds more places than the limit.
 */
export async function compute(computation: Computation): Promise<Map<string, Bucket>> {
  const { limits } = computation;
  const buckets = new Map<string, Bucket>();
  let scanned = 0;
  let after: ObjectId | null = null;
  for (;;) {
    const batch = await computation.repository.readPlaces(computation.window, computation.groupIds, after, limits.batch);
    scanned += batch.length;
    if (scanned > limits.maxPlaces) {
      throw new Error(`The billing reads more than ${String(limits.maxPlaces)} places`);
    }
    for (const record of batch) {
      const groupId: unknown = record.place['groupId'];
      const group = groupId instanceof ObjectId ? computation.groups.get(groupId.toHexString()) : undefined;
      if (group === undefined) {
        continue;
      }
      const key = dealerKeyOf(group);
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { dealerId: group.dealerId, lines: [], overflow: false, places: 0, monthlyCents: 0, amountCents: 0, anomalies: 0 };
        buckets.set(key, bucket);
      }
      if (record.company === null || record.company['trash'] === true) {
        bucket.anomalies += 1;
        continue;
      }
      const line = lineOf(computation, record.place, record.company, group, computation.pricesOf(key));
      bucket.places += 1;
      bucket.monthlyCents += line.monthlyCents;
      bucket.amountCents += line.amountCents;
      if (computation.keepLines) {
        if (bucket.lines.length < limits.maxLines) {
          bucket.lines.push(line);
        } else {
          bucket.overflow = true;
        }
      }
    }
    if (batch.length < limits.batch) {
      return buckets;
    }
    after = batch[batch.length - 1]!.place['_id'] as ObjectId;
  }
}

/**
 * The totals of the activations of a bucket.
 *
 * @param bucket The bucket, or `undefined` for a dealer with nothing.
 */
export function activationTotalsOf(bucket: Bucket | undefined): ActivationTotals {
  return { places: bucket?.places ?? 0, monthlyCents: bucket?.monthlyCents ?? 0, amountCents: bucket?.amountCents ?? 0, projection12Cents: (bucket?.monthlyCents ?? 0) * 12, anomalies: bucket?.anomalies ?? 0 };
}

/**
 * The totals of the renewals of a bucket: the annual fee of the park and its instalment, one twelfth of it, which is exactly the sum of the monthly fees.
 *
 * @param bucket The bucket, or `undefined` for a dealer with nothing.
 */
export function renewalTotalsOf(bucket: Bucket | undefined): RenewalTotals {
  return { places: bucket?.places ?? 0, annualCents: (bucket?.monthlyCents ?? 0) * 12, instalmentCents: bucket?.monthlyCents ?? 0, anomalies: bucket?.anomalies ?? 0 };
}
