/**
 * Schema validation of the invoice model: what the official XSD (`FPR12`, `FPA12`, `FSM10`) would reject, found
 * before the XML is built.
 *
 * The structure of the schemas is written once as data (the `ROOT_*` descriptors below: which elements exist, which
 * are mandatory, which simple type each text has) and a single generic walker applies it to the model. The simple
 * types themselves come from `schema-rules.ts`. The walker mirrors how `serialize.ts` writes the model, so that the
 * model is valid here exactly when the XML it produces is valid for the schema:
 *
 * - an empty text, or an element with no content, is "absent" (the writer does not write it);
 * - amounts are checked in the form they are written (`formatDecimal` with the digits the serializer uses), so a value
 *   with more decimals than the type allows is fine (the writer rounds it) and one with too many integer digits or a
 *   wrong sign is not;
 * - a mandatory element that is absent, a mandatory block with no content and a list below its minimum are
 *   reported; the `Anagrafica` choice must be `Denominazione` alone or `Nome` with `Cognome`.
 *
 * Every issue has the code `XSD`, the path of the element and a message that never holds the value. A test compares
 * these results with `xmllint` on the real schemas (`test/unit/schema-equivalence.test.ts`).
 *
 * @module
 */
import { formatDecimal } from '../invoice/decimal.ts';
import type { Decimal } from '../invoice/decimal.ts';
import type { InvoiceModel } from '../invoice/model.ts';
import { child, error } from './issue.ts';
import type { ValidationIssue } from './issue.ts';
import { checkValue, ORDINARY_RULES, SIMPLIFIED_RULES } from './schema-rules.ts';
import type { RuleFailure, SimpleTypeRule, TypeName } from './schema-rules.ts';

interface TextNode {
  readonly kind: 'text';
  readonly type: TypeName;
  readonly required: boolean;
}

interface DecimalNode {
  readonly kind: 'decimal';
  readonly type: TypeName;
  /** Digits the serializer writes: at least `min`, at most `max`. */
  readonly min: number;
  readonly max: number;
  readonly required: boolean;
}

interface IntegerNode {
  readonly kind: 'integer';
  readonly type: TypeName;
  readonly required: boolean;
}

interface ObjectNode {
  readonly kind: 'object';
  readonly fields: Readonly<Record<string, Node>>;
  readonly required: boolean;
  /** The block holds the `Denominazione` or `Nome` and `Cognome` choice. */
  readonly nameChoice: boolean;
  /** Path segment when it differs from the property name (the body is written `FatturaElettronicaBody[0]`). */
  readonly label?: string;
}

interface ListNode {
  readonly kind: 'list';
  readonly item: Node;
  readonly min: number;
}

type Node = TextNode | DecimalNode | IntegerNode | ObjectNode | ListNode;

function text(type: TypeName, required = false): TextNode {
  return { kind: 'text', type, required };
}

function required(type: TypeName): TextNode {
  return text(type, true);
}

function decimal(type: TypeName, min: number, max: number, isRequired = false): DecimalNode {
  return { kind: 'decimal', type, min, max, required: isRequired };
}

function block(fields: Readonly<Record<string, Node>>, options: { readonly required?: boolean; readonly nameChoice?: boolean; readonly label?: string } = {}): ObjectNode {
  return {
    kind: 'object',
    fields,
    required: options.required ?? false,
    nameChoice: options.nameChoice ?? false,
    ...(options.label === undefined ? {} : { label: options.label }),
  };
}

function list(item: Node, min = 0): ListNode {
  return { kind: 'list', item, min };
}

