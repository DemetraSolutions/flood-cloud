# Modello di Sicurezza

> **Stato: BOZZA DA APPROVARE.** Le scelte marcate *(da confermare)* vanno decise con l'utente prima del passo che le implementa (§10).
> Vincolo di progetto: dipendenze minime. Tutta la crittografia usa **`node:crypto`** (CSPRNG, SHA-256, HMAC, scrypt, AES-256-GCM, `timingSafeEqual`); nessuna crittografia scritta a mano oltre la composizione di queste primitive.

## 1. Perché si rifà tutto (sintesi dell'audit del legacy)
Gravità **alta**:
1. Autenticazione decisa da una whitelist di sottostringhe del percorso: ciò che non è in lista è **pubblico** (es. l'intero proxy Fiskaly è raggiungibile senza login con le credenziali della piattaforma).
2. `signup` pubblico che accetta dal client `role`, `permissions`, `status`: chiunque può creare un utente `PSA`.
3. Servizio utenti senza scope: un utente autenticato può modificare/cancellare utenti di altri tenant e promuoversi di ruolo.
4. Query, update e pipeline MongoDB **grezze dal client** (`$lookup`, `$unionWith`, `$out`, `$merge`, `$where`, operatori nel login).
5. Segreti versionati (chiave di service account GCP, segreti di firma, credenziali Aruba/Cerved/SMTP in Makefile, ConfigMap e script `package.json`).
6. File statici pubblici, upload senza limiti né controllo del tipo, nomi file dal client (path traversal), SVG serviti dallo stesso dominio.

Gravità **media**: JWT scritto a mano senza confronto a tempo costante, durata 90 giorni senza refresh; password in HMAC-SHA512 con pepper globale senza salt né costo; API key in chiaro, generate con `Math.random`, senza scope né scadenza; PII cifrate con AES-CBC senza autenticazione e chiave derivata dal segreto di firma; stack trace nelle risposte; CORS `*`; nessun rate limit; enumerazione utenti.

**Tutte le credenziali presenti nel legacy sono da considerare compromesse e da ruotare.**

## 2. Principi
1. **Deny by default**: ogni route richiede autenticazione; le route pubbliche lo dichiarano esplicitamente nel proprio modulo, mai tramite pattern sul percorso.
2. **Il server decide l'identità e lo scope**: tenant, company, place, ruolo e permessi si ricavano **solo** dalla credenziale verificata. Parametri del client come `groupId`, `role`, `permissions` sono ignorati o rifiutati.
3. **Nessun segreto in chiaro a riposo**: token, refresh token, API key e codici monouso si salvano solo come hash; le password con funzione lenta e salt.
4. **Minimo privilegio**: ogni credenziale ha lo scope più stretto possibile e una scadenza.
5. **Fallire chiusi**: errore di verifica, configurazione mancante o dipendenza irraggiungibile ⇒ accesso negato.
6. **Nessuna fuga d'informazione**: messaggi d'errore generici, 404 per risorse di altri tenant, login con risposta identica per utente inesistente e password errata.

## 3. Tipi di credenziale
| Credenziale | Chi | Header | Durata | A riposo |
|---|---|---|---|---|
| Access token di sessione | utente (backoffice, operatore) | `Authorization: Bearer fc_at_…` | breve (15 min) | SHA-256 |
| Refresh token | utente | body di `/auth/refresh` | 30 giorni, ruotato a ogni uso | SHA-256 |
| Credenziale dispositivo | POS / kiosk | `Authorization: Bearer fc_dv_…` *(da confermare)* | fino a revoca, rotabile | SHA-256 |
| API key | integrazioni server-to-server | `X-Api-Key: fc_live_…` | scadenza opzionale | SHA-256 |
| Codice monouso | reset password, invito, enrollment dispositivo | — | minuti | SHA-256 |

**Formato dei segreti**: prefisso leggibile (per riconoscerli nei log e nei secret scanner) + 32 byte da `crypto.randomBytes` in base64url. Il segreto completo si mostra **una sola volta** alla creazione.

**Perché hash SHA-256 e non scrypt per i token**: hanno 256 bit di entropia, quindi un hash veloce non è attaccabile per forza bruta e permette la ricerca per indice univoco.

### 3.1 Sessioni utente — token opachi *(da confermare)*
Proposta: **token opachi** salvati come hash nella collection `sessions`, non JWT.
- Pro: revoca immediata (logout, logout ovunque, cambio password, utente disattivato), nessuna libreria JWT, nessun rischio di algoritmi o chiavi di firma.
- Contro: una lettura indicizzata su MongoDB per richiesta (mitigabile con cache in memoria di pochi secondi).
- Refresh con **rotazione e rilevamento del riuso**: se un refresh token già usato si ripresenta, l'intera famiglia di sessioni viene revocata.
- Ogni sessione registra dispositivo/user agent, IP, creazione, ultimo uso; l'utente può elencarle e revocarle.

### 3.2 Password
- **scrypt** di `node:crypto` con salt casuale di 16 byte per utente e parametri OWASP (N=2^17, r=8, p=1; `maxmem` adeguato), formato salvato con parametri inclusi (`scrypt$N$r$p$salt$hash`) per poterli aumentare in futuro con rehash al login.
- Confronto con `timingSafeEqual`; tempo costante anche per utente inesistente (hash fittizio).
- Lunghezza minima 12, massima 128; blocco progressivo dopo tentativi falliti (§6).
- Migrazione dalle password legacy *(da confermare)*: reset obbligatorio via email, oppure verifica una tantum del vecchio HMAC e rehash immediato.

### 3.3 Dispositivi POS
Ogni terminale ha una **propria identità**, non usa l'account dell'operatore:
1. un amministratore genera un **codice di enrollment** monouso legato a company e place;
2. il dispositivo lo scambia con una credenziale dispositivo (hash a riposo, revocabile, con ultimo accesso registrato);
3. l'operatore di cassa si autentica *sul* dispositivo (PIN hashato con scrypt e rate limit) *(da confermare)*.

### 3.4 API key
- Legate a un tenant, con **scope espliciti** (`risorsa:azione`, es. `products:read`) ed eventuale restrizione a company/place.
- Mai restituite nei documenti del tenant; elenco con solo prefisso, nome, scope, scadenza, ultimo uso.
- Rotazione con periodo di sovrapposizione; revoca immediata.

## 4. Autorizzazione
- **RBAC centralizzato**: una policy unica mappa ruolo → permessi (`risorsa:azione`). Le route dichiarano il permesso richiesto; nessun controllo di ruolo sparso nei controller.
- Ruoli candidati (dal legacy, *da confermare* nomi e significato): platform admin, dealer, group admin, company admin, place admin, operator.
- **Isolamento dei tenant nel data access layer**: i repository ricevono il contesto (`tenantId`, scope company/place) dal middleware e lo applicano a **ogni** query; non esiste un metodo di repository senza contesto per i dati di tenant.
- Accesso cross-tenant (platform admin, dealer verso i propri gruppi): solo tramite permesso esplicito, registrato nell'audit log.
- Modello di tenancy *(da confermare)*: database per tenant (come il legacy) oppure database unico con `tenantId` obbligatorio e indicizzato.

## 5. Input e API
- Endpoint tipizzati per risorsa; **nessuna query, filtro, update o pipeline MongoDB accettata dal client**.
- Validazione per allowlist su body, query e params: proprietà sconosciute rifiutate, chiavi che iniziano con `$` o contengono `.` rifiutate, tipi e lunghezze controllati, `ObjectId` validati.
- Paginazione con limite massimo; ricerche testuali con escape delle regex.
- Limiti di dimensione per route (`body-parser`): default piccolo, più ampio solo dove serve.

## 6. Protezioni HTTP
Implementate con middleware propri (nessuna libreria aggiuntiva senza approvazione):
- **Header**: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` per le risposte API, `Cross-Origin-Resource-Policy`, rimozione di `X-Powered-By`.
- **CORS**: allowlist di origini da configurazione per ambiente, mai `*` con credenziali.
- **Rate limit**: per IP e per credenziale, più severo su login, refresh, reset password, enrollment. Archivio *(da confermare)*: MongoDB con indice TTL (funziona con più repliche) o memoria.
- **Timeout** delle richieste ragionevoli (es. 30 s) e `trust proxy` configurato esattamente sul numero di proxy davanti al server.

## 7. File
`multer` con `memoryStorage` o disco temporaneo, limiti di dimensione e numero file, allowlist di tipi verificata sui **magic bytes** (non sul `mimetype` del client), nomi generati dal server, SVG rifiutati o serviti come allegato, nessun file servito da cartelle pubbliche: accesso tramite endpoint autenticato o URL firmato a scadenza.

## 8. Segreti, dati e log
- Configurazione da variabili d'ambiente validate all'avvio (fail-fast); in produzione da secret manager. `.env.example` con soli nomi.
- PII sensibili cifrate a livello di campo *(da confermare quali)* con **AES-256-GCM**, chiave dedicata separata da ogni altra, identificatore di versione della chiave per la rotazione.
- Log strutturati con **redazione** di token, API key, password, PIN, header `Authorization`/`X-Api-Key` e PII; correlation id per richiesta.
- **Audit log** degli eventi di sicurezza: login riusciti e falliti, refresh, revoche, creazione/rotazione di API key, enrollment dispositivi, cambi di ruolo/permessi, accessi cross-tenant.

## 9. Integrazioni e webhook
- Credenziali dei provider lato server, per tenant dove previsto, mai inviate dal client.
- Webhook in ingresso: verifica della firma (HMAC o schema del provider) con `timingSafeEqual`, finestra temporale anti-replay, idempotenza per id evento.
- Chiamate in uscita con `fetch` nativo, timeout (`AbortSignal.timeout`), nessun log dei segreti.

## 10. Decisioni aperte
1. Token opachi (proposta) o JWT per le sessioni utente.
2. Modello di tenancy: database per tenant o database unico con `tenantId`.
3. Compatibilità con i client esistenti (backoffice, POS): API nuova da adottare nei client, o strato di compatibilità temporaneo.
4. Migrazione delle password legacy.
5. Nomi e significato dei ruoli; utenti multi-tenant (dealer).
6. Autenticazione dei dispositivi e PIN operatore.
7. Archivio del rate limit.
8. Campi da cifrare a livello applicativo.
