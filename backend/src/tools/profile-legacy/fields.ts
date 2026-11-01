import { bsonTypeName, compilePathPattern, walkDocument } from './walk.ts';
import type { PlainObject } from './walk.ts';

/** Maximum number of distinct paths kept per collection. */
export const MAX_PATHS = 500;

/** A field path or an enum value is published only when it was seen at least this many times. */
export const MIN_PUBLISH_COUNT = 3;

/** Key under which the enum values below the publication threshold are summed. */
export const RARE_VALUES_KEY = '<rare>';

/** An enum is listed only when it has at most this many distinct values. */
export const MAX_ENUM_VALUES = 30;

/** Presence and type histogram of one field path. */
export interface FieldStat {
  /** Documents in which the path appears. */
  docs: number;
  /** Occurrences per BSON type (an array path counts each element). */
  types: Record<string, number>;
}

/** Counts of the values of an allowlisted enum field. */
export interface EnumProfile {
  /** Number of distinct string values seen. */
  distinct: number;
  /** Values that are not strings. */
  nonString: number;
  /**
   * Value counts, present only when `distinct` is at most {@link MAX_ENUM_VALUES}. Values seen fewer
   * than {@link MIN_PUBLISH_COUNT} times are summed under {@link RARE_VALUES_KEY}.
   */
  values?: Record<string, number>;
}

/** Histogram of a boolean field. */
export interface BooleanProfile {
  true: number;
  false: number;
  /** Values of any other type. */
  other: number;
}

/** Everything learned about one collection from its documents. */
export interface FieldProfile {
  /** Documents read. */
  documents: number;
  /** `true` when more than {@link MAX_PATHS} paths exist and the rest were ignored. */
  truncated: boolean;
  /** Statistics of the paths found in at least {@link MIN_PUBLISH_COUNT} documents, sorted by path. */
  fields: Record<string, FieldStat>;
  /** How many tracked paths were left out because they appear in fewer documents. */
  rarePaths: number;
  /** Allowlisted enums, by path pattern. */
  enums: Record<string, EnumProfile>;
  /** Boolean histograms, by path pattern. */
  booleans: Record<string, BooleanProfile>;
}

/** What to profile besides the field inventory. */
export interface FieldProfilerOptions {
  /** Path patterns whose string values may be listed (the allowlist). */
  readonly enums?: readonly string[];
  /** Path patterns summarized as true/false/other. */
  readonly booleans?: readonly string[];
  /** Override of {@link MAX_PATHS}. */
  readonly maxPaths?: number;
  /** Override of {@link MIN_PUBLISH_COUNT}. */
  readonly minCount?: number;
}

/** Incremental profiler fed one document at a time. */
export interface FieldProfiler {
  /** Adds a document to the profile. */
  add(document: PlainObject): void;
  /** The profile built so far, with sorted keys. */
  result(): FieldProfile;
}

function sortedRecord<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Creates a profiler that records, for every field path of the documents it receives, the presence
 * and the BSON types of the values, plus histograms for allowlisted enum and boolean fields.
 * It never keeps or returns a value that is not an allowlisted enum value.
 *
 * @param options Enum and boolean patterns, and the path limit.
 * @returns The profiler.
 * @example
 * const profiler = createFieldProfiler({ enums: ['role'], booleans: ['status'] });
 */
export function createFieldProfiler(options: FieldProfilerOptions = {}): FieldProfiler {
  const maxPaths = options.maxPaths ?? MAX_PATHS;
  const minCount = options.minCount ?? MIN_PUBLISH_COUNT;
  const stats = new Map<string, FieldStat>();
  const enums = (options.enums ?? []).map((pattern) => ({
    pattern,
    regex: compilePathPattern(pattern),
    counts: new Map<string, number>(),
    nonString: 0,
  }));
  const booleans = (options.booleans ?? []).map((pattern) => ({
    pattern,
    regex: compilePathPattern(pattern),
    histogram: { true: 0, false: 0, other: 0 },
  }));
  let documents = 0;
  let truncated = false;

  return {
    add(document) {
      documents += 1;
      const seen = new Set<string>();
      walkDocument(document, (path, value) => {
        let stat = stats.get(path);
        if (stat === undefined && stats.size < maxPaths) {
          stat = { docs: 0, types: {} };
          stats.set(path, stat);
        } else if (stat === undefined) {
          truncated = true;
        }
        if (stat !== undefined) {
          const type = bsonTypeName(value);
          stat.types[type] = (stat.types[type] ?? 0) + 1;
          if (!seen.has(path)) {
            seen.add(path);
            stat.docs += 1;
          }
        }
        for (const entry of enums) {
          if (entry.regex.test(path)) {
            if (typeof value === 'string') {
              entry.counts.set(value, (entry.counts.get(value) ?? 0) + 1);
            } else {
              entry.nonString += 1;
            }
          }
        }
        for (const entry of booleans) {
          if (entry.regex.test(path)) {
            if (value === true) {
              entry.histogram.true += 1;
            } else if (value === false) {
              entry.histogram.false += 1;
            } else {
              entry.histogram.other += 1;
            }
          }
        }
      });
    },
    result() {
      const enumResult: Record<string, EnumProfile> = {};
      for (const entry of enums) {
        const profile: EnumProfile = { distinct: entry.counts.size, nonString: entry.nonString };
        if (entry.counts.size <= MAX_ENUM_VALUES) {
          const published = new Map([...entry.counts].filter(([, count]) => count >= minCount));
          const rare = [...entry.counts.values()].filter((count) => count < minCount).reduce((sum, count) => sum + count, 0);
          if (rare > 0) {
            published.set(RARE_VALUES_KEY, rare);
          }
          profile.values = sortedRecord(published);
        }
        enumResult[entry.pattern] = profile;
      }
      const booleanResult: Record<string, BooleanProfile> = {};
      for (const entry of booleans) {
        booleanResult[entry.pattern] = { ...entry.histogram };
      }
      const common = new Map([...stats].filter(([, stat]) => stat.docs >= minCount));
      return {
        documents,
        truncated,
        fields: sortedRecord(common),
        rarePaths: stats.size - common.size,
        enums: enumResult,
        booleans: booleanResult,
      };
    },
  };
}
