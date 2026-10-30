---
name: input-validation
description: Usa quando validi body, query o params di una richiesta: schemi per allowlist senza librerie esterne, rifiuto di proprietà sconosciute e di operatori MongoDB, conversione di ObjectId e date, errori 422 con dettagli per campo.
---
# Input Validation (senza librerie)

Nessuna libreria di validazione è approvata: si usa un validatore interno piccolo, in `src/shared/validation/`, coperto al 100% dai test. Se in futuro servisse una libreria, si passa da `dependency-approval`.

## Regole
1. **Allowlist:** lo schema elenca tutti i campi ammessi; qualunque altra proprietà ⇒ 422 `unknown_field`.
2. **Chiavi pericolose:** rifiuta ricorsivamente le chiavi che iniziano con `$`, contengono `.`, o valgono `__proto__`, `constructor`, `prototype`.
3. **Tipi stretti:** nessuna coercizione implicita nel body JSON (`"5"` non è un numero). Le query string sono sempre stringhe: si convertono esplicitamente (numeri, booleani `true`/`false`, liste separate da virgola con limite di elementi).
4. **Limiti ovunque:** lunghezza minima/massima delle stringhe, intervallo dei numeri, numero massimo di elementi degli array, profondità degli oggetti.
5. **Normalizzazione:** `trim`, email in minuscolo, stringhe Unicode in `NFC`.
6. **ObjectId:** validati con `ObjectId.isValid` più controllo di formato (24 caratteri esadecimali), poi convertiti; un id malformato nei params ⇒ 404, non 500.
7. **Output:** `req.valid = { body, query, params }` con valori convertiti; i controller non leggono mai l'input grezzo.
8. **Errori:** `AppError(422, 'VALIDATION_ERROR', 'Invalid request', [{ field, issue }])` con tutti i problemi trovati, senza riecheggiare i valori inviati.

## Forma di uno schema
```js
/** Schema del body di creazione prodotto. */
export const createProductBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    price: { type: 'integer', minimum: 0, maximum: 100_000_000 }, // centesimi
    placeIds: { type: 'array', items: { type: 'objectId' }, maxItems: 500 },
    status: { type: 'string', enum: ['active', 'archived'] },
  },
  required: ['name', 'price'],
  additionalProperties: false,
};
```
Mantieni il formato vicino a JSON Schema: è leggibile, documentabile in `doc/API.md` e riusabile come `$jsonSchema` lato MongoDB dove ha senso.

## Ricerca testuale
Mai `new RegExp(input)`: esegui l'escape (`input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`), limita la lunghezza e ancorare a prefisso (`^`) quando possibile per usare gli indici.

## Test minimi per ogni schema
Campo mancante, tipo errato, oltre i limiti, proprietà sconosciuta, chiave `$gt`, chiave con punto, `__proto__`, valore valido convertito correttamente.
