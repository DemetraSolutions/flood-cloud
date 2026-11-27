/**
 * Simple-type rules of the official schemas (`FPR12`, `FPA12` 1.2.4 and `FSM10` 1.0.3) and the engine that applies
 * them to a text.
 *
 * The tables below are a transcription of every `xs:simpleType` of the schemas in
 * `doc/fatturazione-elettronica/11-01-2027/`: the base type, the facets (lengths, enumeration, range, whitespace)
 * and the pattern **exactly as the schema writes it** (XSD regular-expression syntax, XML entities decoded). A test
 * (`test/unit/schema-drift.test.ts`) parses the schema files with plain text extraction and fails when a table and
 * the schema differ in any enumeration value, pattern or length, so the tables cannot drift from the standard.
 *
 * Patterns are translated to JavaScript regular expressions only when they are applied (`\p{IsBasicLatin}` and
 * `\p{IsLatin-1Supplement}` become code point ranges). Lengths count Unicode code points, like the XSD.
 *
 * @module
 */
import { compare, parseDecimal } from '../invoice/decimal.ts';
import type { Decimal } from '../invoice/decimal.ts';

/** The facets of an XSD simple type, in the terms of the schema. */
export interface SimpleTypeRule {
  /** Base type with its `xs:` prefix. */
  readonly base: string;
  /** Explicit `xs:whiteSpace` facet (the others follow from the base type). */
  readonly whiteSpace?: string;
  readonly length?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Lower bound, as the schema writes it. */
  readonly minInclusive?: string;
  /** Upper bound, as the schema writes it. */
  readonly maxInclusive?: string;
  /** The XSD regular expression (the whole value must match). */
  readonly pattern?: string;
  readonly enumeration?: readonly string[];
}

/** Simple types defined identically by the ordinary and the simplified schemas. */
const SHARED_TYPES = {
  CodiceType: { base: "xs:string", minLength: 1, maxLength: 28 },
  SoggettoEmittenteType: { base: "xs:string", length: 2, enumeration: ["CC", "TZ"] },
  RegimeFiscaleType: { base: "xs:string", length: 4, enumeration: ["RF01", "RF02", "RF04", "RF05", "RF06", "RF07", "RF08", "RF09", "RF10", "RF11", "RF12", "RF13", "RF14", "RF15", "RF16", "RF17", "RF18", "RF19", "RF20", "RF21"] },
  CodiceFiscaleType: { base: "xs:string", pattern: "[A-Z0-9]{11,16}" },
  SocioUnicoType: { base: "xs:string", enumeration: ["SU", "SM"] },
  StatoLiquidazioneType: { base: "xs:string", enumeration: ["LS", "LN"] },
  String10Type: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,10})" },
  String20Type: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,20})" },
  String60LatinType: { base: "xs:normalizedString", pattern: "[\\p{IsBasicLatin}\\p{IsLatin-1Supplement}]{1,60}" },
  String80LatinType: { base: "xs:normalizedString", pattern: "[\\p{IsBasicLatin}\\p{IsLatin-1Supplement}]{1,80}" },
  String100LatinType: { base: "xs:normalizedString", pattern: "[\\p{IsBasicLatin}\\p{IsLatin-1Supplement}]{1,100}" },
  String1000LatinType: { base: "xs:normalizedString", pattern: "[\\p{IsBasicLatin}\\p{IsLatin-1Supplement}]{1,1000}" },
  ProvinciaType: { base: "xs:string", pattern: "[A-Z]{2}" },
  NazioneType: { base: "xs:string", pattern: "[A-Z]{2}" },
  DivisaType: { base: "xs:string", pattern: "[A-Z]{3}" },
  NumeroCivicoType: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,8})" },
  EmailType: { base: "xs:token", maxLength: 256, pattern: "([!#-'*+/-9=?A-Z^-~-]+(\\.[!#-'*+/-9=?A-Z^-~-]+)*|\"(\\[\\]!#-[^-~ \\t]|(\\\\[\\t -~]))+\")@([!#-'*+/-9=?A-Z^-~-]+(\\.[!#-'*+/-9=?A-Z^-~-]+)*|\\[[\\t -Z^-~]*\\])" },
  Amount2DecimalType: { base: "xs:decimal", pattern: "[\\-]?[0-9]{1,11}\\.[0-9]{2}" },
  RateType: { base: "xs:decimal", maxInclusive: "100.00", pattern: "[0-9]{1,3}\\.[0-9]{2}" },
  CAPType: { base: "xs:string", pattern: "[0-9][0-9][0-9][0-9][0-9]" },
  DataFatturaType: { base: "xs:date", minInclusive: "1970-01-01" },
  BolloVirtualeType: { base: "xs:string", enumeration: ["SI"] },
} as const satisfies Readonly<Record<string, SimpleTypeRule>>;

