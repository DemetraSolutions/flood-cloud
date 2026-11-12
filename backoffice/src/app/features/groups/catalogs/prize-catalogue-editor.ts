import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  applyEach,
  form,
  FormField,
  maxLength,
  ReadonlyFieldTree,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { issueMessageKey } from '../../../core/api/field-issues';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { MAX_PRIZES, Prize, PrizeCatalogue } from './catalog.types';
import { editorErrors } from './catalog-errors';
import { numberIssue, numberOrNull, numberText, textOrNull } from './catalog-fields';

/** A prize as sent: without `id` it is a new one; the image is never part of the body. */
export interface PrizeBody {
  id?: string;
  enabled: boolean;
  name: string;
  description: string | null;
  pointsValue: number | null;
  extraPrice: number | null;
  redemptionConditions: string | null;
}

/** Body of a prize catalogue write (`prizes` is always the whole new list). */
export interface PrizeCatalogueBody {
  name?: string;
  enabled?: boolean;
  prizes?: PrizeBody[];
}

/** A prize in the form: numbers as text, `id` empty for a new one. */
interface PrizeModel {
  id: string;
  enabled: boolean;
  name: string;
  description: string;
  pointsValue: string;
  extraPrice: string;
  redemptionConditions: string;
  imageSet: boolean;
}

const emptyPrize = (): PrizeModel => ({
  id: '',
  enabled: true,
  name: '',
  description: '',
  pointsValue: '',
  extraPrice: '',
  redemptionConditions: '',
  imageSet: false,
});

const prizeModel = (prize: Prize): PrizeModel => ({
  id: prize.id,
  enabled: prize.enabled,
  name: prize.name,
  description: prize.description ?? '',
  pointsValue: numberText(prize.pointsValue),
  extraPrice: numberText(prize.extraPrice),
  redemptionConditions: prize.redemptionConditions ?? '',
  imageSet: prize.imageSet,
});

/** The body of a prize of the form. */
export function prizeBody(prize: PrizeModel): PrizeBody {
  return {
    ...(prize.id === '' ? {} : { id: prize.id }),
    enabled: prize.enabled,
    name: prize.name.trim(),
    description: textOrNull(prize.description),
    pointsValue: numberOrNull(prize.pointsValue),
    extraPrice: numberOrNull(prize.extraPrice),
    redemptionConditions: textOrNull(prize.redemptionConditions),
  };
}

/**
 * Form of a prize catalogue with its prizes. On modification the prizes are sent as the whole new
 * list: a prize keeps its `id` (so its image stays), a prize removed from the form is deleted by
 * the server, a prize added has no `id`. The image of a prize cannot be changed here: the form
 * only says whether there is one.
 */
@Component({
  selector: 'fc-prize-catalogue-editor',
  imports: [Button, Checkbox, FormError, FormField, Textarea, TextField, TPipe],
  templateUrl: './prize-catalogue-editor.html',
  styleUrl: './catalog-editor.css',
})
export class PrizeCatalogueEditor {
  protected readonly i18n = inject(I18nService);

  /** The catalogue being changed; `null` to create one. */
  readonly item = input<PrizeCatalogue | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<PrizeCatalogueBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly maxPrizes = MAX_PRIZES;
  protected readonly model = linkedSignal(() => {
    const item = this.item();
    return {
      name: item?.name ?? '',
      enabled: item?.enabled ?? true,
      prizes: (item?.prizes ?? []).map(prizeModel),
    };
  });
  protected readonly catalogueForm = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, 200);
    applyEach(path.prizes, (prize) => {
      required(prize.name);
      maxLength(prize.name, 200);
      maxLength(prize.description, 1000);
      maxLength(prize.redemptionConditions, 1000);
      for (const field of [prize.pointsValue, prize.extraPrice]) {
        validate(field, ({ value }) => {
          const kind = numberIssue(value(), { min: 0, optional: true });
          return kind === undefined ? undefined : { kind };
        });
      }
    });
  });

  protected readonly full = computed(() => this.model().prizes.length >= MAX_PRIZES);
  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), ['name', 'enabled', 'prizes']),
  );

  /** Server message for a field of a prize (`prizes.<index>.<field>`) or of the list itself. */
  protected prizeMessage(index: number | null, name: string): string | null {
    const field = index === null ? 'prizes' : `prizes.${index}.${name}`;
    const detail = this.error()?.details.find((entry) => entry.field === field);
    return detail === undefined ? null : this.i18n.t(issueMessageKey(detail.issue));
  }

  protected readonly body = computed<PrizeCatalogueBody>(() => {
    const model = this.model();
    const item = this.item();
    const prizes = model.prizes.map(prizeBody);
    if (item === null) {
      return { name: model.name.trim(), enabled: model.enabled, prizes };
    }
    const body: PrizeCatalogueBody = {};
    if (model.name.trim() !== item.name) {
      body.name = model.name.trim();
    }
    if (model.enabled !== item.enabled) {
      body.enabled = model.enabled;
    }
    if (JSON.stringify(prizes) !== JSON.stringify(item.prizes.map(prizeModel).map(prizeBody))) {
      body.prizes = prizes;
    }
    return body;
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected fieldMessage(
    field: ReadonlyFieldTree<unknown>,
    index: number,
    name: string,
  ): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.prizeMessage(index, name);
  }

  protected addPrize(): void {
    this.model.update((model) => ({ ...model, prizes: [...model.prizes, emptyPrize()] }));
  }

  protected removePrize(index: number): void {
    this.model.update((model) => ({
      ...model,
      prizes: model.prizes.filter((_, position) => position !== index),
    }));
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.catalogueForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.catalogueForm),
    });
  }
}
