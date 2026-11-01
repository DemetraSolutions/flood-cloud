import type { Db } from 'mongodb';
import { classifyPii, emptyPiiCounts, emptyRefProfile, tallyRef } from './classify.ts';
import type { PiiCounts, RefProfile } from './classify.ts';
import { createFieldProfiler } from './fields.ts';
import type { FieldProfile } from './fields.ts';
import { listIndexInfo } from './indexes.ts';
import type { IndexInfo } from './indexes.ts';
import { streamDocuments } from './read.ts';
import { isPlainObject } from './walk.ts';

/** Boolean feature flags under `groups.settings`. */
export const GROUP_SETTINGS_FLAGS = [
  'languages',
  'warehouse',
  'cash',
  'services',
  'tobaccosGamesMonopoly',
  'appointments',
  'rooms',
  'delivery',
  'media',
  'productsVariants',
  'scales',
  'customersApp',
  'ordering',
  'email',
] as const;

/** Result of profiling `groups`. */
export interface GroupsProfile {
  fields: FieldProfile;
  indexes: IndexInfo[];
  /** How `apiKey` is stored. */
  apiKey: PiiCounts;
  /** How `settings.integrations.*.apiKey` is stored, over all integrations. */
  integrationApiKeys: PiiCounts;
  dealerId: RefProfile;
  /** Ids of the group documents, as lowercase hex. */
  groupHexes: Set<string>;
}

/**
 * Profiles `groups`. Read-only; the report holds counts, never the keys.
 *
 * @param common The common database.
 * @param dealerHexes Ids of the users with role `D`.
 * @returns The profile, plus the ids of the groups.
 */
export async function profileGroups(common: Db, dealerHexes: ReadonlySet<string>): Promise<GroupsProfile> {
  const fields = createFieldProfiler({
    enums: ['type', 'plan', 'warehouseRules.*.type'],
    booleans: ['status', 'trash', 'demo', ...GROUP_SETTINGS_FLAGS.map((flag) => `settings.${flag}`)],
  });
  const apiKey = emptyPiiCounts();
  const integrationApiKeys = emptyPiiCounts();
  const dealerId = emptyRefProfile();
  const groupHexes = new Set<string>();

  for await (const group of streamDocuments(common.collection('groups'), {}, {})) {
    groupHexes.add(String(group['_id']));
    fields.add(group);
    apiKey[classifyPii(group['apiKey'])] += 1;
    tallyRef(dealerId, group['dealerId'], dealerHexes);
    const settings = group['settings'];
    const integrations = isPlainObject(settings) ? settings['integrations'] : undefined;
    if (isPlainObject(integrations)) {
      for (const integration of Object.values(integrations)) {
        integrationApiKeys[classifyPii(isPlainObject(integration) ? integration['apiKey'] : undefined)] += 1;
      }
    }
  }

  return { fields: fields.result(), indexes: await listIndexInfo(common, common.collection('groups')), apiKey, integrationApiKeys, dealerId, groupHexes };
}
