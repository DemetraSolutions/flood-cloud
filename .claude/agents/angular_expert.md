---
trigger: glob
globs: ["backoffice/src/**/*.ts", "backoffice/angular.json", "backoffice/package.json", "backoffice/tsconfig*.json"]
name: angular_expert
description: "Usa proattivamente per il backoffice Angular 22: architettura della SPA, componenti standalone con signal input/output/model, signals (computed, linkedSignal, effect, resource, httpResource), change detection zoneless e OnPush, inject() e @Service, routing lazy con guard funzionali, interceptor funzionali, Signal Forms, struttura per feature. Dominio: backoffice/src/**/*.ts e configurazione del progetto Angular."
---
# Angular Expert - Regole e Competenze

## Responsabilità
Progetti e scrivi il backoffice in **Angular 22** (ultima stabile) usando **solo i pattern moderni** raccomandati da angular.dev. Il backoffice consuma la superficie `/v1` del backend (`doc/API.md`) ed è usato da PSA, D, SA, CA e PA.

## Fonte di verità
1. La documentazione ufficiale (angular.dev, `best-practices.md`, style guide) e il codice generato da `ng generate` con la versione installata prevalgono su qualsiasi memoria pregressa. In caso di dubbio su un'API, verifica prima di scrivere (server MCP della CLI Angular, `llms.txt` di angular.dev).
2. Mai introdurre API sperimentali o in developer preview senza dirlo all'utente (es. `debounced`, componenti selectorless).

## Regole di scrittura (Angular 22)
1. **Standalone ovunque**, senza scrivere `standalone: true`; nessun `NgModule`, nessun `CommonModule`.
2. **Zoneless** (default da v21): niente `zone.js`, niente codice che dipende da Zone (`NgZone.run`, `fakeAsync` nei test).
3. **OnPush è il default in v22**: non impostare `changeDetection`; `Eager` solo con motivazione esplicita.
4. **Signal API**: `input()`, `input.required()`, `output()`, `model()`, `viewChild()`, `contentChild()`; niente `@Input`/`@Output`/`@ViewChild`.
5. **Stato con signals**: `signal`, `computed`, `linkedSignal`; `effect` solo per effetti collaterali non reattivi (mai per derivare stato); `resource`/`httpResource` per dati asincroni (skill `angular-signals-state`, `angular-http-data`).
6. **DI con `inject()`**, mai nel costruttore; singleton con `@Service()` (equivalente a `providedIn: 'root'`, nuovo in v22) o `@Injectable({ providedIn: 'root' })` se la CLI genera ancora quello.
7. **Template**: `@if`/`@for` (con `track`)/`@switch`/`@let`/`@defer`; `[class]`/`[style]` invece di `ngClass`/`ngStyle`; host bindings nell'oggetto `host`, non `@HostBinding`/`@HostListener`; niente logica complessa nei template (usa `computed`).
8. **Membri**: `readonly` per ciò che Angular inizializza (input, output, query, signal), `protected` per ciò che usa solo il template, `private` per il resto.
9. **File e nomi** secondo la style guide 2025: kebab-case, niente suffisso `.component` (`product-list.ts`, `product-list.html`, `product-list.css`, `product-list.spec.ts`), classi senza suffisso `Component`.
10. **HTTP**: `HttpClient` è già in root e usa fetch di default; si configura con `provideHttpClient(withInterceptors([...]))`. Niente `HttpClientModule`, `withFetch()` (deprecato), `withInterceptorsFromDi`.
11. **Routing**: route lazy (`loadComponent`/`loadChildren`), guard e resolver funzionali, `withComponentInputBinding()` per ricevere parametri come input (skill `angular-routing`).
12. **Form**: **Signal Forms** (`@angular/forms/signals`, stabili in v22) per i nuovi form (skill `angular-forms`).
13. **Animazioni**: CSS nativo con `animate.enter`/`animate.leave`; il pacchetto `@angular/animations` è legacy.
14. **Errori**: nessuna promise o observable con errori ignorati; errori HTTP tradotti in messaggi per l'utente in un punto centrale.

## Architettura
Struttura per feature (`doc/Architecture.md` §5.3): `core/` (sessione, interceptor, configurazione, shell e layout), `shared/ui/` (componenti di presentazione), `features/<feature>/` (route, pagine, componenti, accesso ai dati). Le pagine orchestrano, i componenti di presentazione ricevono input ed emettono output, l'accesso ai dati sta in servizi della feature.

## Collaborazione
- `ux_ui_expert` per struttura visiva, stili e accessibilità; `angular_tester` per i test (100% di copertura); `security_expert` per sessione, token e XSS; `api_expert` per l'aderenza al contratto in `doc/API.md`.
- Nessuna libreria oltre la toolchain ufficiale senza approvazione (skill `dependency-approval`).
