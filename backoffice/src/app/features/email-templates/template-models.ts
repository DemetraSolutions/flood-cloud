import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FeatureName } from '../../core/groups/feature-catalog';

/** A model the user can start a new template from (the ones of the legacy backoffice). */
export interface TemplateModel {
  /** File name, without extension, of the model in `public/email-templates`. */
  readonly id: string;
  /** Dictionary key of the name the template gets (and of the label of the choice). */
  readonly labelKey: string;
  /** Feature the group must have for the model to be offered, `null` for none. */
  readonly feature: FeatureName | null;
}

/** The seven models: the advanced report, five for the reservations of the tables and one for the appointments. */
export const TEMPLATE_MODELS: readonly TemplateModel[] = Object.freeze([
  { id: 'advanced-report', labelKey: 'EMAIL_TEMPLATES.MODEL.ADVANCED_REPORT', feature: null },
  {
    id: 'table-reservation-notification',
    labelKey: 'EMAIL_TEMPLATES.MODEL.TABLE_RESERVATION_NOTIFICATION',
    feature: 'rooms',
  },
  {
    id: 'table-reservation-received',
    labelKey: 'EMAIL_TEMPLATES.MODEL.TABLE_RESERVATION_RECEIVED',
    feature: 'rooms',
  },
  {
    id: 'table-reservation-confirmed-status',
    labelKey: 'EMAIL_TEMPLATES.MODEL.TABLE_RESERVATION_CONFIRMED_STATUS',
    feature: 'rooms',
  },
  {
    id: 'table-reservation-refused-status',
    labelKey: 'EMAIL_TEMPLATES.MODEL.TABLE_RESERVATION_REFUSED_STATUS',
    feature: 'rooms',
  },
  {
    id: 'table-reservation-change-status',
    labelKey: 'EMAIL_TEMPLATES.MODEL.TABLE_RESERVATION_CHANGE_STATUS',
    feature: 'rooms',
  },
  {
    id: 'appointment-confirmed',
    labelKey: 'EMAIL_TEMPLATES.MODEL.APPOINTMENT_CONFIRMED',
    feature: 'services',
  },
]);

/** The content of a model. */
export interface ModelContent {
  readonly text: string;
  readonly html: string;
}

/** Reads the static files of the models (same origin, `public/email-templates`). */
@Service()
export class TemplateModels {
  private readonly http = inject(HttpClient);

  /**
   * Reads the text and the HTML of a model.
   *
   * @param model The model.
   */
  async content(model: TemplateModel): Promise<ModelContent> {
    const [text, html] = await Promise.all(
      ['txt', 'html'].map((extension) =>
        firstValueFrom(
          this.http.get(`/email-templates/${model.id}.${extension}`, { responseType: 'text' }),
        ),
      ),
    );
    return { text, html };
  }
}