const FISCAL_ID = block({ IdPaese: required('NazioneType'), IdCodice: required('CodiceType') }, { required: true });
const NAME_FIELDS = { Denominazione: text('String80LatinType'), Nome: text('String60LatinType'), Cognome: text('String60LatinType') };
const PERSON = block({ ...NAME_FIELDS, Titolo: text('TitoloType'), CodEORI: text('CodEORIType') }, { required: true, nameChoice: true });
const ADDRESS = block(
  {
    Indirizzo: required('String60LatinType'),
    NumeroCivico: text('NumeroCivicoType'),
    CAP: required('CAPType'),
    Comune: required('String60LatinType'),
    Provincia: text('ProvinciaType'),
    Nazione: required('NazioneType'),
  },
  { required: true },
);
const REGISTER_ENTRY = block({
  Ufficio: required('ProvinciaType'),
  NumeroREA: required('String20Type'),
  CapitaleSociale: decimal('Amount2DecimalType', 2, 2),
  SocioUnico: text('SocioUnicoType'),
  StatoLiquidazione: required('StatoLiquidazioneType'),
});
const TRANSMISSION = block(
  {
    IdTrasmittente: FISCAL_ID,
    ProgressivoInvio: required('String10Type'),
    FormatoTrasmissione: required('FormatoTrasmissioneType'),
    CodiceDestinatario: required('CodiceDestinatarioType'),
    PECDestinatario: text('EmailType'),
  },
  { required: true },
);
const ADJUSTMENT = block(
  {
    Tipo: required('TipoScontoMaggiorazioneType'),
    Percentuale: decimal('RateType', 2, 2),
    Importo: decimal('Amount8DecimalType', 2, 8),
  },
  { required: true },
);
const RELATED_DOCUMENT = block(
  { IdDocumento: required('String20Type'), Data: text('xs:date'), CodiceCUP: text('String15Type'), CodiceCIG: text('String15Type') },
  { required: true },
);
const CARRIER = block({
  IdFiscaleIVA: FISCAL_ID,
  CodiceFiscale: text('CodiceFiscaleType'),
  Anagrafica: PERSON,
  NumeroLicenzaGuida: text('String20Type'),
});
const TRANSPORT = block({
  DatiAnagraficiVettore: CARRIER,
  MezzoTrasporto: text('String80LatinType'),
  CausaleTrasporto: text('String100LatinType'),
  NumeroColli: { kind: 'integer', type: 'NumeroColliType', required: false },
  Descrizione: text('String100LatinType'),
  UnitaMisuraPeso: text('String10Type'),
  PesoLordo: decimal('PesoType', 2, 2),
  PesoNetto: decimal('PesoType', 2, 2),
  DataOraRitiro: text('xs:dateTime'),
  DataInizioTrasporto: text('xs:date'),
  TipoResa: text('TipoResaType'),
  IndirizzoResa: ADDRESS,
  DataOraConsegna: text('xs:dateTime'),
});
const LINE = block(
  {
    NumeroLinea: { kind: 'integer', type: 'NumeroLineaType', required: true },
    Descrizione: required('String1000LatinType'),
    Quantita: decimal('QuantitaType', 2, 8),
    UnitaMisura: text('String10Type'),
    PrezzoUnitario: decimal('Amount8DecimalType', 2, 8, true),
    ScontoMaggiorazione: list(ADJUSTMENT),
    PrezzoTotale: decimal('Amount8DecimalType', 2, 8, true),
    AliquotaIVA: decimal('RateType', 2, 2, true),
    Natura: text('NaturaType'),
    AltriDatiGestionali: list(
      block({ TipoDato: required('String10Type'), RiferimentoTesto: text('String60LatinType'), RiferimentoData: text('xs:date') }, { required: true }),
    ),
  },
  { required: true },
);
const SUMMARY = block(
  {
    AliquotaIVA: decimal('RateType', 2, 2, true),
    Natura: text('NaturaType'),
    ImponibileImporto: decimal('Amount2DecimalType', 2, 2, true),
    Imposta: decimal('Amount2DecimalType', 2, 2, true),
    EsigibilitaIVA: text('EsigibilitaIVAType'),
    RiferimentoNormativo: text('String100LatinType'),
  },
  { required: true },
);
const PAYMENT = block(
  {
    CondizioniPagamento: required('CondizioniPagamentoType'),
    DettaglioPagamento: list(
      block(
        {
          Beneficiario: text('String200LatinType'),
          ModalitaPagamento: required('ModalitaPagamentoType'),
          DataScadenzaPagamento: text('xs:date'),
          ImportoPagamento: decimal('Amount2DecimalType', 2, 2, true),
          IstitutoFinanziario: text('String80LatinType'),
          IBAN: text('IBANType'),
          ABI: text('ABIType'),
          CAB: text('CABType'),
          BIC: text('BICType'),
        },
        { required: true },
      ),
      1,
    ),
  },
  { required: true },
);

