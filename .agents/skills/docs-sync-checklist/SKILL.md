---
name: docs-sync-checklist
description: Usa al termine di ogni passo per verificare gli aggiornamenti obbligatori: JSDoc in inglese, documentazione tecnica, riferimento API, documentazione delle API pubbliche, modello dati, .env.example, registro di agenti e skill, copertura dei test.
---
# Docs Sync Checklist

Un passo sembra finito quando il codice funziona, ma non lo è finché questa lista non è verificata.

## Checklist
- [ ] **JSDoc in inglese** dettagliato su ogni modulo, funzione, classe, typedef e costante esportata nuovi o modificati; commenti nel codice in inglese.
- [ ] **`doc/Technical-Guide.md`**: aggiornate le sezioni toccate dal passo (configurazione, struttura, pipeline, moduli, database, sicurezza, test) e aggiunta una riga al registro dei passi.
- [ ] **`doc/API.md`**: ogni endpoint aggiunto o modificato è descritto (metodo, percorso, autenticazione, permesso, parametri, risposta, errori). Si aggiorna senza richiesta esplicita (`GEMINI.md` §7), solo per riflettere ciò che è stato realizzato.
- [ ] **`doc/Public-API.md`**: ogni endpoint di `/public/v1` aggiunto o modificato è descritto per gli integratori esterni, con esempi completi; **nessun** riferimento a superfici interne, collection, struttura dei database o dettagli implementativi.
- [ ] **`doc/Data-Model.md`**: ogni collection o campo aggiunto o modificato è descritto con tipi, indici e vincoli (stessa eccezione di `doc/API.md`).
- [ ] **`.env.example`**: ogni nuova variabile d'ambiente è elencata con descrizione e senza valore reale.
- [ ] **Test al 100%**: `npm test` nel backend e `ng test` con copertura nel backoffice passano con le soglie al 100%.
- [ ] **Kit AI**: se sono cambiati agenti o skill, `AGENTS.md` è aggiornato e `./scripts/sync-agents.sh --check` passa.
- [ ] **Altri documenti** (`doc/Security-Model.md`, `doc/Architecture.md`, `doc/API-Guidelines.md`, `doc/Product-Scope.md`…): se il passo ha preso decisioni che li riguardano, **proponi** la modifica all'utente invece di farla.

## Verifica finale
Rileggi `doc/API.md` chiedendoti se chi sviluppa il backoffice o il POS riuscirebbe a usare l'endpoint leggendo solo quelle righe.