/** Simple types of the ordinary schemas (`FPR12`, `FPA12`) that the simplified schema lacks or defines differently. */
const ORDINARY_ONLY_TYPES = {
  CodiceDestinatarioType: { base: "xs:string", pattern: "[A-Z0-9]{6,7}" },
  FormatoTrasmissioneType: { base: "xs:string", length: 5, enumeration: ["FPA12", "FPR12"] },
  CausalePagamentoType: { base: "xs:string", enumeration: ["A", "B", "C", "D", "E", "G", "H", "I", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "L1", "M1", "M2", "O1", "V1", "ZO"] },
  TipoScontoMaggiorazioneType: { base: "xs:string", length: 2, enumeration: ["SC", "MG"] },
  Art73Type: { base: "xs:string", length: 2, enumeration: ["SI"] },
  TipoCassaType: { base: "xs:string", length: 4, enumeration: ["TC01", "TC02", "TC03", "TC04", "TC05", "TC06", "TC07", "TC08", "TC09", "TC10", "TC11", "TC12", "TC13", "TC14", "TC15", "TC16", "TC17", "TC18", "TC19", "TC20", "TC21", "TC22"] },
  TipoDocumentoType: { base: "xs:string", length: 4, enumeration: ["TD01", "TD02", "TD03", "TD04", "TD05", "TD06", "TD16", "TD17", "TD18", "TD19", "TD20", "TD21", "TD22", "TD23", "TD24", "TD25", "TD26", "TD27", "TD28", "TD29"] },
  TipoRitenutaType: { base: "xs:string", length: 4, enumeration: ["RT01", "RT02", "RT03", "RT04", "RT05", "RT06"] },
  RiferimentoNumeroLineaType: { base: "xs:integer", minInclusive: "1", maxInclusive: "9999" },
  CondizioniPagamentoType: { base: "xs:string", minLength: 4, maxLength: 4, enumeration: ["TP01", "TP02", "TP03"] },
  ModalitaPagamentoType: { base: "xs:string", length: 4, enumeration: ["MP01", "MP02", "MP03", "MP04", "MP05", "MP06", "MP07", "MP08", "MP09", "MP10", "MP11", "MP12", "MP13", "MP14", "MP15", "MP16", "MP17", "MP18", "MP19", "MP20", "MP21", "MP22", "MP23"] },
  IBANType: { base: "xs:string", pattern: "[a-zA-Z]{2}[0-9]{2}[a-zA-Z0-9]{11,30}" },
  BICType: { base: "xs:string", pattern: "[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3}){0,1}" },
  RitenutaType: { base: "xs:string", length: 2, enumeration: ["SI"] },
  EsigibilitaIVAType: { base: "xs:string", minLength: 1, maxLength: 1, enumeration: ["D", "I", "S"] },
  NaturaType: { base: "xs:string", enumeration: ["N1", "N2", "N2.1", "N2.2", "N3", "N3.1", "N3.2", "N3.3", "N3.4", "N3.5", "N3.6", "N4", "N5", "N6", "N6.1", "N6.2", "N6.3", "N6.4", "N6.5", "N6.6", "N6.7", "N6.8", "N6.9", "N7"] },
  CodiceFiscalePFType: { base: "xs:string", pattern: "[A-Z0-9]{16}" },
  CodEORIType: { base: "xs:string", minLength: 13, maxLength: 17 },
  TipoCessionePrestazioneType: { base: "xs:string", length: 2, enumeration: ["SC", "PR", "AB", "AC"] },
  TitoloType: { base: "xs:normalizedString", whiteSpace: "collapse", pattern: "(\\p{IsBasicLatin}{2,10})" },
  String15Type: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,15})" },
  String35Type: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,35})" },
  String35LatinExtType: { base: "xs:normalizedString", minLength: 1, maxLength: 35 },
  String60Type: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,60})" },
  String80Type: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,80})" },
  String100Type: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{1,100})" },
  String200LatinType: { base: "xs:normalizedString", pattern: "[\\p{IsBasicLatin}\\p{IsLatin-1Supplement}]{1,200}" },
  TipoResaType: { base: "xs:string", pattern: "[A-Z]{3}" },
  TelFaxType: { base: "xs:normalizedString", pattern: "(\\p{IsBasicLatin}{5,12})" },
  EmailContattiType: { base: "xs:string", minLength: 7, maxLength: 256, pattern: ".+@.+[.]+.+" },
  PesoType: { base: "xs:decimal", pattern: "[0-9]{1,4}\\.[0-9]{1,2}" },
  Amount8DecimalType: { base: "xs:decimal", pattern: "[\\-]?[0-9]{1,11}\\.[0-9]{2,8}" },
  RiferimentoFaseType: { base: "xs:integer", minInclusive: "1", maxInclusive: "999" },
  NumeroColliType: { base: "xs:integer", minInclusive: "1", maxInclusive: "9999" },
  NumeroLineaType: { base: "xs:integer", minInclusive: "1", maxInclusive: "9999" },
  ABIType: { base: "xs:string", pattern: "[0-9][0-9][0-9][0-9][0-9]" },
  CABType: { base: "xs:string", pattern: "[0-9][0-9][0-9][0-9][0-9]" },
  GiorniTerminePagamentoType: { base: "xs:integer", minInclusive: "0", maxInclusive: "999" },
  QuantitaType: { base: "xs:decimal", pattern: "[0-9]{1,12}\\.[0-9]{2,8}" },
} as const satisfies Readonly<Record<string, SimpleTypeRule>>;

