import { Service, signal } from '@angular/core';
import { readSessionStorage, removeSessionStorage, writeSessionStorage } from '../storage';

/** `sessionStorage` key of the flag of the mode (the only thing kept; the tab forgets it when it closes). */
export const NON_FISCAL_KEY = 'fc.nonFiscalVisible';
/** Clicks on the name of the application that turn the mode on. */
export const NON_FISCAL_CLICKS = 7;
/** Window, in milliseconds, in which those clicks must happen. */
export const NON_FISCAL_WINDOW_MS = 3000;

/**
 * The "UM" mode (decision of 2026-11-25): while it is on, the reads of the sales also ask for the
 * non fiscal ones ("Preventivo", `nonFiscal=include`). It is turned on by
 * {@link NON_FISCAL_CLICKS} clicks on the name of the application within
 * {@link NON_FISCAL_WINDOW_MS}, and turned off by one click while it is on. It has no PIN and no
 * visible indicator; the flag lives in the `sessionStorage` of the tab and the session clears it
 * at sign-out. The server enforces nothing here: the mode only chooses what the interface asks for.
 */
@Service()
export class NonFiscalMode {
  private readonly state = signal(readSessionStorage(NON_FISCAL_KEY) === '1');
  private taps: number[] = [];

  /** Whether the non fiscal sales are asked for. */
  readonly nonFiscalVisible = this.state.asReadonly();

  /**
   * A click on the name of the application.
   *
   * @param now Time of the click in milliseconds (the clock, unless a test gives it).
   */
  brandClick(now: number = Date.now()): void {
    if (this.state()) {
      this.set(false);
      return;
    }
    this.taps = [...this.taps.filter((tap) => now - tap < NON_FISCAL_WINDOW_MS), now];
    if (this.taps.length >= NON_FISCAL_CLICKS) {
      this.set(true);
    }
  }

  /** Turns the mode off and forgets the clicks (at sign-out). */
  reset(): void {
    this.set(false);
  }

  private set(on: boolean): void {
    this.taps = [];
    this.state.set(on);
    if (on) {
      writeSessionStorage(NON_FISCAL_KEY, '1');
    } else {
      removeSessionStorage(NON_FISCAL_KEY);
    }
  }
}
