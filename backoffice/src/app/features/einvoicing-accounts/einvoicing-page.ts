import { Component } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { EInvoicingAccountCard } from './einvoicing-account-card';

/** E-invoicing (`/tools/e-invoicing`, platform administrators): the Aruba account of the platform ("Account Flood"). */
@Component({
  selector: 'fc-einvoicing-page',
  imports: [EInvoicingAccountCard, PageHeader, TPipe],
  templateUrl: './einvoicing-page.html',
  styleUrl: './einvoicing-page.css',
})
export class EInvoicingPage {}
