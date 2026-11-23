import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { Textarea } from '../../shared/ui/textarea/textarea';
import { languageName } from '../groups/languages';
import { QUICK_COLORS } from '../product-categories/category.types';
import { CoreModel } from './product-model';
import { ProductWarningNote } from './product-warning-note';
import { MODIFIER_TYPES, ProductFeatures, ProductWarning } from './product.types';

/**
 * The general tab of a product, with the cards of the legacy form: type and switches, the
 * integrations, code and PLU (with the warning of a duplicate), the texts in every language, the
 * brand, position and production value, the duration of a service, the settings of a modifier,
 * the units of measure, the scales, the colors of the buttons, the restaurant settings and the
 * period of availability. A card is there only when the group has the feature it needs. In the quick
 * view the scales and restaurant cards are left out and the period only comes with the
 * `advancedProducts` feature. Every control is bound to the form of the page (`form`), which
 * decides whether it can be edited.
 */
@Component({
  selector: 'fc-product-general',
  imports: [Checkbox, FormField, ProductWarningNote, Select, TextField, Textarea, TPipe],
  templateUrl: './product-general.html',
  styleUrl: './product-section.css',
})
export class ProductGeneral {
  private readonly i18n = inject(I18nService);

  /** The form of the fields of the product (bound by the page). */
  readonly form = input.required<FieldTree<CoreModel>>();
  readonly groupId = input.required<string>();
  readonly features = input.required<ProductFeatures>();
  /** Languages of the texts. */
  readonly languages = input.required<readonly string[]>();
  /** The language the name must be given in. */
  readonly requiredLang = input.required<string>();
  /** The types the user can choose from. */
  readonly types = input.required<readonly string[]>();
  /** The product is a modifier. */
  readonly modifier = input.required<boolean>();
  /** The type of the product is `service`. */
  readonly service = input.required<boolean>();
  /** The quick view: no scales, no restaurant card, and the period only with `advancedProducts`. */
  readonly quick = input(false);
  /** The controls cannot be changed: the swatches are not offered. */
  readonly readOnly = input(false);
  readonly brands = input.required<readonly SelectOption[]>();
  readonly units = input.required<readonly SelectOption[]>();
  /** The duplicates of the code and the PLU. */
  readonly warnings = input<readonly ProductWarning[]>([]);

  protected readonly typeOptions = computed<SelectOption[]>(() =>
    this.types().map((type) => ({ value: type, label: this.i18n.t(`PRODUCTS.TYPE.${type.toUpperCase()}`) })),
  );
  protected readonly modifierTypes = computed<SelectOption[]>(() =>
    MODIFIER_TYPES.map((type) => ({ value: type, label: this.i18n.t(`PRODUCTS.MODIFIER.TYPE_${type.toUpperCase()}`) })),
  );
  protected readonly scaleTypes = computed<SelectOption[]>(() => [
    { value: 'weight', label: this.i18n.t('PRODUCTS.SCALES.WEIGHT') },
    { value: 'piece', label: this.i18n.t('PRODUCTS.SCALES.PIECE') },
  ]);
  protected readonly codeWarning = computed(() => this.warnings().find((warning) => warning.field === 'code'));
  protected readonly pluWarning = computed(() => this.warnings().find((warning) => warning.field === 'plu'));
  protected readonly showScales = computed(() => this.features().scales && !this.quick());
  protected readonly showDining = computed(() => this.features().rooms && !this.quick());
  protected readonly showPeriod = computed(() => !this.quick() || this.features().advancedProducts);
  protected readonly quickColors = QUICK_COLORS;

  /** Label of a text control: the field and the language it is in. */
  protected languageLabel(field: string, code: string): string {
    return this.i18n.t(`PRODUCTS.FIELD.${field}_IN`, {
      language: languageName(code, this.i18n.language() ?? DEFAULT_LANGUAGE),
    });
  }

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected setBackground(color: string): void {
    this.form().colors.background().value.set(color);
  }
}