/** Simple types of the simplified schema (`FSM10`) that the ordinary schemas lack or define differently. */
const SIMPLIFIED_ONLY_TYPES = {
  CodiceDestinatarioType: { base: "xs:string", pattern: "[A-Z0-9]{7}" },
  FormatoTrasmissioneType: { base: "xs:string", length: 5, enumeration: ["FSM10"] },
  TipoDocumentoType: { base: "xs:string", length: 4, enumeration: ["TD07", "TD08", "TD09"] },
  NaturaType: { base: "xs:string", enumeration: ["N1", "N2", "N2.1", "N2.2", "N3", "N3.1", "N3.2", "N3.3", "N3.4", "N3.5", "N3.6", "N4", "N5"] },
} as const satisfies Readonly<Record<string, SimpleTypeRule>>;

/** Built-in XSD types the schemas use directly in element declarations (no `xs:simpleType` of their own). */
const BUILT_IN_TYPES = {
  'xs:date': { base: 'xs:date' },
  'xs:dateTime': { base: 'xs:dateTime' },
} as const satisfies Readonly<Record<string, SimpleTypeRule>>;

/** Every simple type of the ordinary schemas (`FPR12`, `FPA12`: one file, two names), exactly as the schema defines them. */
export const ORDINARY_TYPES = { ...SHARED_TYPES, ...ORDINARY_ONLY_TYPES } as const;

/** Every simple type of the simplified schema (`FSM10`), exactly as the schema defines them. */
export const SIMPLIFIED_TYPES = { ...SHARED_TYPES, ...SIMPLIFIED_ONLY_TYPES } as const;

/** Name of a simple type the validator can look up: a schema `simpleType` of the ordinary schemas or a built-in. */
export type TypeName = keyof typeof ORDINARY_TYPES | keyof typeof BUILT_IN_TYPES;

/** Rules by type name for the ordinary formats (schema types plus the built-ins). */
export const ORDINARY_RULES: Readonly<Record<string, SimpleTypeRule>> = { ...ORDINARY_TYPES, ...BUILT_IN_TYPES };

/** Rules by type name for the simplified format (schema types plus the built-ins). */
export const SIMPLIFIED_RULES: Readonly<Record<string, SimpleTypeRule>> = { ...SIMPLIFIED_TYPES, ...BUILT_IN_TYPES };

/** Why a value does not satisfy a type: the facet that failed first. */
export type RuleFailure = 'LEXICAL' | 'LENGTH' | 'ENUMERATION' | 'PATTERN' | 'RANGE';

const WHITESPACE: Readonly<Record<string, 'preserve' | 'replace'>> = { 'xs:string': 'preserve', 'xs:normalizedString': 'replace' };

/** Unicode blocks of the XSD regular-expression syntax used by the schemas, as code point ranges. */
const BLOCKS: readonly (readonly [string, string])[] = [
  ['IsBasicLatin', '\\u0000-\\u007F'],
  ['IsLatin-1Supplement', '\\u0080-\\u00FF'],
];

