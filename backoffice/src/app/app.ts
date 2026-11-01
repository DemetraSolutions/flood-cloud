import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme/theme.service';
import { StartupError } from './core/startup/startup-error';
import { StartupState } from './core/startup/startup-state';
import { ToastRegion } from './shared/ui/toast/toast-region';

/** Root component: the routed application, or the startup error page when startup failed. */
@Component({
  selector: 'fc-root',
  imports: [RouterOutlet, StartupError, ToastRegion],
  templateUrl: './app.html',
})
export class App {
  protected readonly startup = inject(StartupState);
  // Instantiated here so that the saved theme is applied as soon as the app starts.
  private readonly theme = inject(ThemeService);
}
