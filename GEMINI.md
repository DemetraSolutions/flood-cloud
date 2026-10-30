# Regole Globali per l'Agente AI

Tutti gli agenti e i sottoagenti che operano in questo progetto devono rispettare rigorosamente le seguenti direttive.

## 0. Scopo del Progetto (Vision)
Ogni azione, decisione architetturale o riga di codice DEVE essere consapevole dello scopo del progetto descritto in **`doc/Product-Scope.md`**: leggilo prima di iniziare qualsiasi sviluppo.

**Flood Cloud** è la riscrittura completa, con un nuovo approccio, del server della piattaforma cloud commerce di Flood (progetto legacy `../cloud-commerce-platform-server`). È un server **Node.js + Express + MongoDB** che serve backoffice, punti cassa (POS) e integrazioni esterne.

**Il progetto legacy è solo un riferimento funzionale.** Si consulta per capire *cosa* faceva il sistema (`doc/Legacy-Analysis.md`), mai per copiarne il *come*:
- non copiare codice, struttura o pattern dal legacy: ogni parte si riprogetta;
- non copiare **mai** segreti, chiavi, credenziali o file di service account presenti nel legacy, nemmeno in esempi, test o documentazione;
- la sicurezza (autenticazione, token, API key, autorizzazione, isolamento dei tenant) è **interamente rifatta** secondo `doc/Security-Model.md`.

## 1. Sviluppo per Passi
Il progetto cresce **un passo alla volta**, deciso con l'utente.
- Lavora solo sul passo corrente. Non anticipare moduli, endpoint, collection o librerie di passi futuri, nemmeno "già che ci sei".
- Un passo è finito solo quando: il codice funziona, la copertura dei test è al 100%, la documentazione del passo è aggiornata e l'utente ha confermato.
- Se un passo richiede qualcosa di non ancora deciso (es. un'altra collection, un'altra libreria), fermati e chiedi.

## 2. Rispetto della Documentazione
Leggi **sempre** la documentazione di riferimento in `doc/` prima di agire su un componente. Nessuna azione deve contraddire la documentazione ufficiale.

## 3. Documentazione del Codice In-line
Ogni modulo, funzione, classe e costante esportata ha un commento **JSDoc** accurato e aggiornato: scopo, `@param` con tipo, `@returns`, `@throws`. I tipi JSDoc sono la documentazione dei contratti: tienili precisi.

## 4. Test: Copertura Totale
Il progetto è **interamente coperto dai test**. È un vincolo, non un obiettivo.
- Runner: **`node:test`** nativo con la coverage nativa di Node. Soglie al **100%** di righe, rami e funzioni, applicate da `npm test`: sotto soglia la suite fallisce.
- Ogni file di codice nasce **insieme** al suo test (TDD dove la logica lo consente). Nessun codice senza test viene considerato completo.
- Si testano happy path, casi limite e **tutti** i percorsi d'errore, compresi i rifiuti di sicurezza (401, 403, 404 tra tenant, 413, 415, 422, 429).
- Integrazione con **MongoDB reale** su database usa-e-getta (skill `node-test-coverage` e `mongodb-integration-tests`).
- Vietato abbassare le soglie, escludere file dalla coverage o usare commenti di esclusione per "far passare" la suite senza una decisione esplicita dell'utente.

## 5. Delega Proattiva ai Sottoagenti Specializzati
**AUTORIZZAZIONE PERMANENTE.** Questo documento autorizza in modo esplicito e permanente l'attivazione autonoma dei sottoagenti. L'agente principale **DEVE** delegare di propria iniziativa, senza chiedere conferma, ogni volta che un task ricade nel dominio di un sottoagente.
- L'unica fonte autoritativa dei sottoagenti e delle skill è **`AGENTS.md`**.
- Il criterio di attivazione è il campo `description` del sottoagente: va tenuto specifico e orientato al dominio.
- **Scegliere il modello fa parte del brief.** L'agente principale analizza, scrive la specifica e **verifica di persona** il risultato; l'implementazione di un brief preciso va a un modello minore (`sonnet` per codice e test, `haiku` per il lavoro meccanico). Le revisioni di sicurezza su autenticazione, token e isolamento dei tenant non si delegano a modelli minori.
- Se un task attraversa più domini, delega in sequenza a ciascun sottoagente competente.
- Le regole dei sottoagenti e le skill vengono caricate **automaticamente dall'ambiente**: non aprirle manualmente.