const TIMEZONE = '(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))';
const DATE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:${TIMEZONE})?$`);
const DATE_TIME = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:${TIMEZONE})?$`);
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const compiled = new Map<string, RegExp>();

/**
 * Translates an XSD regular expression to a JavaScript one that must match the whole value.
 *
 * @param pattern The pattern, in XSD syntax.
 * @returns The anchored regular expression (Unicode mode, so `{n,m}` counts code points).
 */
function compile(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  let source = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === '\\') {
      const block = BLOCKS.find(([name]) => pattern.startsWith(`\\p{${name}}`, index));
      if (block === undefined) {
        source += pattern.slice(index, index + 2);
        index += 1;
      } else {
        source += inClass ? block[1] : `[${block[1]}]`;
        index += block[0].length + 3;
      }
      continue;
    }
    if (character === '[') {
      inClass = true;
    } else if (character === ']') {
      inClass = false;
    }
    source += character;
  }
  const expression = new RegExp(`^(?:${source})$`, 'u');
  compiled.set(pattern, expression);
  return expression;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 && leap ? 29 : (DAYS[month - 1] ?? 0);
  return year >= 1 && day >= 1 && day <= days;
}

/**
 * Whether a text is a valid `xs:date` (`YYYY-MM-DD`, optional time zone) on the calendar.
 *
 * @param value The text.
 * @returns `true` for a real date.
 */
export function isDate(value: string): boolean {
  const match = DATE.exec(value);
  return match !== null && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Whether a text is a valid `xs:dateTime` (`YYYY-MM-DDThh:mm:ss`, optional fraction and time zone). The hour `24` is
 * not accepted.
 *
 * @param value The text.
 * @returns `true` for a real date and time.
 */
export function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  return match !== null && isDate(match[1] as string);
}

const LEXICAL: Readonly<Record<string, (value: string) => boolean>> = {
  'xs:decimal': (value) => DECIMAL.test(value),
  'xs:integer': (value) => INTEGER.test(value),
  'xs:date': isDate,
  'xs:dateTime': isDateTime,
};

/** Applies the whitespace facet: `replace` turns tab and line breaks into spaces, `collapse` also squeezes and trims. */
function normalizeWhitespace(rule: SimpleTypeRule, raw: string): string {
  const mode = rule.whiteSpace ?? WHITESPACE[rule.base] ?? 'collapse';
  if (mode === 'preserve') {
    return raw;
  }
  const replaced = raw.replace(/[\t\n\r]/g, ' ');
  return mode === 'replace' ? replaced : replaced.replace(/ +/g, ' ').replace(/^ | $/g, '');
}

/** Orders two values of a bounded type: dates by their calendar day, numbers by value. */
function order(base: string, a: string, b: string): number {
  if (base === 'xs:date') {
    const day = a.slice(0, 10);
    return day === b ? 0 : day < b ? -1 : 1;
  }
  return compare(parseDecimal(a) as Decimal, parseDecimal(b) as Decimal);
}

function isOutsideRange(rule: SimpleTypeRule, value: string): boolean {
  const { minInclusive: lower, maxInclusive: upper } = rule;
  return (lower !== undefined && order(rule.base, value, lower) < 0) || (upper !== undefined && order(rule.base, value, upper) > 0);
}

/**
 * Checks a text against a simple type, the way an XSD validator does: whitespace normalization, lexical form of the
 * base type, then length, enumeration, pattern and range facets.
 *
 * @param rule The type.
 * @param raw The text as it is written in the XML.
 * @returns `null` when the value is valid, otherwise the facet that failed first.
 * @example
 * checkValue(ORDINARY_TYPES.CAPType, '2010'); // 'PATTERN'
 */
export function checkValue(rule: SimpleTypeRule, raw: string): RuleFailure | null {
  const value = normalizeWhitespace(rule, raw);
  if (!(LEXICAL[rule.base]?.(value) ?? true)) {
    return 'LEXICAL';
  }
  const size = Array.from(value).length;
  if (
    (rule.length !== undefined && size !== rule.length) ||
    (rule.minLength !== undefined && size < rule.minLength) ||
    (rule.maxLength !== undefined && size > rule.maxLength)
  ) {
    return 'LENGTH';
  }
  if (rule.enumeration !== undefined && !rule.enumeration.includes(value)) {
    return 'ENUMERATION';
  }
  if (rule.pattern !== undefined && !compile(rule.pattern).test(value)) {
    return 'PATTERN';
  }
  return isOutsideRange(rule, value) ? 'RANGE' : null;
}
