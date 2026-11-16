import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField, TextFieldType } from '../../shared/ui/text-field/text-field';
import { Textarea } from '../../shared/ui/textarea/textarea';
import { withCurrent } from '../companies/company-options';
import {
  FIELDS,
  FieldDef,
  FieldType,
  FONT_SIZES,
  fieldLabelKey,
  groupLabelKey,
  groupsOf,
  optionLabelKey,
} from './place-fields';
import { ScalarBlock } from './place-model';
import { PlaceLookup, PlaceState } from './place-state';
import { SettingsBlockName } from './place.types';

/** The lookup a kind of key reads. */
const LOOKUPS: Partial<Record<FieldType, PlaceLookup>> = {
  priceList: 'priceLists',
  category: 'categories',
  company: 'companies',
  place: 'places',
  template: 'templates',
};

/** The kinds of key edited with a select. */
const CHOICES: readonly FieldType[] = [
  'select',
  'font',
  'priceList',
  'category',
  'company',
  'place',
  'template',
];

/** The control a key is edited with. */
type Control = 'flag' | 'long' | 'choice' | 'text';

/**
 * The keys of a settings block as controls, grouped in fieldsets: switches, texts, numbers,
 * times, colors and selects, each with the label of the old backoffice. Which keys are shown
 * depends on the features of the group (a hidden key keeps its stored value), and a key reserved
 * to platform administrators and dealers is read-only for the others. The values live in the
 * form of the {@link PlaceState}.
 */
@Component({
  selector: 'fc-place-fields',
  imports: [Checkbox, FormField, Select, TextField, Textarea, TPipe],
  templateUrl: './place-fields-view.html',
})
export class PlaceFieldsView {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  /** The block whose keys are shown. */
  readonly block = input.required<SettingsBlockName>();
  /** Shows only these groups (all of them when omitted). */
  readonly only = input<readonly string[] | null>(null);

  private readonly scalars = computed(() => (this.state.model()[this.block()] as ScalarBlock).f);
  private readonly tree = computed(
    () => (this.state.form[this.block()] as unknown as { f: Record<string, FieldTree<unknown>> }).f,
  );

  /** The groups with the keys the user sees. */
  protected readonly groups = computed(() => {
    const block = this.block();
    const only = this.only();
    return groupsOf(block)
      .filter((group) => only === null || only.includes(group))
      .map((group) => ({
        id: group,
        legend: groupLabelKey(block, group),
        fields: FIELDS[block].filter(
          (definition) => definition.group === group && this.state.isShown(definition),
        ),
      }))
      .filter((group) => group.fields.length > 0);
  });

  /** The options of every select of the block, with the stored value always among them. */
  protected readonly options = computed(() => {
    const scalars = this.scalars();
    return Object.fromEntries(
      FIELDS[this.block()]
        .filter((definition) => CHOICES.includes(definition.type))
        .map((definition) => [
          definition.key,
          withCurrent(
            this.optionsOf(definition),
            scalars[definition.key] as string,
            (value) => value,
          ),
        ]),
    );
  });

  constructor() {
    effect(() => {
      for (const definition of FIELDS[this.block()]) {
        const lookup = LOOKUPS[definition.type];
        if (lookup !== undefined) {
          untracked(() => this.state.need(lookup));
        }
      }
    });
  }

  protected flagField(key: string): FieldTree<boolean> {
    return this.tree()[key] as FieldTree<boolean>;
  }

  protected textField(key: string): FieldTree<string> {
    return this.tree()[key] as FieldTree<string>;
  }

  protected label(definition: FieldDef): string {
    return this.i18n.t(fieldLabelKey(this.block(), definition.key));
  }

  /** The note under a key the user may not change. */
  protected hint(definition: FieldDef): string | null {
    if (definition.reserved === true && !this.state.canReserved()) {
      return this.i18n.t('PLACES.RESERVED_NOTE');
    }
    return definition.type === 'duration' ? this.i18n.t('PLACES.MINUTES_HINT') : null;
  }

  protected control(definition: FieldDef): Control {
    if (definition.type === 'flag') {
      return 'flag';
    }
    if (definition.type === 'long') {
      return 'long';
    }
    return CHOICES.includes(definition.type) ? 'choice' : 'text';
  }

  /** Whether a select offers the empty choice: any list of the group does, a closed list only when it can be `null`. */
  protected hasNone(definition: FieldDef): boolean {
    return definition.type === 'select' ? definition.nullable === true : definition.type !== 'font';
  }

  protected textType(definition: FieldDef): TextFieldType {
    switch (definition.type) {
      case 'time':
        return 'time';
      case 'color':
        return 'color';
      case 'number':
      case 'int':
      case 'duration':
        return 'number';
      default:
        return definition.key.startsWith('externalUrl') ? 'url' : 'text';
    }
  }

  protected inputMode(definition: FieldDef): 'numeric' | 'decimal' | null {
    switch (definition.type) {
      case 'int':
        return 'numeric';
      case 'number':
      case 'duration':
        return 'decimal';
      default:
        return null;
    }
  }

  private optionsOf(definition: FieldDef): SelectOption[] {
    switch (definition.type) {
      case 'select':
        return (definition.values as readonly string[]).map((value) => ({
          value,
          label: this.i18n.t(optionLabelKey(definition.key, value)),
        }));
      case 'font':
        return FONT_SIZES.map((value) => ({ value, label: value.replace('-', ' × ') }));
      case 'priceList':
        return this.state
          .priceLists()
          .filter((priceList) => priceList.enabled)
          .map((priceList) => ({ value: priceList.id, label: priceList.name }));
      case 'category':
        return this.state.categories().map((item) => ({ value: item.id, label: item.name }));
      case 'template':
        return this.state.templates().map((item) => ({ value: item.id, label: item.name }));
      case 'company':
        return this.state.companies().map((item) => ({ value: item.id, label: item.name }));
      default:
        return this.state.places().map((item) => ({ value: item.id, label: item.name }));
    }
  }
}
