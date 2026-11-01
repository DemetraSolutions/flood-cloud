# Registro dei Sottoagenti

Questo progetto adotta un'architettura multi-agente per compartimentare le competenze e garantire codice sicuro, testato al 100% e coerente con l'architettura.

Questo file è **l'unica fonte autoritativa** dell'elenco dei sottoagenti e delle skill. Le regole di comportamento comuni sono in `GEMINI.md` e valgono per tutti.

## Struttura dei file (fonte unica, doppio ambiente)

Il progetto è utilizzabile indifferentemente con **Antigravity/Gemini** e con **Claude Code**. I due ambienti leggono percorsi diversi, quindi i file degli agenti sono **duplicati fisicamente**:

| Contenuto | Sorgente autoritativa (da modificare) | Duplicato Claude Code |
|---|---|---|
| Regole globali | `GEMINI.md` + `AGENTS.md` (root) | nessuno: `CLAUDE.md` li importa con `@GEMINI.md` / `@AGENTS.md` |
| Regole dei sottoagenti | `.agents/rules/<nome>.md` | `.claude/agents/<nome>.md` |
| Skill tecniche | `.agents/skills/<nome>/SKILL.md` | `.claude/skills/<nome>/SKILL.md` |

**REGOLA OPERATIVA TASSATIVA.** In caso di divergenza fa fede **sempre `.agents/`**:
1. Modifica **sempre e solo** i file sotto `.agents/` (e i file di root).
2. Subito dopo esegui `./scripts/sync-agents.sh`, che riallinea `.claude/`.
3. Non modificare mai direttamente `.claude/agents/` o `.claude/skills/`: la modifica andrebbe persa al primo sync.
4. Le due copie si committano **sempre insieme**.

Verifica senza scrivere (prima di un commit): `./scripts/sync-agents.sh --check` (exit 1 se ci sono divergenze o file orfani).

**Frontmatter condiviso** di `.agents/rules/`:
- `trigger` + `globs`: usati da Antigravity; `trigger: glob` attiva la regola sui file del dominio, `model_decision` per gli agenti trasversali (`security_expert`, `legacy_analyst`).
- I percorsi nei `globs` partono dalla radice del repository (`backend/…`, `backoffice/…`); dentro regole e skill del backend, `src/` e `test/` sono relativi a `backend/`.
- `name`: identificativo del sottoagente per Claude Code.
- `description`: usata da entrambi per decidere l'attivazione; specifica, orientata al dominio, con la formula "Usa proattivamente".

**Limite:** Antigravity accetta al massimo 12.000 caratteri per file di regole: verificalo quando estendi `GEMINI.md`, `AGENTS.md` o un file in `.agents/rules/`.

## Documentazione di riferimento
| Documento | Contenuto |
|---|---|
| `doc/Product-Scope.md` | Scopo del prodotto, client, ruoli, obiettivi |
| `doc/Architecture.md` | Stack, multi-database, superfici API, struttura del codice |
| `doc/Security-Model.md` | Credenziali delle tre superfici, autorizzazione, rate limit, decisioni aperte |
| `doc/Data-Model.md` | Collection del database common |
| `doc/API-Guidelines.md` | Regole REST vincolanti |
| `doc/Legacy-Analysis.md` | Cosa fa il progetto legacy (riferimento funzionale) |
| `doc/Technical-Guide.md` | Documentazione tecnica del backend realizzato (mantenuta a ogni passo) |
| `doc/API.md` | Riferimento di tutte le API delle tre superfici (mantenuto a ogni passo) |
| `doc/Public-API.md` | Documentazione delle API pubbliche per gli integratori esterni (mantenuta a ogni passo) |

## Sottoagenti disponibili

### 1. Backend Expert (`backend_expert`)
Server Node.js 24 + Express 5 in ESM.
- App factory testabile, moduli di dominio a strati (route → controller → service → repository).
- Configurazione validata all'avvio, body-parser, compression, multer, arresto ordinato.

### 2. DB Expert (`db_expert`)
MongoDB con il driver ufficiale, senza ODM.
- Database common (identità e tenancy) + un database per gruppo, nomi dipendenti dall'ambiente.
- Repository con scope, indici idempotenti (univoci, TTL), `$jsonSchema`.
- Paginazione a cursore, update atomici, transazioni dove servono.

### 3. Security Expert (`security_expert`)
Garante di `doc/Security-Model.md`; obbligatorio su ogni modifica di sicurezza.
- Tre superfici: backoffice con token opachi e refresh rotante, server di punto vendita con chiavi Ed25519, API pubbliche con chiavi per gruppo.
- scrypt, RBAC (PSA, D, SA, CA, PA, E), isolamento dei gruppi, rate limit e quote, validazione, upload, webhook, header, CORS, segreti e log.

