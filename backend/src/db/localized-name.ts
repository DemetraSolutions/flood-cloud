import type { Document } from 'mongodb';

/**
 * Aggregation expression for the name of a legacy document that keeps its name by language (`name: { it: '…', en: '…' }`) in one language:
 * the requested one, or the first one the document has when it lacks it; anything that is not a text (or a `name` that is not an object) gives
 * `null`. The language is a literal, never part of a path, so a client value cannot reach the pipeline as an operator.
 *
 * @param language Language to show, from the settings of the user.
 * @returns An expression to use in `$addFields`/`$project` over a document that still has its `name`.
 */
export function localizedName(language: string): Document {
  const picked = {
    $ifNull: [
      { $getField: { field: { $literal: language }, input: '$$names' } },
      { $first: { $map: { input: { $objectToArray: '$$names' }, as: 'entry', in: '$$entry.v' } } },
    ],
  };
  return {
    $let: {
      vars: { names: { $cond: [{ $eq: [{ $type: '$name' }, 'object'] }, '$name', {}] } },
      in: { $let: { vars: { picked }, in: { $cond: [{ $eq: [{ $type: '$$picked' }, 'string'] }, '$$picked', null] } } },
    },
  };
}