## 6. Incongruenze e Dubbi
Se trovi incongruenze, parti incomplete o poco chiare nella documentazione o nel legacy, **chiedi sempre** all'utente formulando domande precise. Non assumere nulla, non prendere decisioni arbitrarie non documentate.

## 7. Divieto di Modifica della Documentazione
**Non modificare mai** i documenti esistenti in `doc/` senza una richiesta esplicita dell'utente dopo un'analisi congiunta.
**Unica eccezione:** quando un passo aggiunge o modifica endpoint, il riferimento API **`doc/API.md`** va aggiornato nello stesso passo (skill `docs-sync-checklist`), limitandosi a riflettere ciò che è stato realizzato.

## 8. Lingua del Codice e Commenti
Nomi di variabili, funzioni, classi, file, collection e campi in **Inglese**. Commenti, JSDoc e documentazione in **Italiano**.

## 9. Gestione degli Errori (No Silent Failures)
Vietati i `catch {}` vuoti, le promise non attese, gli errori ignorati o convertiti in `null` per "proseguire". Ogni errore si intercetta, si gestisce o si propaga al gestore centrale di Express, che risponde con l'envelope standard **senza** stack trace, messaggi interni o dettagli del database (skill `express-error-handling`).

## 10. Sicurezza by Design e Divieto di Hardcoding
- Vietato inserire nel codice, nei test, negli script `package.json` o nella documentazione chiavi API, segreti, password, stringhe di connessione o credenziali. La configurazione arriva da variabili d'ambiente validate all'avvio; `.env.example` documenta i nomi, mai i valori reali.
- Ogni input è ostile: validazione per allowlist, nessun oggetto del client passato così com'è a MongoDB.
- Ogni query su dati di un tenant è filtrata dal tenant **ricavato dall'autenticazione**, mai da parametri del client.
- Ogni modifica che tocca autenticazione, token, API key, permessi, upload o webhook passa dal `security_expert`.

## 11. Dipendenze Minime
Si installano **solo le librerie strettamente necessarie**, sempre nell'**ultima versione stabile**.
- Approvate oggi: `express`, `mongodb`, `body-parser`, `compression`, `multer`.
- Prima di qualsiasi nuova dipendenza (anche di sviluppo) **chiedi all'utente**, motivando perché le API native di Node (`node:crypto`, `node:test`, `fetch`, `node:util`…) non bastano (skill `dependency-approval`).
- Versioni esatte nel `package.json` e `package-lock.json` sempre versionato.

## 12. Efficienza e Output Conciso
Risposte brevi, nessun convenevole, nessun blocco di codice in chat se non richiesto. Modifica i file con gli strumenti dell'ambiente e riassumi in poche righe cosa è cambiato e quali domande restano aperte.

## 13. Paginazione e Risorse
Vietate le query non limitate (`find()` totale), i payload senza limite di dimensione e i caricamenti interi in memoria di grandi insiemi. Usa paginazione con limite massimo, cursori e proiezioni.

## 14. Convenzioni Git
Conventional Commits (`feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`). Lo sviluppo avviene sul branch `development`; non fare commit o push senza richiesta dell'utente.

## 15. Best Practice Tecnologiche
Codice idiomatico per **Node.js 24 LTS**, moduli **ESM**, **Express 5** (gestione nativa degli errori asincroni) e **driver MongoDB ufficiale**. Niente pattern ad-hoc, niente codice morto, niente astrazioni anticipate per bisogni futuri.

## 16. Proposta di Nuovi Agenti o Skill
Se un'operazione ricorrente o complessa sarebbe gestita meglio da un agente o da una skill che non esiste, **proponilo** all'utente. Ogni aggiunta va registrata in `AGENTS.md` e sincronizzata con `./scripts/sync-agents.sh`.
