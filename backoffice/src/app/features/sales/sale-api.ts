import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** The fiscal receipt of a refund, of a cancellation or of an amendment (decimal amounts, the currency of the group). */
export interface FiscalReceiptBody {
  date?: string | null;
  report?: number | null;
  number?: number | null;
  amount?: number | null;
}

/** Body of the amendment of a sale (`PATCH`): only what changed (merge patch). */
export interface AmendBody {
  payments?: {
    cash?: number;
    electronic?: number;
    cheque?: number;
    tickets?: number;
    fidelityCredit?: number;
  };
  /** The contact of the customer, `null` to take the customer away. */
  customer?: { contactId: string } | null;
  fidelityCardCode?: string | null;
  fiscalReceiptInfo?: FiscalReceiptBody | null;
  lotteryCode?: string | null;
}

/** Body of a refund (`POST …/refunds`). */
export interface RefundBody {
  /** The key of the refund: new for each refund; kept by the dialog when the outcome of a send is not known, so a repeated request is the same refund. */
  timestampId: string;
  date: string;
  products: { index: number; productId?: string; quantity: number }[];
  value?: { taxable: number; tax: number; total: number };
  fiscalReceiptInfo?: FiscalReceiptBody;
}

/** Body of the cancellation (`POST …/cancellation`). */
export interface CancelBody {
  date: string;
  fiscalReceiptInfo?: FiscalReceiptBody;
}

/**
 * The writes of a sale from the backoffice (`/v1/groups/{groupId}/sales/{saleId}`): amendment,
 * refund, cancellation and the deletion of a quote. Each carries the version of the sale in
 * `If-Match` (the `version` of the detail, in quotes) and, for a non fiscal sale, `nonFiscal=include`
 * (without it the server does not find it). The sale is read again by the page after each write:
 * the answers are not used.
 */
@Service()
export class SaleApi {
  private readonly http = inject(HttpClient);

  /** Corrects the payments, the customer, the card, the fiscal receipt or the lottery code. */
  async amend(
    groupId: string,
    saleId: string,
    version: string,
    nonFiscal: boolean,
    body: AmendBody,
  ): Promise<void> {
    await firstValueFrom(this.http.patch(this.url(groupId, saleId), body, this.options(version, nonFiscal)));
  }

  /** Registers a refund, whole or partial (repeatable: the `timestampId` makes it idempotent). */
  async refund(
    groupId: string,
    saleId: string,
    version: string,
    nonFiscal: boolean,
    body: RefundBody,
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.url(groupId, saleId)}/refunds`, body, this.options(version, nonFiscal)),
    );
  }

  /** Cancels the sale: stock and loyalty go back as before it. */
  async cancel(
    groupId: string,
    saleId: string,
    version: string,
    nonFiscal: boolean,
    body: CancelBody,
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.url(groupId, saleId)}/cancellation`, body, this.options(version, nonFiscal)),
    );
  }

  /** Deletes a quote for good (`204`); the server only deletes a non fiscal sale and wants `nonFiscal=include`. */
  async remove(groupId: string, saleId: string, version: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.url(groupId, saleId), this.options(version, true)));
  }

  private url(groupId: string, saleId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/sales/${encodeURIComponent(saleId)}`;
  }

  private options(version: string, nonFiscal: boolean) {
    return {
      headers: new HttpHeaders({ 'If-Match': `"${version}"` }),
      ...(nonFiscal ? { params: { nonFiscal: 'include' } } : {}),
    };
  }
}
