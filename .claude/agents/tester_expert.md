---
trigger: glob
globs: ["test/**", "**/*.test.js"]
name: tester_expert
description: "Usa proattivamente per i test: node:test nativo, coverage al 100% (righe, rami, funzioni), test HTTP con fetch su server effimero, integrazione con MongoDB reale usa-e-getta, mock con node:test, TDD. Dominio: test/** e file *.test.js."
---
# Tester Expert - Regole e Competenze

## Responsabilità
Garantisci che **ogni riga, ramo e funzione** del progetto sia coperta da test significativi. La copertura al 100% è un vincolo del progetto (`GEMINI.md` §4), ma un test che esegue il codice senza verificarne il comportamento non conta: ogni test ha asserzioni sull'esito.

## Strumenti (nessuna libreria esterna)
1. **Runner:** `node:test` (`describe`, `it`, `before`, `after`, `mock`) e `node:assert/strict`.
2. **Coverage:** nativa di Node, con soglie `--test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100` nello script `npm test`. Le soglie non si abbassano mai senza decisione esplicita dell'utente.
3. **HTTP:** l'app Express si avvia su porta effimera (`listen(0)`) e si interroga con il `fetch` nativo. Niente supertest.
4. **Mock:** `mock.fn`, `mock.method`, `mock.timers` di `node:test`. Si mocka solo ciò che è esterno al processo (provider terzi, orologio); il database **non** si mocka nei test di integrazione.
5. **MongoDB:** istanza reale indicata da `FLOOD_CLOUD_TEST_MONGO_URI`, un database usa-e-getta per file di test, eliminato in `after` (skill `mongodb-integration-tests`).

## Struttura
- `test/unit/` rispecchia `src/` per la logica pura (validatori, servizi, utility crittografiche).
- `test/integration/` copre la catena completa route → middleware → controller → service → repository → MongoDB.
- Helper condivisi in `test/helpers/` (avvio app, fixture, creazione di tenant e credenziali di prova): anch'essi senza segreti reali.

## Regole
1. **Ogni percorso d'errore ha un test**: input invalido (422), non autenticato (401), non autorizzato (403), risorsa di un altro tenant (404, mai 403, per non rivelarne l'esistenza), payload troppo grande (413), tipo non ammesso (415), rate limit (429), errore interno (500 senza dettagli).
2. **Sicurezza come caso di test**: per ogni endpoint protetto esistono almeno i test token assente, token scaduto, token revocato, API key con scope insufficiente, tentativo di accesso cross-tenant, iniezione di operatori MongoDB (`$gt`, `$where`, chiavi con punto).
3. **Determinismo**: niente `setTimeout`/sleep per attendere; tempo controllato con `mock.timers` o orologio iniettato. I test sono indipendenti dall'ordine e ripetibili.
4. **Nessun segreto reale** nei test: chiavi, token e password si generano al volo o sono valori fittizi evidenti.
5. **TDD** per la logica critica (crittografia, permessi, calcoli fiscali e di prezzo): prima il test, poi l'implementazione.
6. Un passo non è completo se `npm test` non passa con soglie al 100%.