const ROOT_ORDINARY = block({
  FatturaElettronicaHeader: block(
    {
      DatiTrasmissione: TRANSMISSION,
      CedentePrestatore: block(
        {
          DatiAnagrafici: block(
            {
              IdFiscaleIVA: FISCAL_ID,
              CodiceFiscale: text('CodiceFiscaleType'),
              Anagrafica: PERSON,
              RegimeFiscale: required('RegimeFiscaleType'),
            },
            { required: true },
          ),
          Sede: ADDRESS,
          IscrizioneREA: REGISTER_ENTRY,
          RiferimentoAmministrazione: text('String20Type'),
        },
        { required: true },
      ),
      CessionarioCommittente: block(
        {
          DatiAnagrafici: block({ IdFiscaleIVA: block(FISCAL_ID.fields), CodiceFiscale: text('CodiceFiscaleType'), Anagrafica: PERSON }, { required: true }),
          Sede: ADDRESS,
        },
        { required: true },
      ),
    },
    { required: true },
  ),
  FatturaElettronicaBody: block(
    {
      DatiGenerali: block(
        {
          DatiGeneraliDocumento: block(
            {
              TipoDocumento: required('TipoDocumentoType'),
              Divisa: required('DivisaType'),
              Data: required('DataFatturaType'),
              Numero: required('String20Type'),
              ScontoMaggiorazione: list(ADJUSTMENT),
              ImportoTotaleDocumento: decimal('Amount2DecimalType', 2, 2),
              Causale: list(text('String200LatinType')),
            },
            { required: true },
          ),
          DatiOrdineAcquisto: list(RELATED_DOCUMENT),
          DatiFattureCollegate: list(RELATED_DOCUMENT),
          DatiTrasporto: TRANSPORT,
        },
        { required: true },
      ),
      DatiBeniServizi: block({ DettaglioLinee: list(LINE, 1), DatiRiepilogo: list(SUMMARY, 1) }, { required: true }),
      DatiPagamento: list(PAYMENT),
    },
    { required: true, label: 'FatturaElettronicaBody[0]' },
  ),
});

const ROOT_SIMPLIFIED = block({
  FatturaElettronicaHeader: block(
    {
      DatiTrasmissione: TRANSMISSION,
      CedentePrestatore: block(
        {
          IdFiscaleIVA: FISCAL_ID,
          CodiceFiscale: text('CodiceFiscaleType'),
          ...NAME_FIELDS,
          Sede: ADDRESS,
          IscrizioneREA: REGISTER_ENTRY,
          RegimeFiscale: required('RegimeFiscaleType'),
        },
        { required: true, nameChoice: true },
      ),
      CessionarioCommittente: block(
        {
          IdentificativiFiscali: block({ IdFiscaleIVA: block(FISCAL_ID.fields), CodiceFiscale: text('CodiceFiscaleType') }, { required: true }),
          AltriDatiIdentificativi: block({ ...NAME_FIELDS, Sede: ADDRESS }, { nameChoice: true }),
        },
        { required: true },
      ),
    },
    { required: true },
  ),
  FatturaElettronicaBody: block(
    {
      DatiGenerali: block(
        {
          DatiGeneraliDocumento: block(
            {
              TipoDocumento: required('TipoDocumentoType'),
              Divisa: required('DivisaType'),
              Data: required('DataFatturaType'),
              Numero: required('String20Type'),
            },
            { required: true },
          ),
          DatiFatturaRettificata: block({
            NumeroFR: required('String20Type'),
            DataFR: required('DataFatturaType'),
            ElementiRettificati: required('String1000LatinType'),
          }),
        },
        { required: true },
      ),
      DatiBeniServizi: list(
        block(
          {
            Descrizione: required('String1000LatinType'),
            Importo: decimal('Amount2DecimalType', 2, 2, true),
            DatiIVA: block({ Imposta: decimal('Amount2DecimalType', 2, 2), Aliquota: decimal('RateType', 2, 2) }, { required: true }),
            Natura: text('NaturaType'),
            RiferimentoNormativo: text('String100LatinType'),
          },
          { required: true },
        ),
        1,
      ),
    },
    { required: true, label: 'FatturaElettronicaBody[0]' },
  ),
});