### 4. Tester Expert (`tester_expert`)
Copertura al 100% con strumenti nativi.
- `node:test`, coverage nativa con soglie, test HTTP con `fetch` su porta effimera.
- Integrazione con MongoDB reale usa-e-getta, test di rifiuto di sicurezza, TDD.

### 5. API Expert (`api_expert`)
Contratto REST rigoroso secondo `doc/API-Guidelines.md`.
- Risorse e metodi HTTP corretti sulle superfici `/v1`, `/store/v1`, `/public/v1`, nessuna query MongoDB dal client, schemi di validazione.
- Codici HTTP, envelope ed errori, paginazione, idempotenza, `doc/API.md` e `doc/Public-API.md`.

### 6. Legacy Analyst (`legacy_analyst`)
Esperto del progetto `../cloud-commerce-platform-server` (sola lettura).
- Analisi di un servizio `ms-*` prima della riscrittura del dominio, specifica funzionale, impatto sui client.
- Mai segreti del legacy in output.

### 7. Integrations Expert (`integrations_expert`)
Provider esterni (Aruba, Fiskaly, Satispay, Dojo, Cerved, storage, email).
- Adattatori isolati, `fetch` con timeout e retry, rate limit dei provider, code persistenti, webhook verificati.

### 8. DevOps Expert (`devops_expert`)
Ambiente e rilascio del monorepo.
- Dockerfile multi-stage non root, compose con MongoDB, pipeline separate per `backend/` e `backoffice/` con filtri sui percorsi, deploy su GKE (Deployment e Service per componente).
- CI con test al 100%, audit e secret scanning, segreti fuori dal repository.

### 9. Angular Expert (`angular_expert`)
Backoffice in Angular 22 (`backoffice/`).
- Standalone, signals, zoneless e OnPush di default, `inject()` e `@Service`, `httpResource`, routing lazy con guard funzionali, Signal Forms.
- Architettura per feature: `core/`, `shared/ui/`, `features/<feature>/`.

### 10. UX/UI Expert (`ux_ui_expert`)
Interfaccia del backoffice.
- Design token e CSS custom properties, tema chiaro/scuro, accessibilità WCAG 2.2 AA, stati di caricamento/vuoto/errore, pattern di amministrazione.

### 11. Angular Tester (`angular_tester`)
Test del backoffice al 100%.
- Vitest con `@angular/build:unit-test`, TestBed zoneless, `HttpTestingController`, guard e interceptor funzionali, accessibilità.

## Skill disponibili

Guide operative attivate automaticamente in base alla `description`, in `.agents/skills/<nome>/SKILL.md`.

| Skill | Quando si attiva |
|---|---|
| `express-module-scaffold` | Nuovo modulo di dominio o nuova route |
| `express-error-handling` | Errori, envelope di risposta, gestore centrale |
| `input-validation` | Validazione di body, query, params senza librerie |
| `tenant-isolation` | Accesso a dati di gruppo, ruoli, scope, database del gruppo, test di isolamento |
| `opaque-token-auth` | Login del backoffice, sessioni, refresh, logout, middleware `/v1` |
| `store-server-auth` | Attivazione, chiavi Ed25519, token e rotazione dei server di punto vendita |
| `public-api-keys` | API key della superficie pubblica |
| `rate-limiting-metering` | Rate limit, quote e conteggio d'uso |
| `password-hashing` | Password e PIN con scrypt |
| `secure-file-upload` | Upload con multer |
| `webhook-verification` | Webhook in ingresso dai provider |
| `mongodb-repository-patterns` | Repository, indici, paginazione, update atomici |
| `mongodb-integration-tests` | Test con MongoDB reale usa-e-getta |
| `node-test-coverage` | Test con node:test e coverage al 100% |
| `dependency-approval` | Prima di installare o proporre un pacchetto npm |
| `legacy-module-analysis` | Analisi di un dominio del legacy prima di riscriverlo |
| `angular-component` | Componente del backoffice (standalone, signal input/output, host, control flow) |
| `angular-signals-state` | Stato con signal, computed, linkedSignal, effect, resource |
| `angular-http-data` | Letture con `httpResource`, scritture con `HttpClient`, errori del backend |
| `angular-routing` | Route lazy, gruppo nell'URL, guard e resolver funzionali |
| `angular-forms` | Form con Signal Forms ed errori `422` sui campi |
| `angular-list-page` | Pagine elenco con filtri nell'URL e paginazione a cursore |
| `angular-auth-session` | Sessione nel backoffice: token in memoria, refresh su 401, logout |
| `angular-permissions-ui` | Interfaccia condizionata da ruoli e permessi, selettore del gruppo |
| `angular-design-system` | Token, temi e componenti UI condivisi |
| `angular-testing` | Test Vitest del backoffice e soglie di copertura |
| `docs-sync-checklist` | Verifica di fine passo: JSDoc, documentazione tecnica, API, API pubbliche, modello dati |
