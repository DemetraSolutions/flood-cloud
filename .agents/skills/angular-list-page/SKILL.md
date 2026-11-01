---
name: angular-list-page
description: Usa quando crei una pagina elenco del backoffice (prodotti, utenti, punti vendita…): filtri, ricerca e ordinamento nei query parameter, paginazione a cursore del backend, httpResource, quattro stati della vista, azioni di riga e selezione, permessi.
---
# Angular List Page

Il backoffice è fatto soprattutto di elenchi: tutti seguono questo schema, così si comportano allo stesso modo.

## Stato nell'URL
- Filtri, ricerca (`q`), ordinamento (`sort`) e cursore (`cursor`) sono **query parameter**: ricarica, link condivisi e pulsante indietro funzionano.
- La pagina li riceve come input (`withComponentInputBinding`) e li converte in un oggetto filtri con `computed`.
- Cambiare un filtro naviga con i nuovi parametri e **azzera il cursore**.
- La ricerca testuale aggiorna l'URL dopo una breve pausa di digitazione (timer controllato; `debounced()` è sperimentale e non si usa senza approvazione).

## Dati
```ts
/** Products list page: URL-driven filters, cursor pagination, four explicit view states. */
export class ProductListPage {
  readonly groupId = input.required<string>();
  readonly q = input<string>();
  readonly status = input<ProductStatus>();
  readonly cursor = input<string>();

  private readonly api = inject(ProductsApi);
  private readonly filters = computed(() => ({ q: this.q(), status: this.status(), cursor: this.cursor() }));
  protected readonly products = this.api.list(this.groupId, this.filters);
  protected readonly permissions = inject(Permissions);
}
```
- La paginazione è **a cursore** (`page.next`): pulsanti "Successivi" e, se serve, "Precedenti" tenendo la pila dei cursori visitati nella navigazione; nessun numero di pagina totale (il backend non lo fornisce).
- `limit` di default del backend; selettore del numero di righe solo se richiesto.

## Vista
1. Intestazione con titolo, conteggio della pagina corrente e azione primaria ("Nuovo prodotto") solo con il permesso di scrittura.
2. Barra filtri con controlli etichettati e pulsante "Azzera filtri".
3. Tabella del design system (`data-table`): intestazioni semantiche, ordinamento accessibile (`aria-sort`), azioni di riga coerenti.
4. Stati: `skeleton` durante il caricamento, `empty-state` (distinguendo "nessun dato" da "nessun risultato per questi filtri"), `error-state` con "Riprova" (`reload()`).
5. Azioni distruttive con `confirm-dialog`; dopo l'azione, `reload()` e toast di esito.

## Test
Parametri dell'URL tradotti in richiesta corretta; cambio filtro che azzera il cursore; pagina successiva; quattro stati; azioni visibili solo con i permessi; conferma prima dell'eliminazione.
