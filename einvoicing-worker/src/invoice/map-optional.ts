/**
 * Optional blocks of the invoice, taken from the `XML` field of a queue record (what the user typed in the invoice
 * form): purchase orders, linked invoices, rectified invoice, transport and payment data.
 *
 * Rules: a block is written only when the record carries its data; an incomplete row is reported, never silently
 * completed; a row with nothing in it (an untouched form row) is skipped.
 *
 * @module
 */
import { compare, round, ZERO } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import { address, formatDate, freeText, has, invalid, missing, optionalCode, requiredCode, requiredInvoiceDate, requiredText } from './map-support.ts';
import type { MapContext } from './map-support.ts';
import type {
  DatiAnagraficiVettore,
  DatiDocumentiCorrelati,
  DatiFatturaRettificata,
  DatiPagamento,
  DatiTrasporto,
  DettaglioPagamento,
} from './model.ts';
import type { QueueCorrelated, QueueTransport, QueueXml } from './queue-record.ts';

function optionalDate(context: MapContext, date: Date | null): string | undefined {
  return date === null ? undefined : formatDate(date, context.timeZone);
}

/** Date-time as ISO 8601 with milliseconds and `Z` (the schema type is `xs:dateTime`). */
function optionalDateTime(date: Date | null): string | undefined {
  return date === null ? undefined : date.toISOString();
}

/**
 * Purchase orders (`DatiOrdineAcquisto`): written only for a row that has a CUP or a CIG (the codes a public
 * administration needs to pay); such a row also needs its `IdDocumento`.
 *
 * @param context Issues and warnings collector.
 * @param rows The rows of the record.
 * @returns The blocks.
 */
export function mapOrders(context: MapContext, rows: readonly QueueCorrelated[]): DatiDocumentiCorrelati[] {
  return rows.flatMap((row, index): DatiDocumentiCorrelati[] => {
    if (row.CodiceCUP.trim() === '' && row.CodiceCIG.trim() === '') {
      return [];
    }
    const path = `FatturaElettronicaBody.DatiGenerali.DatiOrdineAcquisto[${index}]`;
    return [
      {
        IdDocumento: requiredCode(context, `${path}.IdDocumento`, row.IdDocumento, 20),
        ...has('Data', optionalDate(context, row.Data)),
        ...has('CodiceCUP', optionalCode(context, `${path}.CodiceCUP`, row.CodiceCUP, 15)),
        ...has('CodiceCIG', optionalCode(context, `${path}.CodiceCIG`, row.CodiceCIG, 15)),
      },
    ];
  });
}

/**
 * Linked invoices (`DatiFattureCollegate`), needed by a credit note to cite the invoice it corrects. The legacy record
 * only holds the id of the original document, so the block is written only when the form data carries the number.
 *
 * @param context Issues and warnings collector.
 * @param rows The rows of the record.
 * @returns The blocks.
 */
export function mapLinkedInvoices(context: MapContext, rows: readonly QueueCorrelated[]): DatiDocumentiCorrelati[] {
  return rows.flatMap((row, index): DatiDocumentiCorrelati[] => {
    const id = optionalCode(context, `FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate[${index}].IdDocumento`, row.IdDocumento, 20);
    return id === undefined ? [] : [{ IdDocumento: id, ...has('Data', optionalDate(context, row.Data)) }];
  });
}

/**
 * Rectified invoice of a simplified credit note (`DatiFatturaRettificata`): written when the number is present, and
 * then the date and the rectified elements are required.
 *
 * @param context Issues and warnings collector.
 * @param rectified The block of the record.
 * @returns The block, or `undefined`.
 */
export function mapRectified(context: MapContext, rectified: QueueXml['rectified']): DatiFatturaRettificata | undefined {
  if (rectified.NumeroFR.trim() === '') {
    return undefined;
  }
  const path = 'FatturaElettronicaBody.DatiGenerali.DatiFatturaRettificata';
  return {
    NumeroFR: requiredCode(context, `${path}.NumeroFR`, rectified.NumeroFR, 20),
    DataFR: requiredInvoiceDate(context, `${path}.DataFR`, rectified.DataFR),
    ElementiRettificati: requiredText(context, `${path}.ElementiRettificati`, rectified.ElementiRettificati, 'latin', 1000),
  };
}

