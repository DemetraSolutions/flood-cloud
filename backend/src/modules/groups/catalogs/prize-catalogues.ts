import { array, boolean, nullable, number, object, optional, personName, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import { flagOf, invalid, mergePatch, nestedOf, numberOf, recordsOf, referenced, textOf } from './kit.ts';

/** Most prize catalogues a group may have. */
export const MAX_PRIZE_CATALOGUES = 20;

/** Most prizes in one prize catalogue. */
export const MAX_PRIZES = 200;

/**
 * A prize of a prize catalogue (legacy `fidelity.prizeCatalogues[].prizes[]`). `status` is `enabled`; `medias.images.main` (the descriptor of the
 * image, kept as it is) is shown only as `imageSet`: the media of the prizes are managed by the media domain.
 */
export interface Prize {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string | null;
  readonly description: string | null;
  readonly pointsValue: number | null;
  readonly extraPrice: number | null;
  readonly redemptionConditions: string | null;
  readonly imageSet: boolean;
}

/** A prize catalogue (legacy `fidelity.prizeCatalogues[]`): the prizes a points collection gives access to. `status` is `enabled`. */
export interface PrizeCatalogue {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string | null;
  readonly prizes: readonly Prize[];
}

const prizeBody = object({
  id: optional(string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ })),
  enabled: optional(boolean()),
  name: optional(personName(200)),
  description: optional(nullable(string({ min: 1, max: 1000, trim: true }))),
  pointsValue: optional(nullable(number({ min: 0 }))),
  extraPrice: optional(nullable(number({ min: 0 }))),
  redemptionConditions: optional(nullable(string({ min: 1, max: 1000, trim: true }))),
});
const shape = { enabled: optional(boolean()), prizes: optional(array(prizeBody, { max: MAX_PRIZES })) };

/**
 * Body of the creation of a prize catalogue: the name is required; `prizes` is the whole list (each prize needs a name; ids are made by the server).
 */
export const createPrizeCatalogueBody = object({ name: personName(200), ...shape });

/**
 * Body of the modification of a prize catalogue (JSON Merge Patch). `prizes`, when present, is the whole new list: a prize carrying the `id` of a stored
 * one is that prize (the fields left out keep their values, its image stays), one without `id` is new (and needs a name), a stored prize left out is deleted.
 */
export const patchPrizeCatalogueBody = object({ name: optional(personName(200)), ...shape });

type CreateBody = Infer<typeof createPrizeCatalogueBody>;
type PatchBody = Infer<typeof patchPrizeCatalogueBody>;

const newPrize = (id: string): Prize => ({ id, enabled: true, name: null, description: null, pointsValue: null, extraPrice: null, redemptionConditions: null, imageSet: false });

/** The prize catalogues (`/fidelity/prize-catalogues`, the prizes are part of the catalogue). Deleting one a points collection uses is refused (`409 referenced`). */
export const prizeCatalogues = defineCatalog<PrizeCatalogue, CreateBody, PatchBody>({
  name: 'prizeCatalogue',
  segment: 'fidelity/prize-catalogues',
  path: 'fidelity.prizeCatalogues',
  kind: 'array',
  limit: MAX_PRIZE_CATALOGUES,
  extraPaths: ['fidelity.pointsCollections'],
  idKey: 'id',
  // Up to 200 prizes with texts of 1000 characters each.
  bodyLimit: '1mb',
  readPermission: 'fidelity:read',
  updatePermission: 'fidelity:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createPrizeCatalogueBody,
  patchSchema: patchPrizeCatalogueBody,
  toElement: (id, raw, anomalies) => {
    const prizes: Prize[] = [];
    for (const prize of recordsOf(raw['prizes'])) {
      if (typeof prize['id'] !== 'string') {
        anomalies.push({ kind: 'invalidElement', field: `fidelity.prizeCatalogues.${id}.prizes` });
        continue;
      }
      const main = nestedOf(nestedOf(prize['medias'], '', [])['images'], '', [])['main'];
      prizes.push({
        id: prize['id'],
        enabled: flagOf(prize['status']),
        name: textOf(prize['name']),
        description: textOf(prize['description']),
        pointsValue: numberOf(prize['pointsValue']),
        extraPrice: numberOf(prize['extraPrice']),
        redemptionConditions: textOf(prize['redemptionConditions']),
        imageSet: main !== null && main !== undefined,
      });
    }
    return { id, enabled: flagOf(raw['status']), name: textOf(raw['name']), prizes };
  },
  defaults: (id) => ({ id, enabled: true, name: null, prizes: [] }),
  merge: (current, body, state) => {
    const { prizes, ...rest } = body;
    const base = mergePatch(current, rest);
    if (prizes === undefined) {
      return base;
    }
    const seen = new Set<string>();
    return {
      ...base,
      prizes: prizes.map((incoming, index) => {
        const { id, ...fields } = incoming;
        const stored = id === undefined ? undefined : current.prizes.find((prize) => prize.id === id);
        if (id !== undefined && (stored === undefined || seen.has(id))) {
          throw invalid(`prizes.${String(index)}.id`, 'incorrect');
        }
        if (stored === undefined && fields.name === undefined) {
          throw invalid(`prizes.${String(index)}.name`, 'required');
        }
        const prize = mergePatch(stored ?? newPrize(state.newId()), fields);
        seen.add(prize.id);
        return prize;
      }),
    };
  },
  toRaw: (element, raw) => ({
    ...raw,
    id: element.id,
    status: element.enabled,
    name: element.name,
    prizes: element.prizes.map((prize) => {
      const stored = recordsOf(raw?.['prizes']).find((candidate) => candidate['id'] === prize.id);
      return {
        ...stored,
        id: prize.id,
        status: prize.enabled,
        name: prize.name,
        description: prize.description,
        pointsValue: prize.pointsValue,
        extraPrice: prize.extraPrice,
        redemptionConditions: prize.redemptionConditions,
        medias: stored?.['medias'] ?? { images: { main: null } },
      };
    }),
  }),
  guardRemove: (element, _others, state) => {
    const users = recordsOf(state.raw('fidelity.pointsCollections'))
      .filter((collection) => collection['prizesCatalogId'] === element.id)
      .map((collection) => `pointsCollections.${String(collection['id'])}`);
    if (users.length > 0) {
      throw referenced(users);
    }
  },
});
