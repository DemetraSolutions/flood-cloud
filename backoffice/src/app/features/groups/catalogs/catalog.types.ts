/** Segment of a catalog under `/v1/groups/{groupId}/…` (the six catalogs of the group record). */
export type CatalogSegment =
  | 'price-lists'
  | 'taxes'
  | 'currencies'
  | 'measure-units'
  | 'warehouse-rules'
  | 'fidelity-card-rules';

/** A price list. */
export interface PriceList {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

/** A tax rate. */
export interface Tax {
  readonly id: string;
  readonly rate: number;
  readonly department: number | null;
  readonly description: string | null;
  readonly vatNature: string | null;
}

/** A currency; its `code` is its identifier in the URLs. */
export interface Currency {
  readonly code: string;
  readonly symbol: string;
}

/** A unit of measure. */
export interface MeasureUnit {
  readonly id: string;
  readonly value: string;
}

/** Whether a warehouse rule loads or unloads the stock. */
export type WarehouseRuleType = 'load' | 'unload';
/** How a movement changes a quantity or a value: keeps it, adds to it, subtracts from it. */
export type WarehouseSign = '=' | '+' | '-';
/** The counterpart of a warehouse movement. */
export type WarehouseCounterpart = 'suppliers' | 'customers' | 'indoor';

/** A warehouse rule (causale). A stored value outside the allowed ones is `null`. */
export interface WarehouseRule {
  readonly id: string;
  readonly type: WarehouseRuleType | null;
  readonly name: string;
  readonly quantity: WarehouseSign | null;
  readonly value: WarehouseSign | null;
  readonly useLoadUnit: boolean;
  readonly counterpart: WarehouseCounterpart | null;
  readonly isDefault: boolean;
  readonly cashLoad: boolean;
  readonly cashUnload: boolean;
}

/** The loyalty-card rule of a currency. */
export interface FidelityCardRule {
  readonly currency: string;
  readonly pointValue: number | null;
  readonly discountPercentage: number | null;
}

/** Price lists a group may have. */
export const MAX_PRICE_LISTS = 50;
/** Tax rates a group may have. */
export const MAX_TAXES = 30;
/** Currencies a group may have. */
export const MAX_CURRENCIES = 10;
/** Units of measure a group may have. */
export const MAX_MEASURE_UNITS = 50;
/** Warehouse rules a group may have. */
export const MAX_WAREHOUSE_RULES = 50;

/**
 * VAT natures of the electronic invoice with their official description (the same list the
 * previous backoffice offered; the description pre-fills the one of the tax rate).
 */
export const VAT_NATURES: readonly { readonly code: string; readonly description: string }[] = [
  { code: 'N1', description: 'Operazioni escluse ex art. 15' },
  {
    code: 'N2.1',
    description: 'Operazioni non soggette ad IVA ai sensi degli artt. da 7 a 7-septies',
  },
  { code: 'N2.2', description: 'Operazioni non soggette - altri casi' },
  { code: 'N3.1', description: 'Operazioni non imponibili - esportazioni' },
  { code: 'N3.2', description: 'Operazioni non imponibili - cessioni intracomunitarie' },
  { code: 'N3.3', description: 'Operazioni non imponibili - cessioni verso San Marino' },
  {
    code: 'N3.4',
    description: 'Operazioni non imponibili - operazioni assimilate alle cessioni all’esportazione',
  },
  {
    code: 'N3.5',
    description: 'Operazioni non imponibili - a seguito di dichiarazioni d’intento',
  },
  {
    code: 'N3.6',
    description:
      'Operazioni non imponibili - altre operazioni che non concorrono alla formazione del plafond',
  },
  { code: 'N4', description: 'Operazioni esenti' },
  { code: 'N5', description: 'Regime del margine o con IVA non esposta in fattura' },
  {
    code: 'N6.1',
    description: 'Inversione contabile - cessione di rottami e altri materiali di recupero',
  },
  { code: 'N6.2', description: 'Inversione contabile - cessione di oro e argento puro' },
  { code: 'N6.3', description: 'Inversione contabile - subappalto nel settore edile' },
  { code: 'N6.4', description: 'Inversione contabile - cessione di fabbricati' },
  { code: 'N6.5', description: 'Inversione contabile - cessione di telefoni cellulari' },
  { code: 'N6.6', description: 'Inversione contabile - cessione di prodotti elettronici' },
  {
    code: 'N6.7',
    description: 'Inversione contabile - prestazioni comparto edile e settori connessi',
  },
  { code: 'N6.8', description: 'Inversione contabile - operazioni settore energetico' },
  { code: 'N6.9', description: 'Inversione contabile - altri casi' },
];

/** Official description of a VAT nature, `null` for an unknown code. */
export function vatNatureDescription(code: string): string | null {
  return VAT_NATURES.find((nature) => nature.code === code)?.description ?? null;
}
