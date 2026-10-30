---
name: docs-sync-checklist
description: Usa al termine di ogni passo per verificare gli aggiornamenti obbligatori: riferimento API, .env.example, registro di agenti e skill, sincronizzazione .agents → .claude, copertura dei test.
---
# Docs Sync Checklist

Un passo sembra finito quando il codice funziona, ma non lo è finché questa lista non è verificata.

## Checklist
- [ ] **`doc/API.md`**: ogni endpoint aggiunto o modificato è descritto (metodo, percorso, autenticazione, permesso, parametri, risposta, errori). È l'unico documento in `doc/` che si aggiorna senza richiesta esplicita (`GEMINI.md` §7), e solo per riflettere ciò che è stato realizzato.
- [ ] **`.env.example`**: ogni nuova variabile d'ambiente è elencata con descrizione e senza valore reale.
- [ ] **`npm test`** passa con le soglie al 100%.
- [ ] **JSDoc** presente e coerente su ogni export nuovo o modificato.
- [ ] **Kit AI**: se sono cambiati agenti o skill, `AGENTS.md` è aggiornato e `./scripts/sync-agents.sh --check` passa.
- [ ] **Altri documenti** (`doc/Security-Model.md`, `doc/Product-Scope.md`…): se il passo ha preso decisioni che li riguardano, **proponi** la modifica all'utente invece di farla.

## Verifica finale
Rileggi `doc/API.md` chiedendoti se chi sviluppa il backoffice o il POS riuscirebbe a usare l'endpoint leggendo solo quelle righe.
