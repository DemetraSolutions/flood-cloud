---
name: angular-signals-state
description: Usa quando gestisci stato nel backoffice Angular 22: signal, computed, linkedSignal, effect, untracked, resource e rxResource, servizi di stato a signal per feature o sessione, interoperabilità con RxJS.
---
# Angular Signals State (v22)

## Scegliere la primitiva
| Bisogno | Primitiva |
|---|---|
| Stato locale scrivibile | `signal()` |
| Valore derivato | `computed()` |
| Stato derivato ma modificabile dall'utente (es. selezione che si azzera quando cambia la lista) | `linkedSignal()` |
| Dati asincroni che dipendono da altri signal | `httpResource()` (HTTP) o `resource()`/`rxResource()` (altro) |
| Effetto collaterale verso l'esterno (titolo pagina, localStorage di preferenze, log) | `effect()` |
| Dopo il rendering, lavoro sul DOM | `afterRenderEffect()` |

`resource`, `rxResource` e `httpResource` sono **stabili** in v22. `debounced()` è **sperimentale**: non usarlo senza dirlo all'utente.

## Regole
1. **Mai `effect` per derivare stato** o per copiare un signal in un altro: usa `computed` o `linkedSignal`.
2. Le letture dopo un `await` non sono tracciate: nei calcoli reattivi niente codice asincrono.
3. `untracked()` per leggere un signal senza crearne la dipendenza, con un commento che spiega perché.
4. Esporre all'esterno solo signal in sola lettura (`asReadonly()`), con metodi espliciti per modificarli.
5. Aggiornamenti immutabili (`update(list => [...list, item])`); niente mutazioni di oggetti contenuti in un signal.
6. RxJS solo dove porta valore (flussi di eventi, operatori temporali); conversione con `toSignal`/`toObservable` di `@angular/core/rxjs-interop`, sottoscrizioni chiuse con `takeUntilDestroyed`.

## Servizio di stato di una feature
```ts
/** Holds the selection state of the products page. */
@Service()
export class ProductSelection {
  private readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  readonly selected = this.selectedIds.asReadonly();
  readonly count = computed(() => this.selectedIds().size);

  toggle(id: string): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  clear(): void {
    this.selectedIds.set(new Set());
  }
}
```
- Stato di sessione (utente, permessi, gruppo corrente) in `core/`; stato di feature nella feature; stato di una sola vista nel componente.
- Nessuna libreria di state management esterna senza approvazione.
- Lo stato legato a un gruppo si azzera quando PSA o dealer cambiano gruppo.

## Test
Valori iniziali, derivazioni, aggiornamenti, azzeramento; per `effect` e resource usa `await fixture.whenStable()` o `TestBed.tick()` secondo la documentazione della versione installata.