function mapCarrier(context: MapContext, carrier: QueueTransport['carrier'], path: string): DatiAnagraficiVettore | undefined {
  if (Object.values(carrier).every((value) => value.trim() === '')) {
    return undefined;
  }
  const company = freeText(context, `${path}.Anagrafica.Denominazione`, carrier.Denominazione, 'latin', 80);
  const given = freeText(context, `${path}.Anagrafica.Nome`, carrier.Nome, 'latin', 60);
  const family = freeText(context, `${path}.Anagrafica.Cognome`, carrier.Cognome, 'latin', 60);
  let name: DatiAnagraficiVettore['Anagrafica'];
  if (company !== undefined) {
    name = { Denominazione: company };
  } else if (given !== undefined && family !== undefined) {
    name = { Nome: given, Cognome: family };
  } else {
    missing(context, `${path}.Anagrafica`);
    name = { Denominazione: '' };
  }
  const title = optionalCode(context, `${path}.Anagrafica.Titolo`, carrier.Titolo, 10, /^.{2,10}$/);
  const eori = optionalCode(context, `${path}.Anagrafica.CodEORI`, carrier.CodEORI, 17, /^.{13,17}$/);
  return {
    IdFiscaleIVA: {
      IdPaese: requiredCode(context, `${path}.IdFiscaleIVA.IdPaese`, carrier.IdPaese.toUpperCase(), 2, /^[A-Z]{2}$/),
      IdCodice: requiredCode(context, `${path}.IdFiscaleIVA.IdCodice`, carrier.IdCodice.toUpperCase(), 28),
    },
    ...has('CodiceFiscale', optionalCode(context, `${path}.CodiceFiscale`, carrier.CodiceFiscale.toUpperCase(), 16, /^[A-Z0-9]{11,16}$/)),
    Anagrafica: { ...name, ...has('Titolo', title), ...has('CodEORI', eori) },
    ...has('NumeroLicenzaGuida', optionalCode(context, `${path}.NumeroLicenzaGuida`, carrier.NumeroLicenzaGuida, 20)),
  };
}

/** Number of packages: a whole number from 1 to 9999 (`NumeroColliType`). */
function packageCount(context: MapContext, path: string, value: Decimal | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const whole = round(value, 0);
  const count = Number(whole.units);
  if (compare(whole, value) !== 0 || count < 1 || count > 9999) {
    invalid(context, path);
    return undefined;
  }
  return count;
}

function weight(context: MapContext, path: string, value: Decimal | null): Decimal | undefined {
  if (value === null) {
    return undefined;
  }
  const rounded = round(value, 2);
  // `PesoType`: up to four integer digits and two decimals, never negative.
  if (compare(rounded, ZERO) < 0 || rounded.units > 999999n) {
    invalid(context, path);
    return undefined;
  }
  return rounded;
}

/**
 * Transport data (`DatiTrasporto`): written when at least one field is filled in. The carrier block is all or
 * nothing; the delivery address needs its street, postcode, city and country.
 *
 * @param context Issues and warnings collector.
 * @param transport The block of the record.
 * @returns The block, or `undefined` when the record has no transport data.
 */
