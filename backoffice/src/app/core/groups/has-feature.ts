import { Directive, effect, inject, input, TemplateRef, ViewContainerRef } from '@angular/core';
import { FeatureName } from './feature-catalog';
import { GroupFeatures } from './group-features';

/**
 * Renders its template only when the working group has a feature turned on:
 * `<section *fcFeature="'warehouse'">`. It hides UI; the server enforces the feature on every
 * request (`403 FEATURE_DISABLED`). Like `fcCan`, it follows the state: the view appears or
 * disappears when the features change.
 */
@Directive({ selector: '[fcFeature]' })
export class HasFeature {
  /** Feature name of the catalog. */
  readonly feature = input.required<FeatureName>({ alias: 'fcFeature' });

  private readonly features = inject(GroupFeatures);
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly container = inject(ViewContainerRef);

  constructor() {
    effect(() => {
      const enabled = this.features.enabled(this.feature());
      if (enabled && this.container.length === 0) {
        this.container.createEmbeddedView(this.template);
      } else if (!enabled) {
        this.container.clear();
      }
    });
  }
}
