# Modello di Sicurezza

> Stato: **approvato** nelle scelte di fondo (decisioni dell'utente del 2026-10-30). Le voci in §12 restano aperte e non si implementano senza decisione.
> Vincolo di progetto: dipendenze minime. Tutta la crittografia usa **`node:crypto`** (CSPRNG, SHA-256, HMAC, scrypt, Ed25519, AES-256-GCM, `timingSafeEqual`), componendo primitive standard senza inventare algoritmi.

## 1. Perché si rifà tutto (sintesi dell'audit del legacy)
Gravità **alta**:
1. Autenticazione decisa da una whitelist di sottostringhe del percorso: ciò che non è in lista è **pubblico** (es. l'intero proxy Fiskaly è raggiungibile senza login con le credenziali della piattaforma).
2. `signup` pubblico che accetta dal client `role`, `permissions`, `status`: chiunque può creare un utente `PSA`.
3. Servizio utenti senza scope: un utente autenticato può modificare o cancellare utenti di altri tenant e promuoversi di ruolo.
4. Query, update e pipeline MongoDB **grezze dal client** (`$lookup`, `$unionWith`, `$out`, `$merge`, operatori nel login).
5. Segreti versionati (chiave di service account GCP, segreti di firma, credenziali Aruba/Cerved/SMTP in Makefile, ConfigMap e script `package.json`).
6. File statici pubblici, upload senza limiti né controllo del tipo, nomi file dal client (path traversal), SVG serviti dallo stesso dominio.

Gravità **media**: JWT scritto a mano, confronto non a tempo costante, **nessuna scadenza effettiva**; password in HMAC-SHA512 con pepper globale senza salt né costo; **un'unica API key per gruppo** in chiaro, generata con `Math.random`, senza scope né scadenza, condivisa da tutti i punti vendita; PII cifrate con AES-CBC senza autenticazione; stack trace nelle risposte; CORS `*`; nessun rate limit.

**Tutte le credenziali presenti nel legacy sono da considerare compromesse e da ruotare.**

## 2. Principi
1. **Deny by default**: ogni route richiede autenticazione; le route pubbliche lo dichiarano esplicitamente, mai tramite pattern sul percorso.
2. **Il server decide identità e scope**: gruppo, azienda, punto vendita, ruolo e permessi si ricavano **solo** dalla credenziale verificata. Campi del client come `groupId`, `role`, `permissions` vengono rifiutati.
3. **Nessun segreto riutilizzabile a riposo**: token e chiavi si salvano solo come hash; password con funzione lenta e salt; per i server di punto vendita il cloud conserva solo una **chiave pubblica**.
4. **Minimo privilegio**: ogni credenziale ha lo scope più stretto possibile e una scadenza o una revoca.
5. **Fallire chiusi**: errore di verifica, configurazione mancante o dipendenza irraggiungibile ⇒ accesso negato.
6. **Nessuna fuga d'informazione**: errori generici, 404 per risorse fuori scope, login con risposta identica per utente inesistente e password errata.

## 3. Tre superfici API, tre credenziali
| Superficie | Prefisso | Chi la usa | Credenziale | Durata |
|---|---|---|---|---|
| **Backoffice** | `/v1` | amministratori (PSA, D, SA, CA, PA) via app di backoffice | access token opaco + refresh token | 15 min / refresh con rotazione |
| **Store** | `/store/v1` | il **server di punto vendita** (uno per negozio) | coppia di chiavi **Ed25519** + access token opaco | 15 min, rinnovato con firma |
| **Pubblica** | `/public/v1` | integrazioni server-to-server di **un singolo gruppo** | API key pubblica | fino a scadenza/revoca |

Ogni superficie ha router, middleware di autenticazione, rate limit e documentazione propri. Una credenziale è valida **solo** sulla sua superficie: un token del backoffice non apre `/store/v1`, una API key pubblica non apre `/v1`.

**Formato dei segreti emessi dal server**: prefisso leggibile + 32 byte da `crypto.randomBytes` in base64url. Prefissi: `fc_at_` (access backoffice), `fc_rt_` (refresh backoffice), `fc_st_` (access store server), `fc_pk_` (API key pubblica), più il codice di attivazione dei server di punto vendita. Il segreto si mostra **una sola volta**; a riposo resta solo l'hash SHA-256, cercato per indice univoco (con 256 bit di entropia un hash veloce non è attaccabile per forza bruta).

## 4. Backoffice: sessioni con token opachi
- **Login** con username e password (`POST /v1/auth/login`), rate limit per IP e per username, risposta `INVALID_CREDENTIALS` identica in ogni caso di fallimento.
- **Ruoli ammessi**: PSA, D, SA, CA, PA. Gli utenti `E` (employee) **non possono accedere al backoffice**: operano solo tramite il server di punto vendita (§5.6). Un login di un utente `E` riceve la stessa risposta di credenziali errate.
- **Access token** opaco di 15 minuti, inviato come `Authorization: Bearer fc_at_…`.
- **Refresh token** con **rotazione a ogni uso** e **rilevamento del riuso**: se un refresh token già usato si ripresenta, l'intera famiglia di sessioni è revocata e l'evento va nell'audit log. Scadenza per inattività 7 giorni, durata massima della famiglia 30 giorni, poi nuovo login (valori di default configurabili).
- **Comportamento del client**: alla risposta `401` con codice `TOKEN_EXPIRED` chiama una sola volta `POST /v1/auth/refresh` e ripete la richiesta; se il refresh fallisce, torna al login. Le richieste concorrenti attendono lo stesso refresh.
- **Conservazione lato client** (raccomandata): access token solo in memoria; refresh token in cookie `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth`, con verifica dell'header `Origin` su refresh e logout. Così un eventuale XSS nel backoffice non può leggere il refresh token. *(da confermare con chi sviluppa il backoffice, §12)*
- **Revoca immediata**: logout, logout da tutti i dispositivi, cambio password, cambio ruolo o scope, disattivazione dell'utente o del gruppo revocano le sessioni. Con i token opachi l'effetto è immediato.
- **Sessioni visibili**: l'utente vede e revoca le proprie sessioni (dispositivo, IP, ultimo uso).

## 5. Server di punto vendita: identità a chiave pubblica
Ogni negozio ha **un solo server locale** che centralizza casse e dispositivi e comunica in modo permanente con il cloud. Ogni server ha una **propria identità**, legata a gruppo, azienda e punto vendita: la vecchia API key di gruppo condivisa viene eliminata.

### 5.1 Perché chiavi asimmetriche
- La **chiave privata nasce e resta sul server di punto vendita**: non viaggia mai sulla rete e il cloud non la conosce.
- Il cloud conserva solo la **chiave pubblica**: anche un furto del database non permette di impersonare un negozio.
- Ogni richiesta di token è **firmata e monouso** (anti-replay): intercettarla non serve a niente.
- Il segreto in transito sulle chiamate operative è un access token di 15 minuti: se trapela (log, proxy), scade da solo.
- Rispetto a una chiave fissa con refresh token rotanti, non c'è il rischio di restare chiusi fuori quando il server si blocca a metà di una rotazione: la chiave privata resta sempre valida finché non viene revocata o sostituita.

### 5.2 Attivazione (una volta per server)
1. Dal backoffice un amministratore con permesso `storeServers:manage` registra il server sul punto vendita e ottiene un **codice di attivazione** monouso (scadenza 15 minuti, tentativi limitati, hash a riposo).
2. Il server di punto vendita genera localmente una coppia **Ed25519** e chiama `POST /store/v1/activation` con codice, chiave pubblica e informazioni (versione software, hostname).
3. Il cloud consuma il codice in modo atomico, salva la chiave pubblica con un `keyId` e restituisce `storeServerId` e `keyId`.
4. La chiave privata va salvata dal server di punto vendita in un file leggibile solo dal suo utente di servizio (o nel keystore del sistema, se disponibile).

### 5.3 Ottenere un access token
`POST /store/v1/token` con un'**asserzione firmata**:
- campi: `storeServerId`, `keyId`, `iat` (istante in secondi), `jti` (16 byte casuali), `aud` (`flood-cloud-store`);
- firma Ed25519 sulla stringa canonica `v1.<aud>.<storeServerId>.<keyId>.<iat>.<jti>`.

Il cloud verifica: server attivo e chiave non revocata, firma valida (`crypto.verify`), `iat` entro ±5 minuti, `jti` mai visto (collection con indice univoco e TTL). Se tutto è valido emette un access token `fc_st_…` di 15 minuti. Il server di punto vendita lo rinnova firmando una nuova asserzione poco prima della scadenza. In caso di orologio fuori tolleranza la risposta è `401` con codice `CLOCK_SKEW` e l'ora del server, così il client può correggere: il server di punto vendita **deve** comunque essere sincronizzato via NTP.

### 5.4 Rotazione e revoca
- **Rotazione** (consigliata ogni 90 giorni o su richiesta): il server di punto vendita genera una nuova coppia e chiama `POST /store/v1/keys` autenticato con il token corrente, includendo una firma fatta con la **nuova** chiave (prova di possesso). La vecchia chiave viene disattivata appena la nuova è registrata.
- **Revoca** dal backoffice (furto, sostituzione hardware, chiusura del negozio): chiavi e token del server sono invalidati subito. Per riattivarlo serve un nuovo codice.
- **Monitoraggio**: ultimo contatto, IP, versione software; ogni attivazione, rotazione, revoca e fallimento di firma va nell'audit log.

### 5.5 Operazioni dal punto vendita
- Il contesto (`req.auth`) di un server di punto vendita è limitato a **quel** punto vendita: non può leggere né scrivere dati di altri punti vendita o gruppi, qualunque parametro invii.
- Ogni invio di documenti fiscali, vendite o movimenti porta un header **`Idempotency-Key`**: se la rete cade e il server ripete l'invio, il cloud restituisce l'esito già registrato senza duplicare nulla.
- Rate limit ampio ma presente, per proteggere il cloud da un server locale malfunzionante.

### 5.6 Utenti E e operatori di cassa
Gli utenti `E` lavorano sui client di cassa collegati al server di punto vendita. Verso il cloud non si autenticano: le operazioni arrivano con la credenziale del server di punto vendita e indicano l'operatore come **attributo validato** (deve appartenere a quel punto vendita). Come gli operatori si autenticano sul server locale (PIN o altro) è una decisione aperta (§12).

### 5.7 Migrazione dal legacy
Per un periodo limitato, `POST /store/v1/migration` accetta la vecchia API key di gruppo **insieme** all'identificativo del punto vendita e a una chiave pubblica appena generata, registra il server e restituisce la nuova identità. Al termine del periodo l'endpoint viene rimosso e le vecchie chiavi spente. *(Modalità e durata da confermare, §12.)*

## 6. API pubbliche
- **Una per gruppo**: ogni chiave appartiene a un solo gruppo e vede solo i suoi dati, con eventuale restrizione ad aziende o punti vendita.
- Create dal backoffice da SA del gruppo (o da D e PSA per i gruppi che gestiscono), con nome, **permessi** scelti dal catalogo pubblico (es. `products:read`), scadenza opzionale.
- Inviate come header `X-Api-Key: fc_pk_…`, solo da server a server (mai da browser o app distribuite: CORS chiuso su `/public/v1`).
- A riposo solo hash e prefisso visibile; elenco con nome, prefisso, permessi, limiti, ultimo uso; rotazione creando la nuova chiave e revocando la vecchia.

## 7. Rate limit e conteggio d'uso
Due controlli distinti:
| | Rate limit | Quota d'uso |
|---|---|---|
| Scopo | proteggere il servizio dai picchi | rispettare i limiti concordati |
| Finestra | 1 minuto (finestra fissa) | giorno / mese |
| Superato | `429` + `Retry-After`, codice `RATE_LIMITED` | `429`, codice `QUOTA_EXCEEDED` |
| Si applica a | tutte le superfici (soglie diverse) | API pubbliche |

- **Archivio**: MongoDB nel database common. Contatori con incremento atomico (`$inc` con upsert) e indice TTL: funziona con più istanze del server senza Redis.
- **Header** di risposta: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- **Soglie**: limiti di default della piattaforma, modificabili per singola chiave da PSA e D. Login, refresh, attivazione e richiesta token hanno soglie severe per IP e per identificativo.
- **Conteggio d'uso** delle API pubbliche per chiave, giorno ed endpoint (chiamate, errori), aggregato in memoria e scritto a blocchi per non fare una scrittura per richiesta; consultabile dal backoffice.

## 8. Autorizzazione
### 8.1 Ruoli e visibilità
| Ruolo | Superficie | Visibilità |
|---|---|---|
| `PSA` Platform Super Admin | backoffice | tutto il sistema |
| `D` Dealer | backoffice | i gruppi che ha creato e tutto ciò che contengono |
| `SA` Super Admin di gruppo | backoffice | il proprio gruppo |
| `CA` Company Admin | backoffice | le proprie aziende e i loro punti vendita |
| `PA` Place Admin | backoffice | i propri punti vendita |
| `E` Employee | nessun accesso diretto al cloud | opera tramite il server di punto vendita |

### 8.2 Regole
- **RBAC centralizzato**: una policy mappa ruolo → permessi (`risorsa:azione`); ogni route dichiara il permesso richiesto. Nessun controllo di ruolo sparso nei controller.
- **Scope calcolato dal server**: alla verifica della credenziale si calcolano i gruppi, le aziende e i punti vendita visibili; i repository li applicano a ogni query.
- **Nessuna escalation**: un utente può creare o modificare solo utenti di ruolo **inferiore** al proprio e dentro il proprio scope; nessuno modifica il proprio ruolo o scope.
- **PSA e D** scelgono il gruppo su cui operare tramite il percorso della risorsa (es. `/v1/groups/:groupId/...`), verificato contro lo scope; ogni accesso a un gruppo diverso dal proprio è registrato nell'audit log.
- Risorse fuori scope: **404**.

## 9. Input e API
Endpoint REST a risorse (`doc/API-Guidelines.md`); **nessuna query, filtro, update o pipeline MongoDB accettata dal client**. Validazione per allowlist di body, query e params: proprietà sconosciute rifiutate, chiavi che iniziano con `$` o contengono `.` rifiutate, tipi e lunghezze controllati, `ObjectId` validati. Limiti di dimensione per route.

## 10. Protezioni HTTP, file, segreti e log
- **Header** (middleware proprio): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`, niente `X-Powered-By`.
- **CORS**: allowlist di origini per ambiente, solo su `/v1` (backoffice); chiuso su `/store/v1` e `/public/v1`.
- **Timeout** delle richieste (default 30 s) e `trust proxy` impostato sul numero esatto di proxy.
- **File**: `multer` con limiti, verifica dei magic bytes, nomi generati dal server, SVG/HTML rifiutati, nessuna cartella pubblica (skill `secure-file-upload`).
- **Configurazione** da variabili d'ambiente validate all'avvio (fail-fast, nessun default per l'ambiente); in produzione da secret manager; `.env.example` con soli nomi.
- **Dati sensibili** cifrati a livello di campo con **AES-256-GCM**, chiave dedicata con versione per la rotazione (es. credenziali dei provider per gruppo).
- **Log** strutturati con redazione di token, chiavi, password, header `Authorization` e `X-Api-Key`, PII; correlation id per richiesta.
- **Audit log** (database common): login riusciti e falliti, refresh e riuso rilevato, revoche, attivazioni/rotazioni/revoche dei server di punto vendita, creazione e revoca di API key, cambi di ruolo e scope, accessi di PSA e D ad altri gruppi.

## 11. Integrazioni e webhook
Credenziali dei provider solo lato server (per gruppo, cifrate); ogni proxy verso un provider è autenticato e autorizzato; webhook in ingresso con verifica della firma, anti-replay e idempotenza (skill `webhook-verification`).

## 12. Decisioni aperte
1. Refresh token del backoffice in cookie `HttpOnly` (raccomandato) o gestito dal client nel body.
2. Autenticazione degli operatori `E` sul server di punto vendita e sincronizzazione degli utenti verso di esso.
3. Modalità e durata della migrazione dalle API key di gruppo (§5.7).
4. Valori dei limiti di default e delle quote; eventuali piani diversi per gruppo.
5. Permessi per modulo per singolo utente (`permissions.<modulo>.{r,w}` del legacy): mantenerli come restrizione aggiuntiva al ruolo o eliminarli.
6. Conservazione dell'audit log (durata).
