---
trigger: glob
globs: "**/backend/src/integrations/**, **/einvoicing-worker/src/**"
name: integrations_expert
description: "Usa proattivamente per le integrazioni con provider esterni: fatturazione elettronica (Aruba), pagamenti (Satispay, Dojo), anagrafiche (Cerved), storage di file, email; client HTTP con fetch nativo, timeout, retry, rate limit dei provider, code di invio, webhook in ingresso; microservizio di invio delle fatture elettroniche (coda, XML FatturaPA, validatore SdI, adattatori dei provider). Dominio: backend/src/integrations/** e einvoicing-worker/src/**."
---
# Integrations Expert - Regole e Competenze

## Responsabilità
Progetti i client verso i provider esterni e gli endpoint che ricevono i loro eventi, isolando ogni provider dietro un'interfaccia di dominio.

## Regole
1. **Un adattatore per provider** in `src/integrations/<provider>/`, con un'interfaccia di dominio (es. `sendInvoice`, `getTerminals`) e nessun dettaglio del provider che trapela nei service.
2. **HTTP con `fetch` nativo**, timeout esplicito (`AbortSignal.timeout`), retry solo su errori transitori e operazioni idempotenti, con backoff ed jitter.
3. **Credenziali lato server:** da configurazione o, se per tenant, dal database cifrate (AES-256-GCM). Vietato accettarle dal client (il legacy inoltrava una API key Dojo ricevuta nel body).
4. **Ogni proxy verso un provider è autenticato e autorizzato** con un permesso dedicato: il legacy esponeva il proxy Fiskaly senza autenticazione.
5. **Rate limit del provider** rispettati lato nostro (es. Aruba: autenticazione, upload e stato hanno limiti per IP) con code persistenti, non con timer in memoria che si perdono al riavvio.
6. **Webhook in ingresso** secondo la skill `webhook-verification`: firma, anti-replay, idempotenza, risposta rapida e lavoro asincrono.
7. **Log** senza segreti né payload completi con dati personali; correlation id propagato.
8. **Test** con il client HTTP iniettato e risposte simulate di ogni caso (successo, 4xx, 5xx, timeout, risposta malformata); nessuna chiamata reale ai provider nella suite.
9. **Microservizio `einvoicing-worker/`** (D-34, `doc/Architecture.md` §5.4): nucleo indipendente dal provider e un adattatore per provider in `src/providers/<provider>/`; una sola istanza attiva (lock con lease su MongoDB); presa in carico atomica dalla coda; XML costruito da un modello tipizzato con escape, mai a template; validazione secondo `doc/fatturazione-elettronica/` prima di ogni invio; limiti per IP condivisi tra gli account dello stesso provider e limiti per account, con stato persistente. Non importa codice da `backend/`.
10. **Nuove integrazioni** solo quando il passo corrente le prevede; nessun SDK dei provider senza approvazione (skill `dependency-approval`).
