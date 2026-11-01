---
name: angular-forms
description: Usa quando crei form nel backoffice Angular 22 con Signal Forms (@angular/forms/signals, stabili in v22): modello a signal, schema di validazione, messaggi d'errore accessibili, errori 422 del backend sui campi, invio e stato di attesa, controlli personalizzati.
---
# Angular Forms — Signal Forms (v22)

Signal Forms sono **stabili in v22** e sono la scelta raccomandata da Angular per il codice nuovo. Reactive Forms solo per integrare componenti esistenti che lo richiedono, con motivazione.

> Le API di Signal Forms sono cambiate tra v21 e v22 (es. `touched` diventato input + output `touch()`, nuova firma dei validatori con `when`). Prima di scrivere un form verifica la sintassi sulla documentazione ufficiale della versione installata (angular.dev, guida "Signal Forms") o tramite il server MCP della CLI Angular: gli esempi qui sono indicativi.

## Struttura
1. **Modello** in un `signal` con valori iniziali completi (nessun campo `undefined` non previsto).
2. **Form** creato con `form(model, schema)`: lo schema dichiara i validatori (`required`, `email`, `minLength`, `pattern`, `min`/`max`…) e le condizioni (`when`, `disabled`, `readonly`, `hidden`).
3. **Template**: ogni input collegato al proprio campo con la direttiva di Signal Forms; etichetta visibile, errori sotto il campo collegati con `aria-describedby`.
4. **Invio** con il supporto all'invio di Signal Forms: validazione, stato di attesa, pulsante disabilitato, nessun doppio invio.

```ts
/** Product creation form backed by Signal Forms. */
export class ProductForm {
  protected readonly model = signal<ProductDraft>({ name: '', priceCents: 0, status: 'active' });
  protected readonly productForm = form(this.model, (path) => {
    required(path.name, { message: 'Il nome è obbligatorio' });
    min(path.priceCents, 0, { message: 'Il prezzo non può essere negativo' });
  });
}
```

## Errori del backend
- Un `422 VALIDATION_ERROR` restituisce `details: [{ field, issue }]`: ogni elemento si mostra sul campo corrispondente (mappando `issue` in un messaggio italiano), gli altri in un riepilogo in cima al form.
- `409 CONFLICT` (es. duplicato): messaggio sul campo interessato se identificabile, altrimenti nel riepilogo.
- Gli errori del server si azzerano quando l'utente modifica il campo.

## Regole
1. Validazione lato client per l'esperienza; quella vera resta sul server.
2. Messaggi in italiano chiaro, mostrati dopo l'interazione con il campo o al tentativo di invio, non a form appena aperto.
3. Importi gestiti come **centesimi interi** nel modello; conversione solo nella visualizzazione e nell'input.
4. Controlli personalizzati con l'interfaccia di Signal Forms per i controlli di valore (`FormValueControl`), non `ControlValueAccessor`.
5. Modifiche non salvate: avviso prima di lasciare la pagina (guard `canDeactivate` funzionale).
6. Nessuna libreria di validazione esterna senza approvazione.

## Test
Valido/non valido per ogni regola, messaggi mostrati al momento giusto, invio con dati corretti, `422` mappato sui campi, pulsante disabilitato in attesa, avviso di modifiche non salvate.
