# Flood Cloud — API Pubbliche

> **Documento destinato agli integratori esterni.** Contiene solo ciò che è pubblico.
> Regole di redazione (`GEMINI.md` §3): nessun riferimento a superfici interne, dettagli implementativi, database o informazioni utili a un attaccante; esempi completi di richiesta e risposta; mantenuto a ogni passo che tocca `/public/v1`.

## Introduzione
Le API pubbliche di Flood Cloud permettono ai sistemi di un'attività (per esempio un e-commerce o un gestionale) di leggere e, dove previsto, scrivere i propri dati in modo sicuro.

- **URL di base:** `https://<host>/public/v1` *(host da definire)*
- **Formato:** JSON (`Content-Type: application/json; charset=utf-8`), date ISO 8601 in UTC, importi in centesimi interi.
- **Solo da server a server:** le chiavi non vanno mai inserite in pagine web, app distribuite o repository di codice.

## Autenticazione
Ogni richiesta include la propria API key nell'header:
```http
X-Api-Key: fc_pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
- Le chiavi si creano dal backoffice da un amministratore dell'attività, che sceglie i permessi della chiave.
- La chiave completa è mostrata **una sola volta** alla creazione: conservala in modo sicuro. Se la perdi, creane una nuova e revoca la precedente.
- Una chiave accede solo ai dati della propria attività ed eventualmente solo ad alcuni punti vendita.

## Limiti di utilizzo
Ogni chiave ha un limite di richieste al minuto e può avere una quota mensile. Ogni risposta riporta lo stato dei limiti:
```http
RateLimit-Limit: 600
RateLimit-Remaining: 594
RateLimit-Reset: 42
```
Oltre il limite la risposta è `429` con l'header `Retry-After` (secondi da attendere). Valori dei limiti: *da definire*.

## Errori
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "limit", "issue": "maximum" }] } }
```
| Codice HTTP | `error.code` | Significato |
|---|---|---|
| `400` | `MALFORMED_JSON` | corpo della richiesta non è JSON valido |
| `401` | `UNAUTHENTICATED` | chiave assente, non valida, scaduta o revocata |
| `403` | `FORBIDDEN` | la chiave non ha il permesso per questa operazione |
| `404` | `NOT_FOUND` | risorsa inesistente o non accessibile con questa chiave |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | content type non supportato |
| `422` | `VALIDATION_ERROR` | parametri non validi (dettagli in `details`) |
| `429` | `RATE_LIMITED` / `QUOTA_EXCEEDED` | limite al minuto o quota superati |
| `500` | `INTERNAL_ERROR` | errore del servizio; riprova più tardi |

## Paginazione
Le liste restituiscono al massimo `limit` elementi (default 50, massimo 200) e un cursore per la pagina successiva:
```json
{ "data": [ ... ], "page": { "limit": 50, "next": "eyJpZCI6Ij..." } }
```
Per la pagina successiva passa `?cursor=<next>`; `next: null` indica l'ultima pagina.

## Endpoint
Nessun endpoint ancora disponibile.