const MESSAGES: Readonly<Record<RuleFailure, string>> = {
  LEXICAL: 'Formato del valore non valido',
  LENGTH: 'Lunghezza del valore non ammessa',
  ENUMERATION: 'Valore non compreso tra quelli ammessi',
  PATTERN: 'Valore non conforme al formato richiesto',
  RANGE: 'Valore fuori dall’intervallo ammesso',
};

const MISSING = 'Elemento obbligatorio mancante o vuoto';
const NAME_CHOICE = 'Servono Denominazione, oppure Nome e Cognome insieme (mai entrambi)';
const XML_CHARACTER = 'Carattere non ammesso in un documento XML';

/** A character XML 1.0 cannot hold (the XML writer would refuse the text). */
const NOT_XML = new RegExp(String.raw`[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]`, 'u');

interface Context {
  readonly rules: Readonly<Record<string, SimpleTypeRule>>;
  readonly issues: ValidationIssue[];
}

function hasContent(node: Node, value: unknown): boolean {
  switch (node.kind) {
    case 'text':
      return value !== undefined && value !== '';
    case 'decimal':
    case 'integer':
      return value !== undefined;
    case 'object': {
      const record = (value ?? {}) as Readonly<Record<string, unknown>>;
      return Object.entries(node.fields).some(([key, field]) => hasContent(field, record[key]));
    }
    case 'list':
      return ((value ?? []) as readonly unknown[]).some((item) => hasContent(node.item, item));
  }
}

function present(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return (record[key] ?? '') !== '';
}

function isValidNameChoice(record: Readonly<Record<string, unknown>>): boolean {
  const company = present(record, 'Denominazione');
  const first = present(record, 'Nome');
  const last = present(record, 'Cognome');
  return (company && !first && !last) || (!company && first && last);
}

function checkLeaf(context: Context, path: string, type: TypeName, written: string): void {
  if (NOT_XML.test(written)) {
    context.issues.push(error('XSD', path, XML_CHARACTER));
    return;
  }
  const failure = checkValue(context.rules[type] as SimpleTypeRule, written);
  if (failure !== null) {
    context.issues.push(error('XSD', path, MESSAGES[failure]));
  }
}

function walk(context: Context, path: string, node: Node, value: unknown): void {
  if (!hasContent(node, value)) {
    if (node.kind !== 'list' ? node.required : node.min > 0) {
      context.issues.push(error('XSD', path, MISSING));
    }
    return;
  }
  switch (node.kind) {
    case 'text':
      checkLeaf(context, path, node.type, value as string);
      break;
    case 'decimal':
      checkLeaf(context, path, node.type, formatDecimal(value as Decimal, node.min, node.max));
      break;
    case 'integer':
      checkLeaf(context, path, node.type, String(value));
      break;
    case 'object': {
      const record = value as Readonly<Record<string, unknown>>;
      for (const [key, field] of Object.entries(node.fields)) {
        const segment = field.kind === 'object' && field.label !== undefined ? field.label : key;
        walk(context, child(path, segment), field, record[key]);
      }
      if (node.nameChoice && !isValidNameChoice(record)) {
        context.issues.push(error('XSD', path, NAME_CHOICE));
      }
      break;
    }
    case 'list':
      (value as readonly unknown[]).forEach((item, index) => walk(context, `${path}[${index}]`, node.item, item));
      break;
  }
}

/**
 * Validates an invoice model against the simple types, mandatory elements, lists and choices of its official schema.
 *
 * @param model The invoice (ordinary, or simplified when `versione` is `FSM10`).
 * @returns The problems found, all with code `XSD` and severity `error`, in the order the walk found them (sort them
 *   with `sortIssues` for a stable report).
 */
export function validateSchema(model: InvoiceModel): ValidationIssue[] {
  const simplified = model.versione === 'FSM10';
  const context: Context = { rules: simplified ? SIMPLIFIED_RULES : ORDINARY_RULES, issues: [] };
  walk(context, '@versione', required('FormatoTrasmissioneType'), model.versione);
  walk(context, '', simplified ? ROOT_SIMPLIFIED : ROOT_ORDINARY, model);
  return context.issues;
}
