---
name: angular-component
description: Usa quando crei o modifichi un componente del backoffice Angular 22: standalone, OnPush di default, input/output/model a signal, query a signal, host object, control flow, nomi file secondo la style guide 2025, separazione tra pagine e componenti di presentazione.
---
# Angular Component (v22)

## Generazione
`ng generate component features/products/product-list` e poi adatta: il codice generato dalla CLI installata è il riferimento per la sintassi corrente. File: `product-list.ts`, `product-list.html`, `product-list.css`, `product-list.spec.ts` (nessun suffisso `.component`).

## Componente di presentazione
```ts
import { Component, computed, input, output } from '@angular/core';

/** Read-only table row for a product; emits user intents, owns no data access. */
@Component({
  selector: 'app-product-row',
  templateUrl: './product-row.html',
  styleUrl: './product-row.css',
  host: { role: 'row', '[class.is-archived]': 'archived()' },
})
export class ProductRow {
  readonly product = input.required<Product>();
  readonly canEdit = input(false);
  readonly edit = output<string>();

  protected readonly archived = computed(() => this.product().status === 'archived');
  protected readonly price = computed(() => formatCents(this.product().priceCents));

  protected onEdit(): void {
    this.edit.emit(this.product().id);
  }
}
```
```html
<span role="cell">{{ product().name }}</span>
<span role="cell">{{ price() }}</span>
@if (canEdit()) {
  <button type="button" (click)="onEdit()">Modifica</button>
}
```

## Regole
1. Niente `standalone: true` (default), niente `changeDetection` (OnPush è il default in v22), niente `NgModule`/`CommonModule`.
2. `input()`, `input.required()`, `output()`, `model()` per il two-way binding; `viewChild()`/`contentChild()` per le query.
3. Stato derivato con `computed`; nei template solo letture di signal e chiamate semplici.
4. `@for` sempre con `track` su un identificativo stabile (`track item.id`), con blocco `@empty` quando ha senso.
5. Host bindings e listener nell'oggetto `host`.
6. `readonly` per input, output, query e signal; `protected` per i membri usati solo dal template.
7. Gestori nominati per ciò che fanno (`onEdit`, `saveDraft`), non per l'evento (`handleClick`).
8. **Pagine** (in `features/<feature>/pages/`): ricevono parametri di route come input, usano i servizi della feature, gestiscono i quattro stati (caricamento, vuoto, errore, contenuto). **Componenti di presentazione**: solo input/output, nessun servizio di dati.
9. `@defer` per parti pesanti e non immediatamente visibili (es. grafici).
10. Testi in italiano nel template; nessun HTML costruito per stringa, nessun `innerHTML` con dati del server.
11. JSDoc in inglese su classe e membri pubblici.

## Test
Skill `angular-testing`: input via `setInput`, output, stati, accessibilità.
