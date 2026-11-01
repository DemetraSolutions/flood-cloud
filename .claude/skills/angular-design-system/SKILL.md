---
name: angular-design-system
description: Usa quando crei o modifichi stili, token, tema chiaro/scuro o componenti UI condivisi del backoffice (pulsanti, campi, tabelle, dialog, toast, badge, stati vuoto/caricamento/errore).
---
# Angular Design System

Riferimenti: agente `ux_ui_expert`. Nessuna libreria UI esterna senza approvazione (skill `dependency-approval`).

## Struttura
```
backoffice/src/styles/
  tokens.css        # design token: colori, tipografia, spaziature, raggi, ombre, durate
  themes.css        # mappatura dei token per tema chiaro e scuro
  base.css          # reset minimo, tipografia di base, focus visibile
backoffice/src/app/shared/ui/   # componenti di base riusabili
```

## Token
```css
:root {
  /* Raw palette: never used directly by components. */
  --palette-blue-600: oklch(0.55 0.17 255);
  --palette-neutral-50: oklch(0.98 0 0);
  --palette-neutral-900: oklch(0.2 0 0);

  /* Semantic tokens: the only ones components may use. */
  --color-bg: var(--palette-neutral-50);
  --color-text: var(--palette-neutral-900);
  --color-primary: var(--palette-blue-600);
  --color-danger: oklch(0.55 0.2 25);
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem; --space-6: 1.5rem;
  --radius-sm: 4px; --radius-md: 8px;
  --font-body: system-ui, sans-serif;
  --duration-fast: 120ms;
}
:root[data-theme='dark'] {
  --color-bg: var(--palette-neutral-900);
  --color-text: var(--palette-neutral-50);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --color-bg: var(--palette-neutral-900);
    --color-text: var(--palette-neutral-50);
  }
}
```
- I componenti usano **solo token semantici** (`--color-primary`, `--space-4`), mai la palette o valori letterali.
- Ogni nuova coppia testo/sfondo va verificata per il contrasto (4.5:1 testo, 3:1 componenti) in entrambi i temi.
- Animazioni con le durate dei token e disattivate con `prefers-reduced-motion: reduce`.

## Componenti UI condivisi
- In `shared/ui/`, standalone, con input e output a signal, senza logica di dominio né chiamate HTTP (componenti "di presentazione").
- Stili incapsulati nel componente; personalizzazione solo tramite token o input dichiarati, mai sovrascrivendo dall'esterno classi interne.
- Usano elementi nativi (`button`, `input`, `dialog`, `table`) per avere gratis tastiera e accessibilità.
- Catalogo minimo atteso: `button`, `icon-button`, `text-field`, `select`, `checkbox`, `data-table`, `paginator` (a cursore), `dialog`, `confirm-dialog`, `toast`, `status-badge`, `empty-state`, `error-state`, `skeleton`, `group-switcher`.
- Si creano quando il primo passo ne ha bisogno, non in anticipo.

## Stati di una vista
Ogni vista con dati mostra esplicitamente: caricamento (`skeleton`), vuoto (`empty-state` con azione), errore (`error-state` con "Riprova"), contenuto.

## Test
Ruolo e nome accessibile, uso da tastiera (Tab, Invio, Spazio, Esc nei dialog), focus restituito alla chiusura dei dialog, varianti e stati disabilitati.