export function mapTransport(context: MapContext, transport: QueueTransport): DatiTrasporto | undefined {
  const path = 'FatturaElettronicaBody.DatiGenerali.DatiTrasporto';
  const carrier = mapCarrier(context, transport.carrier, `${path}.DatiAnagraficiVettore`);
  const delivery = transport.IndirizzoResa;
  const deliveryFilled = Object.values(delivery).some((value) => value.trim() !== '');
  const block: DatiTrasporto = {
    ...has('DatiAnagraficiVettore', carrier),
    ...has('MezzoTrasporto', freeText(context, `${path}.MezzoTrasporto`, transport.MezzoTrasporto, 'latin', 80)),
    ...has('CausaleTrasporto', freeText(context, `${path}.CausaleTrasporto`, transport.CausaleTrasporto, 'latin', 100)),
    ...has('NumeroColli', packageCount(context, `${path}.NumeroColli`, transport.NumeroColli)),
    ...has('Descrizione', freeText(context, `${path}.Descrizione`, transport.Descrizione, 'latin', 100)),
    ...has('UnitaMisuraPeso', optionalCode(context, `${path}.UnitaMisuraPeso`, transport.UnitaMisuraPeso, 10)),
    ...has('PesoLordo', weight(context, `${path}.PesoLordo`, transport.PesoLordo)),
    ...has('PesoNetto', weight(context, `${path}.PesoNetto`, transport.PesoNetto)),
    ...has('DataOraRitiro', optionalDateTime(transport.DataOraRitiro)),
    ...has('DataInizioTrasporto', optionalDate(context, transport.DataInizioTrasporto)),
    ...has('TipoResa', optionalCode(context, `${path}.TipoResa`, transport.TipoResa.toUpperCase(), 3, /^[A-Z]{3}$/)),
    ...has(
      'IndirizzoResa',
      deliveryFilled
        ? address(context, `${path}.IndirizzoResa`, {
            street: delivery.Indirizzo,
            civic: delivery.NumeroCivico,
            postcode: delivery.CAP,
            city: delivery.Comune,
            area: delivery.Provincia,
            country: delivery.Nazione,
          })
        : undefined,
    ),
    ...has('DataOraConsegna', optionalDateTime(transport.DataOraConsegna)),
  };
  return Object.keys(block).length === 0 ? undefined : block;
}

/**
 * Payment data (`DatiPagamento`): written when the record has the conditions and at least one detail row. A row needs
 * both the payment method and the amount (a row with neither is an untouched form row and is skipped).
 *
 * @param context Issues and warnings collector.
 * @param xml The optional block of the record.
 * @returns The block as a list of at most one element.
 */
export function mapPayments(context: MapContext, xml: QueueXml): DatiPagamento[] {
  const path = 'FatturaElettronicaBody.DatiPagamento.DettaglioPagamento';
  const details = xml.paymentDetails.flatMap((row, index): DettaglioPagamento[] => {
    const rowPath = `${path}[${index}]`;
    const method = row.ModalitaPagamento.trim();
    if (method === '' && row.ImportoPagamento === null) {
      return [];
    }
    const amount = row.ImportoPagamento;
    if (amount === null) {
      missing(context, `${rowPath}.ImportoPagamento`);
    }
    return [
      {
        ...has('Beneficiario', freeText(context, `${rowPath}.Beneficiario`, row.Beneficiario, 'latin', 200)),
        ModalitaPagamento: requiredCode(context, `${rowPath}.ModalitaPagamento`, method.toUpperCase(), 4),
        ...has('DataScadenzaPagamento', optionalDate(context, row.DataScadenzaPagamento)),
        ImportoPagamento: round(amount ?? ZERO, 2),
        ...has('IstitutoFinanziario', freeText(context, `${rowPath}.IstitutoFinanziario`, row.IstitutoFinanziario, 'latin', 80)),
        ...has('IBAN', optionalCode(context, `${rowPath}.IBAN`, row.IBAN.replace(/\s+/g, '').toUpperCase(), 34)),
        ...has('ABI', optionalCode(context, `${rowPath}.ABI`, row.ABI.replace(/\s+/g, ''), 5)),
        ...has('CAB', optionalCode(context, `${rowPath}.CAB`, row.CAB.replace(/\s+/g, ''), 5)),
        ...has('BIC', optionalCode(context, `${rowPath}.BIC`, row.BIC.replace(/\s+/g, '').toUpperCase(), 11)),
      },
    ];
  });
  const conditions = xml.paymentConditions.trim().toUpperCase();
  if (conditions === '' || details.length === 0) {
    return [];
  }
  return [{ CondizioniPagamento: requiredCode(context, 'FatturaElettronicaBody.DatiPagamento.CondizioniPagamento', conditions, 4), DettaglioPagamento: details }];
}
