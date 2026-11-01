---
name: angular-permissions-ui
description: Usa quando mostri, nascondi o abiliti parti del backoffice in base a ruolo e permessi (PSA, D, SA, CA, PA), quando gestisci il gruppo di lavoro di PSA e dealer o proteggi una route per permesso.
---
# Angular Permissions UI

Riferimenti: `doc/Security-Model.md` §8 (ruoli e scope), skill `angular-auth-session`.

## Principio
**L'interfaccia nasconde, il server decide.** Nascondere un pulsante migliora l'esperienza ma non protegge nulla: ogni permesso è verificato dal backend. Il frontend non deve mai essere l'unico controllo, né derivare permessi in modo diverso dal server.

## Fonte dei permessi
- Dopo il login il backoffice legge il profilo corrente da un endpoint dedicato (es. `GET /v1/me`): utente, ruolo, **permessi effettivi** (`resource:action`) e perimetro (gruppi, aziende, punti vendita visibili).
- Il frontend **non** ricalcola i permessi dal ruolo con una propria tabella: usa quelli restituiti dal server, così le regole stanno in un solo posto.
- Il profilo vive in un servizio di sessione basato su signal (`currentUser`, `permissions`, `scope`), azzerato al logout.

## API del frontend
```ts
/** Session-scoped permission checks backed by the server-provided profile. */
@Service()
export class Permissions {
  private readonly session = inject(Session);

  /** Whether the current user holds the given 'resource:action' permission. */
  can(permission: string): boolean {
    return this.session.permissions().has(permission);
  }
}
```
- **Nei template**: `@if (permissions.can('products:write')) { ... }`, oppure una direttiva strutturale condivisa se l'uso si ripete molto.
- **Nelle route**: guard funzionale `canMatch` con il permesso nei `data` della route, così i moduli non permessi non vengono neppure caricati.
- **Voci di menu** generate da una configurazione che dichiara il permesso richiesto per ciascuna.

## Gruppo di lavoro (PSA e dealer)
- PSA e D vedono più gruppi: un **selettore del gruppo** sempre visibile nell'intestazione indica su quale gruppo si sta lavorando.
- Il gruppo selezionato fa parte dell'URL (`/groups/:groupId/...`) così ricarica, link condivisi e pulsante indietro funzionano; non si conserva solo in memoria o in `localStorage`.
- Cambiare gruppo azzera le cache dei dati del gruppo precedente.
- SA, CA e PA hanno un solo gruppo: il selettore non compare.

## Risposte del server
- `403` su un'azione mostrata per errore: messaggio "Non hai i permessi per questa operazione" e aggiornamento del profilo (i permessi potrebbero essere cambiati).
- `404` su una risorsa: pagina "non trovato", senza distinguere tra inesistente e non visibile.

## Test
Per ogni elemento condizionato: visibile con il permesso, assente senza; guard che blocca la navigazione senza permesso; selettore del gruppo visibile solo per PSA e D; cambio di gruppo che aggiorna URL e dati.
