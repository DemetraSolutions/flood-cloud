# Modello di Sicurezza

> Stato: **approvato** nelle scelte di fondo (decisioni dell'utente del 2026-10-30), aggiornato il 2026-11-12 allo stato realizzato (decisioni D-01…D-31 di `doc/Tasks.md` §0.4). Le voci in §12 restano aperte e non si implementano senza decisione. Il dettaglio di ciò che è realizzato è in `doc/Technical-Guide.md` §5, §6, §8 e §11.
> Vincolo di progetto: dipendenze minime. Tutta la crittografia usa **`node:crypto`** (CSPRNG, SHA-256, HMAC, scrypt, `timingSafeEqual`; Ed25519 e AES-256-GCM quando una decisione li richiederà), componendo primitive standard senza inventare algoritmi.

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
3. **Nessun segreto riutilizzabile a riposo**: token e chiavi emessi dal server si salvano solo come hash; password con funzione lenta e salt. Eccezioni imposte dalla coesistenza con il legacy, motivate e circoscritte, in §10.
4. **Minimo privilegio**: ogni credenziale ha lo scope più stretto possibile e una scadenza o una revoca.
5. **Fallire chiusi**: errore di verifica, configurazione mancante o dipendenza irraggiungibile ⇒ accesso negato.
6. **Nessuna fuga d'informazione**: errori generici, 404 per risorse fuori scope, login con risposta identica per utente inesistente e password errata.

## 3. Superfici API e credenziali
| Superficie | Prefisso | Chi la usa | Credenziale | Durata | Stato |
|---|---|---|---|---|---|
| **Backoffice** | `/v1` | amministratori (PSA, D, SA, CA, PA) via app di backoffice; in futuro anche l'app del server di punto vendita (§5) | access token opaco + refresh token | 15 min / refresh con rotazione | realizzata |
| **Pubblica** | `/public/v1` | integrazioni server-to-server di **un singolo gruppo** | API key pubblica | fino a scadenza/revoca | prevista, nessun endpoint |

**Nessuna superficie dedicata al server di punto vendita** (D-23, decisione dell'utente del 2026-11-01): la superficie `/store/v1` prevista in origine è eliminata e non esiste nel codice. Il server di punto vendita è un'applicazione separata, fuori dallo scope di questo progetto (D-22), e userà le API `/v1` (§5).

Ogni superficie ha router, middleware di autenticazione, rate limit e documentazione propri. Una credenziale è valida **solo** sulla sua superficie: un token del backoffice non apre `/public/v1`, una API key pubblica non apre `/v1`. Il builder delle route lo impone all'avvio: le route autenticate con utente sono ammesse solo su `/v1`.

**Formato dei segreti emessi dal server**: prefisso leggibile + 32 byte da `crypto.randomBytes` in base64url. Prefissi: `fc_at_` (access backoffice), `fc_rt_` (refresh backoffice), `fc_pk_` (API key pubblica). Nessun prefisso per la superficie store (D-23). Il segreto si mostra **una sola volta**; a riposo resta solo l'hash SHA-256, cercato per indice univoco (con 256 bit di entropia un hash veloce non è attaccabile per forza bruta). Ogni confronto di segreti è a tempo costante.

## 4. Backoffice: sessioni con token opachi
- **Login** con username e password (`POST /v1/auth/login`; solo username, D-17), rate limit per IP e per username, risposta `INVALID_CREDENTIALS` identica in ogni caso di fallimento (utente inesistente, password errata, account bloccato, disattivato o nel cestino, ruolo `E` o non valido, SA/CA/PA senza gruppo o con gruppo sospeso o nel cestino), sempre con un solo scrypt.
- **Ruoli ammessi**: PSA, D, SA, CA, PA. Gli utenti `E` (employee) **non possono accedere al backoffice**: lavorano sull'app del server di punto vendita (§5). Un login di un utente `E` riceve la stessa risposta di credenziali errate.
- **Password legacy** (D-04): gli hash HMAC-SHA512 del legacy restano validi; al primo login riuscito si produce un hash scrypt in `userCredentials`, finché la coesistenza è attiva i cambi password scrivono anche l'hash legacy. Policy delle password nuove: D-19.
- **Access token** opaco di 15 minuti, inviato come `Authorization: Bearer fc_at_…`. A ogni richiesta il middleware rilegge utente e gruppo e ricostruisce permessi e scope: utente disattivato o gruppo sospeso ⇒ revoca e `401` immediati.
- **Refresh token** con **rotazione a ogni uso** e **rilevamento del riuso**: se un refresh token già usato si ripresenta, l'intera famiglia di sessioni è revocata e l'evento va nel registro delle attività (un riuso entro 30 secondi dalla rotazione, tipico di due schede o di una gara, riceve `401` senza chiudere la sessione). Scadenza per inattività 7 giorni, durata massima della famiglia 30 giorni, poi nuovo login (valori di default configurabili).
- **Password provvisoria**: creazione e reset di un utente impostano una password con obbligo di cambio; finché è pendente sono ammesse solo le route dichiarate (profilo, cambio password, logout), le altre rispondono `403 PASSWORD_CHANGE_REQUIRED`.
- **Comportamento del client**: alla risposta `401` con codice `TOKEN_EXPIRED` chiama una sola volta `POST /v1/auth/refresh` e ripete la richiesta; se il refresh fallisce, torna al login. Le richieste concorrenti attendono lo stesso refresh.
- **Conservazione lato client** (decisione dell'utente del 2026-11-02, D-12): nessun cookie. Login e refresh restituiscono access e refresh token nel body; il backoffice tiene l'access token solo in memoria e il refresh token in `sessionStorage` (sopravvive al ricaricamento della pagina, vale per la singola scheda, sparisce chiudendola). Una scheda duplicata non riusa la sessione (lock per sessione). Un eventuale XSS potrebbe leggere il refresh token: le mitigazioni sono la CSP stretta con Trusted Types del backoffice, la rotazione a ogni uso con rilevamento del riuso (che revoca l'intera famiglia) e le scadenze per inattività e massima.
- **Sessioni legacy** (D-11): il nuovo backend non accetta i JWT del legacy. Ogni revoca descritta qui sotto svuota anche `users.tokens[]`, così il legacy disconnette subito l'utente.
- **Revoca immediata** (con i token opachi l'effetto è immediato):
  - logout e logout da tutti i dispositivi;
  - cambio della propria password (le altre sessioni) e reset della password da parte di un amministratore;
  - cambio di ruolo, scope, stato (disattivazione), cestino dell'utente;
  - cambio di permessi: matrice dei moduli, interruttore "Gestione permessi" e **permessi della cassa** (`pos.enabled`, `pos.grants`); un cambio delle sole preferenze della cassa (`pos.options`) o del PIN non revoca nulla;
  - **sospensione e cestino del gruppo**: si revocano le sessioni di tutti gli utenti del gruppo e si svuotano i loro `tokens[]` legacy **prima** della scrittura dello stato (un errore a metà lascia il gruppo com'era e l'azione si può ripetere) e **di nuovo dopo** (per un login che avesse superato il controllo un attimo prima). Gli utenti si percorrono a lotti, mai tutti in memoria. **Riattivazione e ripristino** chiudono prima della scrittura le sessioni eventualmente rimaste aperte (lasciate da una revoca fallita o da una gara con la sospensione), senza toccare i `tokens[]` legacy; le sessioni revocate dalla sospensione restano revocate.
- **Sessioni visibili**: l'utente vede e revoca le proprie sessioni (dispositivo, IP, ultimo uso); una sessione altrui dà `404`.

## 5. Server di punto vendita: applicazione separata
Ogni negozio ha **un server locale** che centralizza casse e dispositivi e comunica con il cloud.
- **Fuori scope** (D-22, decisione dell'utente del 2026-11-01): l'app del server di punto vendita è un'applicazione separata; questo progetto comprende solo il backend cloud e il backoffice.
- **Nessuna superficie dedicata** (D-23): l'app userà le stesse API del backoffice (`/v1`). La superficie `/store/v1` con identità Ed25519, codice di attivazione, token `fc_st_` e migrazione dalla API key di gruppo, prevista in origine da questo documento, è **eliminata**: nessuna di queste parti è realizzata né pianificata.
- **Credenziale dell'app: decisione aperta** (D-24, §12). Va decisa quando si integra l'app; oggi, sul legacy, l'app usa l'API key del gruppo, condivisa da tutti i negozi (nel nuovo backend `groups.apiKey` non è né letta né scritta, §10). Opzioni in valutazione:
  - **login di un utente**: il refresh scade dopo 7 giorni di inattività o 30 di durata massima, quindi il negozio resta bloccato dopo un lungo offline; la password resta salvata sul server del negozio; gli utenti `E` non sono ammessi;
  - **credenziale di dispositivo per punto vendita**, accettata dalle stesse route con scope fisso sul punto vendita.
- **Requisiti già espressi dall'utente** (2026-10-30), da riconsiderare con D-24: un negozio non deve restare scollegato per una scadenza automatica della credenziale né per un lungo periodo offline, ma solo per una revoca esplicita; le scritture dal punto vendita devono essere idempotenti (`Idempotency-Key`) per i reinvii dopo l'offline; il contesto di una credenziale di negozio è limitato a quel punto vendita; rate limit ampio ma presente; visibilità dell'ultimo contatto e allarme facoltativo di piattaforma sul silenzio di un negozio.
- **Utenti E e operatori di cassa**: come gli operatori si autenticano sull'app del server locale è fuori scope (D-22); verso il cloud dipende da D-24. Il cloud gestisce i loro dati di cassa (permessi `pos`, PIN, §8.4 e §10) per conto dell'app.

## 6. API pubbliche
*Prevista, non ancora realizzata: la superficie `/public/v1` esiste senza endpoint.*
- **Una per gruppo**: ogni chiave appartiene a un solo gruppo e vede solo i suoi dati, con eventuale restrizione ad aziende o punti vendita.
- Create dal backoffice da SA del gruppo (o da D e PSA per i gruppi che gestiscono), con nome, **permessi** scelti dal catalogo pubblico (es. `products:read`), scadenza opzionale.
- Inviate come header `X-Api-Key: fc_pk_…`, solo da server a server (mai da browser o app distribuite: nessun header CORS su `/public/v1`).
- A riposo solo hash e prefisso visibile; elenco con nome, prefisso, permessi, limiti, ultimo uso; rotazione creando la nuova chiave e revocando la vecchia.
- Non vanno confuse con `groups.apiKey` del legacy, che il nuovo backend non gestisce.

## 7. Rate limit e conteggio d'uso
Due controlli distinti:
| | Rate limit | Quota d'uso |
|---|---|---|
| Scopo | proteggere il servizio dai picchi | rispettare i limiti concordati |
| Finestra | 1 minuto (finestra fissa) | giorno / mese |
| Superato | `429` + `Retry-After`, codice `RATE_LIMITED` | `429`, codice `QUOTA_EXCEEDED` |
| Si applica a | tutte le superfici (soglie diverse) | API pubbliche |
| Stato | realizzato su `/v1` | previsto |

- **Archivio**: MongoDB nel database common (`rateLimits`). Contatori con incremento atomico (`$inc` con upsert) e indice TTL: funziona con più istanze del server senza Redis. Username e IP sono salvati solo come hash. Se il database non risponde la richiesta fallisce (fallire chiusi).
- **Header** di risposta: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- **Soglie realizzate** (decisione dell'utente del 2026-11-02, configurabili): login 5 al minuto per username e 15 per IP; refresh 30 per IP; verifica dello username 15 per utente; `/v1` 300 per utente autenticato; autenticazioni fallite 300 per IP (conteggiate solo sui `401`); creazioni e reset di password 20 per amministratore; cambio della propria password e del proprio PIN con la soglia del login; errori JavaScript del backoffice 30 per utente. Ogni route anonima deve dichiarare una regola (unica esenzione motivata: `/health`). Rischio accettato: 5 tentativi al minuto per username permettono a un terzo di bloccare il login di un utente specifico.
- **API pubbliche** (previste): limiti di default della piattaforma, modificabili per singola chiave da PSA e D; **conteggio d'uso** per chiave, giorno ed endpoint (chiamate, errori), aggregato in memoria e scritto a blocchi per non fare una scrittura per richiesta; consultabile dal backoffice.

## 8. Autorizzazione
### 8.1 Ruoli e visibilità
| Ruolo | Accesso | Visibilità |
|---|---|---|
| `PSA` Platform Super Admin | backoffice | tutto il sistema |
| `D` Dealer | backoffice | i gruppi attivi e non nel cestino di cui è dealer (`groups.dealerId`) e tutto ciò che contengono |
| `SA` Super Admin di gruppo | backoffice | il proprio gruppo |
| `CA` Company Admin | backoffice | le proprie aziende e i loro punti vendita |
| `PA` Place Admin | backoffice | i propri punti vendita |
| `E` Employee | nessun accesso al backoffice | lavora sull'app del server di punto vendita (§5) |

Il ruolo `API` del legacy è eliminato (D-07): lo sostituiscono le API key pubbliche. Gli scope multipli sono liste (`companyIds[]` per CA, `placeIds[]` per PA ed E, D-08).

### 8.2 Permessi effettivi
- **RBAC centralizzato**: ogni route dichiara il permesso richiesto (`risorsa:azione`); nessun controllo di ruolo sparso nei controller. Una route può dichiarare in alternativa **uno tra più permessi** (`anyPermission`, almeno uno richiesto; oggi solo la lettura compatta dei listini, `users:read` o `fidelity:read` o `groups:read`). Una route senza dichiarazione, con un permesso sconosciuto o con entrambe le forme blocca l'avvio.
- **Catalogo**: `groups` (read, create, update, suspend, trash), `dealers` (read, create, update), `companies`, `places`, `users` (read, create, update, trash, delete), `fidelity` (read, update: tipi di carta, raccolte punti, cataloghi premi), `products` (read, update: preferiti e promozioni del gruppo e letture compatte di prodotti, categorie, clienti e gruppi di contatti), `activityLog:read`, sessioni e profilo propri, segnalazione degli errori JavaScript.
- **Tetto per ruolo** (immutabile): PSA tutto; D e SA come PSA senza `groups:suspend`, `groups:trash` e `dealers:*` (SA anche senza `groups:create`); CA `companies` read e update, `places` e `users` (senza eliminazione definitiva); PA `places` read e update e `users` (senza eliminazione definitiva); PSA–PA hanno `fidelity:*`, `products:*`, `activityLog:read`, profilo e sessioni proprie; `E` nessun permesso. Sospendere, cestinare e ripristinare un gruppo e gestire i dealer è solo del PSA. I cataloghi della scheda gruppo (listini, aliquote, valute, unità di misura, regole di magazzino, regole fedeltà) seguono `groups:read`/`groups:update`.
- **Matrice dell'utente** (D-06): ogni utente conserva la matrice legacy `permissions.<modulo>.{r,w}` su **13 moduli** (`groups`, `users`, `companies`, `places`, `documents`, `products`, `calendar`, `warehouse`, `contacts`, `fidelity`, `settings`, `stats`, `logs`); `r` → lettura, `w` → tutte le scritture del modulo, `logs.r` → `activityLog:read`. Modulo assente o non booleano ⇒ nessun permesso. **Permessi effettivi = tetto del ruolo ∩ matrice**: un utente non ottiene mai permessi oltre il proprio ruolo. Oggi danno permessi i moduli `groups`, `users`, `companies`, `places`, `fidelity`, `products`, `logs` (i flag `groups.r`/`groups.w` del PSA coprono anche `dealers:*`); gli altri sei si conservano, si mostrano e si scrivono ma nessun permesso li segue ancora.
- **PSA e D hanno tutto** (D-10, D-28): i loro permessi effettivi sono l'intero tetto del ruolo, senza la matrice del loro documento (che resta com'è e non limita nulla), e "Gestione permessi" (`canManagePermissions`) è sempre attiva; le risposte mostrano i valori effettivi. Selezionato un gruppo, PSA e D accedono anche ai dati operativi in lettura e scrittura, senza impersonazione.
- **Gestione permessi**: `permissions.status` della matrice legacy è l'interruttore "gestisce i permessi altrui" (`canManagePermissions`).
- **Default per ruolo**: chi crea un utente senza poter gestire i permessi gli assegna la matrice di default del ruolo (tabella del form legacy, D-27), limitata ai flag del creatore.

### 8.3 Scope, gruppo nel percorso e feature
- **Scope calcolato dal server** alla verifica della credenziale: PSA tutto; D i gruppi attivi e non nel cestino con il proprio `dealerId`; SA il proprio gruppo; CA le proprie aziende e i loro punti vendita; PA i propri punti vendita. I repository lo applicano a ogni query; il database del gruppo si apre solo da un accesso verificato.
- **Gruppo nel percorso** (`/v1/groups/:groupId/...`, D-10): verificato contro lo scope; gruppo inesistente o fuori scope ⇒ **404** identico; gruppi sospesi o nel cestino raggiungibili solo dal PSA. Ogni accesso di PSA e D a un gruppo va nel registro delle attività (`group.crossAccess`).
- **Feature del gruppo** (D-13): una route di un modulo può dichiarare la feature richiesta; **dopo** il controllo del gruppo e del permesso, un gruppo con la feature spenta risponde `403 FEATURE_DISABLED` **per tutti i ruoli**, PSA e D compresi. Le feature si leggono nella stessa query dello stato del gruppo.
- **Chi modifica cosa nel gruppo** (D-13): nome, descrizione, lingue e impostazioni statistiche PSA, D e SA; feature e integrazioni PSA e D; `demo` solo PSA. Un campo non ammesso è `403` con il campo nei dettagli.
- **Perimetro di CA e PA sui punti vendita** (D-29): su promozioni e tipi di carta della fidelity, i cui elementi si riferiscono a punti vendita, un CA o un PA scrive solo elementi i cui punti vendita sono tutti nel proprio scope; la lista vuota significa "tutto il gruppo" ed è loro vietata (`403`); modificare o eliminare un elemento esistente che riguarda punti vendita fuori scope o tutto il gruppo è `403`. La lettura resta completa.
- Risorse fuori scope: **404**.

### 8.4 Anti-escalation
- **Ruoli gestibili** (pari ammessi): PSA → tutti; D → SA, CA, PA, E; SA → SA, CA, PA, E; CA → CA, PA, E; PA → PA, E; sempre dentro il proprio scope (CA: aziende del bersaglio ⊆ proprie; PA: punti vendita del bersaglio ⊆ propri). Il ruolo D non si assegna né si toglie con una modifica (D-09).
- **Nessuna auto-modifica**: nessuno cambia il proprio ruolo, scope, permessi o stato (per sé stessi si usa `/v1/me`).
- **Concedi solo ciò che hai**: ogni flag concesso deve essere posseduto da chi lo concede (contano solo i permessi che il ruolo dell'attore può avere, così D e SA concedono `groups.r`/`groups.w` senza poter concedere `dealers:*`); cambiare la matrice altrui, anche nei moduli che non danno ancora permessi e in `status`, richiede "Gestione permessi".
- **Nessun pari più forte**: per modificare, resettare, cestinare o eliminare un utente l'attore deve avere almeno tutti i permessi del bersaglio.
- **Permessi della cassa** (D-27): `pos.enabled` e `pos.grants` sono permessi, `pos.options` sono preferenze. Cambiarli richiede "Gestione permessi"; PSA, D e SA li impostano liberamente; CA e PA concedono solo ciò che hanno loro, non abilitano l'app della cassa se non è abilitata per loro e, se hanno un tetto di sconto, non possono toglierlo né alzarlo oltre il proprio (`403` con il flag nei dettagli).
- Matrice e valori della cassa si scrivono solo con `$set` puntuali, mai sostituendo `permissions`; il body non accetta i campi legacy.

### 8.5 Backoffice
Feature e permessi nel backoffice (menu, guard, direttive `*fcCan` e `*fcFeature`, campi disabilitati) sono **solo interfaccia**: il server decide a ogni richiesta e il backoffice mostra i suoi `403`. Le feature si leggono dal profilo (SA, CA, PA) o dal dettaglio del gruppo di lavoro (PSA, D).

## 9. Input e API
Endpoint REST a risorse (`doc/API-Guidelines.md`); **nessuna query, filtro, update o pipeline MongoDB accettata dal client**. Validazione per allowlist di body, query e params: proprietà sconosciute rifiutate, chiavi che iniziano con `$` o contengono `.` rifiutate (anche `__proto__`, `constructor`, `prototype`), profondità limitata, Unicode non valido rifiutato, tipi e lunghezze controllati, `ObjectId` validati; errori `422` senza mai il valore ricevuto. Limiti di dimensione per route (default 100 KB; più ampi e motivati per avatar, promozioni e cataloghi premi), solo `application/json` UTF-8 (`415` altrimenti). Gli id degli elementi dei cataloghi sono generati dal server con il CSPRNG. Le liste sono paginate a cursore con limite massimo e `maxTimeMS`.

## 10. Protezioni HTTP, file, segreti e log
- **Header** (middleware proprio): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`, niente `X-Powered-By`.
- **Cache**: **tutte** le risposte sono `Cache-Control: no-store`, compresi il dettaglio del gruppo e le liste compatte di riferimento (elenco dei gruppi, aziende, punti vendita, letture `lookup/*`, 1.5.4), che portano in più un `ETag` debole per la rivalidazione (`If-None-Match` ⇒ `304`) della copia che il backoffice tiene solo in memoria, calcolato dopo autenticazione, gruppo, permesso e validazione sul body già filtrato per il chiamante.
- **CORS**: allowlist esatta di origini per ambiente, solo su `/v1`, senza credenziali; nessun header CORS su `/public/v1` e `/health`.
- **Backoffice**: servito con CSP stretta (`script-src 'self'`, stili con nonce per richiesta, `connect-src` solo verso l'URL delle API, `frame-ancestors 'none'`, Trusted Types obbligatori), HSTS e header analoghi; token in memoria e refresh in `sessionStorage` (§4); nessun segreto nella build.
- **Timeout** delle richieste (default 30 s) e `trust proxy` impostato sul numero esatto di proxy.
- **File** (upload delle immagini, passo 6B, `POST /v1/groups/{groupId}/media/images`): realizzato con `multer` in memoria e limiti stretti. La route gira **dopo** autenticazione, rate limit, verifica del gruppo e permesso, quindi il body non si legge per chi non può inviarlo.
  - **Limiti:** un solo file nel campo `file`, nessun altro campo o parte, al massimo 10 MB (`413`), `415` se non è `multipart/form-data`; al massimo 40 megapixel e 16383 pixel per lato; al massimo 2 upload in elaborazione per processo con una coda di 6 (oltre, `503`); ogni pipeline di decodifica ha un timeout.
  - **Contenuto:** il formato (JPEG, PNG, WebP) si decide **solo dai magic bytes**: tipo dichiarato ed estensione del client non contano; SVG, GIF, HTML e il resto sono `415`. Ogni immagine è **decodificata e ricodificata** da sharp (con il livello di errore più severo: ogni avviso è un errore) e **privata di ogni metadato** (EXIF, posizione, profili, commenti): gli oggetti salvati sono byte generati dal server, quindi un file poliglotta non sopravvive.
  - **Nomi:** generati dal server (`<nome ridotto a [a-z0-9-]>-<8 esadecimali casuali>.<estensione del formato reale>`), percorso costruito solo da id e nomi del server (`<gruppo>/media/image/<taglia>/<nome>`); l'oggetto non ne sovrascrive un altro (`ifGenerationMatch=0`) e il rollback cancella solo ciò che questa richiesta ha scritto (per generation). Il testo originale entra solo in `title`/`alt`, ripulito (controlli, formato, `<`, `>`, `"`). Nessuna cartella pubblica gestita dal backend: gli oggetti si leggono dal CDN davanti al bucket.
  - **Credenziali dello storage:** solo lato server, mai dal client. In produzione il token del metadata server (Workload Identity su GKE, nessuna chiave); in sviluppo un file di service account a permessi minimi, letto una volta all'avvio, con JWT RS256 firmato con `node:crypto` e scambiato **solo** con l'endpoint OAuth di Google (il `token_uri` del file è ignorato; chiave RSA di almeno 2048 bit). Nessun redirect seguito. Chiave, JWT e token non finiscono mai nei log né negli errori; un errore dello storage è `503` e si registra solo operazione, motivo e stato HTTP.
  - **Rate limit e quote:** 30 al minuto per utente, 300 al giorno per utente e 2000 al giorno per gruppo (nessuna cancellazione è possibile in questo passo, quindi le quote proteggono anche i costi dello storage).
  - **Proprietà e isolamento:** l'immagine va nel gruppo dell'URL (verificato nel perimetro), nel suo database; ha `createdBy` e `companyId`; il CA ne vede e usa solo di proprie aziende. Un logo dell'azienda si costruisce **dal documento memorizzato** (directory fissa, nome semplice, tipo `image/*`), mai da ciò che manda il client, perché il legacy lascia riscrivere i documenti `files` a ogni utente.
  - **Avatar degli utenti** (D-27): data URL solo PNG, JPEG o WebP, tipo **verificato dai magic bytes** del contenuto decodificato (non dal prefisso), base64 canonico, al massimo **200 KB**; un avatar legacy che non supera i controlli non viene mai servito (risposta `avatar: null` con `hasAvatar: true`). Il registro conserva solo un'impronta dell'immagine.
- **PIN degli utenti** (D-27): impostabile e **mai restituito né registrato**. È salvato **in chiaro** in `users.pin` (3–6 cifre) perché il POS legacy lo confronta lato client: eccezione di coesistenza al principio di §2.3; l'hash arriverà con il dominio cassa. Le risposte portano solo `pinSet`, il registro solo `pinSet` e il tipo di cambio, il logger redige la chiave `pin`, le letture degli utenti non caricano mai `password`, `pin` né `tokens`. Il proprio PIN si cambia con `PUT /v1/me/pin` e la **password attuale**, con lo stesso rate limit del cambio password. Il PIN non è una credenziale di sessione: cambiarlo non revoca sessioni.
- **Chiavi delle integrazioni dei gruppi** (D-29): **solo impostabili, mai lette**. La lettura del gruppo calcola nel database il solo booleano `apiKeySet`, quindi una chiave non esce mai dal database, non è tenuta in memoria né registrata; si scrive nel formato del documento legacy (`settings.integrations.<provider>.apiKey`, oggi non cifrata). `groups.apiKey`, `databaseHost` e `filesHost` **non sono gestiti** (né letti né scritti).
- **Documento del gruppo**: budget di **8 MiB** (metà del limite di MongoDB); una scrittura che lo farebbe crescere oltre è `422`, così un documento vicino al limite non blocca le scritture successive, anche del legacy. Scritture solo dei campi posseduti, con concorrenza ottimistica.
- **Configurazione** da variabili d'ambiente validate all'avvio (fail-fast, nessun default per l'ambiente); in produzione da secret manager; `.env.example` con soli nomi. Guardia sui nomi dei database: con `APP_ENV=development` i database `production_*` non sono raggiungibili.
- **Dati sensibili**: i dati personali degli utenti sono in chiaro (D-05). La cifratura a livello di campo con **AES-256-GCM** (chiave dedicata con versione per la rotazione) resta il metodo previsto per i segreti a riposo, da applicare quando una decisione la richiederà (§12).
- **Log** strutturati con redazione profonda di token, chiavi, password, PIN, header `Authorization` e `X-Api-Key`, PII, URI del database e dettagli degli errori MongoDB; correlation id per richiesta generato dal server.
- **Registro delle attività** (database common, collection `activityEvents`, una sola per attività, sicurezza ed errori): senza validatore `$jsonSchema` del database, la validazione per allowlist è applicativa; le scritture non fanno mai fallire una richiesta. Conserva login riusciti e falliti, refresh e riuso rilevato, revoche, cambi di ruolo, scope, stato e permessi (anche della cassa), accessi di PSA e D ad altri gruppi, sospensioni, riattivazioni, cestino e ripristino dei gruppi, superamenti dei rate limit, errori 5xx e JavaScript del backoffice, e gli eventi di dati di utenti, dealer, gruppi e degli undici cataloghi del gruppo con prima/dopo. **Mai segreti**: password, PIN, token, chiavi, credenziali e integrazioni sono oscurati per chiave e per prefisso; dell'avatar solo l'impronta. Conservazione con TTL: 365 giorni per `data` e `security`, 90 per `error`.

## 11. Integrazioni e webhook
Credenziali dei provider solo lato server e per gruppo; ogni proxy verso un provider è autenticato e autorizzato; webhook in ingresso con verifica della firma, anti-replay e idempotenza (skill `webhook-verification`). Oggi nessun proxy né webhook è realizzato: le chiavi delle integrazioni del gruppo sono solo impostabili (§10).

## 12. Decisioni aperte
1. ~~Refresh token del backoffice in cookie `HttpOnly` o nel body.~~ Decisa il 2026-11-02 (D-12): body, conservato in `sessionStorage` (§4).
2. **Credenziale dell'app del server di punto vendita** verso `/v1` (D-24, §5): login di un utente o credenziale di dispositivo per punto vendita. Comprende la sorte dell'API key di gruppo del legacy (sostituisce la vecchia voce sulla migrazione da `/store/v1`, eliminata con D-23).
3. Autenticazione degli operatori `E` verso il cloud e sincronizzazione degli utenti verso l'app del server di punto vendita: fuori scope sull'app (D-22), verso il cloud legata a D-24.
4. ~~Valori dei limiti di default.~~ Decisi il 2026-11-02 per `/v1` (§7). Restano aperti limiti e quote delle API pubbliche ed eventuali piani diversi per gruppo.
5. ~~Permessi per modulo per singolo utente.~~ Decisa il 2026-11-02 (D-06) ed estesa con D-27 e D-28: la matrice legacy a 13 moduli restringe il tetto del ruolo; PSA e D hanno l'intero tetto (§8.2).
6. ~~Conservazione dell'audit log.~~ Decisa il 2026-11-02: 365 giorni per `data` e `security`, 90 per `error` (§10).
7. Hash del PIN: oggi in chiaro per il POS legacy (§10), con il dominio cassa.
8. Cifratura a riposo delle chiavi delle integrazioni dei gruppi, oggi nel formato non cifrato del documento legacy condiviso (§10).
