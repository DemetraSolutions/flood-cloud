import { RecordGroup } from '../groups/record-group';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
  untracked,
} from '@angular/core';
import {
  disabled,
  form,
  FormField,
  maxLength,
  ReadonlyFieldTree,
  required,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { Textarea } from '../../shared/ui/textarea/textarea';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { hasFieldDetails, isStale } from '../companies/company-errors';
import { apiErrorOf } from '../profile/sessions';
import { EmailPreview } from './email-preview';
import { EmailTemplatesApi } from './email-templates-api';
import {
  EmailTemplateBody,
  hasBodyControl,
  hasNameControl,
  TEMPLATE_LIMITS,
  templateRoute,
  utf8Length,
  VersionedTemplate,
} from './email-template.types';
import { TEMPLATE_MODELS, TemplateModels } from './template-models';

/** The form of a template. */
interface TemplateModel {
  name: string;
  text: string;
  html: string;
}

const EMPTY: TemplateModel = { name: '', text: '', html: '' };

/** Placeholders the sender of the e-mails replaces (`doc/API.md`), shown as a reminder next to the editor. */
export const PLACEHOLDERS = [
  '%placeName%',
  '%placeTelephone%',
  '%name%',
  '%surname%',
  '%date%',
  '%hours%',
  '%pax%',
  '%notes%',
  '%status%',
  '%contactEmail%',
  '%contactTelephone%',
  '%startDate%',
  '%endDate%',
] as const;

/**
 * One e-mail template of a group (`/groups/:groupId/email-templates/:templateId`, or `new`): the
 * name, the plain text and the HTML in plain text areas, with the preview of the HTML in an
 * isolated frame next to them. A new template can start from one of the models of the legacy
 * backoffice. A modification presents the version read in `If-Match` (`412` asks to reload); the
 * creation presents an `Idempotency-Key`. Without `places:update` the page is read only.
 */
@Component({
  selector: 'fc-email-template-page',
  imports: [
    RecordGroup,
    Button,
    ConfirmDialog,
    EmailPreview,
    ErrorState,
    FormError,
    FormField,
    RouterLink,
    Select,
    TextField,
    Textarea,
    TPipe,
  ],
  templateUrl: './email-template-page.html',
  styleUrl: './email-template-page.css',
})
export class EmailTemplatePage {
  private readonly api = inject(EmailTemplatesApi);
  private readonly models = inject(TemplateModels);
  private readonly session = inject(SessionService);
  private readonly features = inject(GroupFeatures);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route parameters (bound by the router); no `templateId` on the page of a new template. */
  readonly groupId = input.required<string>();
  readonly templateId = input<string>();

  protected readonly isNew = computed(() => this.templateId() === undefined);
  protected readonly canWrite = computed(() => this.session.can('places:update'));
  protected readonly listRoute = computed(() => templateRoute(this.groupId()));

  private readonly loaded = resource({
    params: () => {
      const templateId = this.templateId();
      return templateId === undefined ? undefined : { groupId: this.groupId(), templateId };
    },
    loader: ({ params }) => this.api.read(params.groupId, params.templateId),
  });
  /** The template as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<VersionedTemplate | undefined, VersionedTemplate | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly template = computed(() => this.saved()?.template ?? null);
  protected readonly loading = computed(() => !this.isNew() && this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly model = linkedSignal<TemplateModel>(() => {
    const template = this.template();
    return template === null
      ? { ...EMPTY }
      : { name: template.name, text: template.text, html: template.html };
  });
  protected readonly templateForm = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, TEMPLATE_LIMITS.name);
    validate(path.name, ({ value }) => {
      if (value().trim() === '') {
        return { kind: 'required' };
      }
      return hasNameControl(value()) ? { kind: 'pattern' } : undefined;
    });
    validate(path.text, ({ value }) => bodyIssue(value(), TEMPLATE_LIMITS.textBytes));
    validate(path.html, ({ value }) => bodyIssue(value(), TEMPLATE_LIMITS.htmlBytes));
    disabled(path, () => !this.canWrite());
  });

  /** What differs from the saved template (everything typed, for a new one). */
  protected readonly body = computed<EmailTemplateBody>(() => {
    const model = this.model();
    const saved = this.template();
    const body: EmailTemplateBody = {};
    for (const field of ['name', 'text', 'html'] as const) {
      const value = field === 'name' ? model.name.trim() : model[field];
      if (saved === null || value !== saved[field]) {
        body[field] = value;
      }
    }
    return body;
  });
  protected readonly hasChanges = computed(() => Object.keys(this.body()).length > 0);
  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one (`412`): the page offers to read again. */
  protected readonly stale = signal(false);
  protected readonly submitting = computed(() => this.templateForm().submitting());

  // The models a new template can start from, the ones the group has the features for.
  protected readonly modelOptions = computed(() =>
    TEMPLATE_MODELS.filter(
      (model) => model.feature === null || this.features.enabledFor(this.groupId(), model.feature),
    ).map((model) => ({ value: model.id, label: this.i18n.t(model.labelKey) })),
  );
  protected readonly modelChoice = signal('');
  protected readonly modelBusy = signal(false);
  protected readonly modelAsk = signal(false);
  private pendingModel: string | null = null;

  protected readonly placeholders = PLACEHOLDERS;
  protected readonly previewLabel = computed(() => this.i18n.t('EMAIL_TEMPLATES.PREVIEW.LABEL'));

  // Leaving with unsaved changes.
  protected readonly leaveOpen = signal(false);
  private pendingLeave: ((leave: boolean) => void) | null = null;

  constructor() {
    // Platform administrators and dealers: the features of the group decide which models exist.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.features.ensure(groupId));
    });
  }

  /**
   * Asked by the route guard when the user leaves the page: immediate when nothing is unsaved,
   * otherwise the user confirms in a dialog.
   *
   * @returns `true` to leave, `false` to stay.
   */
  confirmLeave(): boolean | Promise<boolean> {
    if (!this.canWrite() || !this.hasChanges()) {
      return true;
    }
    this.leaveOpen.set(true);
    return new Promise<boolean>((resolve) => {
      this.pendingLeave = resolve;
    });
  }

  protected onLeave(): void {
    this.settle(true);
    this.leaveOpen.set(false);
  }

  /** The dialog was closed without confirming: stay. */
  protected onLeaveClosed(): void {
    this.leaveOpen.set(false);
    this.settle(false);
  }

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected date(value: string | null): string {
    return value === null
      ? ''
      : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  }

  protected reload(): void {
    this.stale.set(false);
    this.failure.set(null);
    this.loaded.reload();
  }

  /** A model was chosen: it replaces what is typed, after asking when something is. */
  protected onModel(id: string): void {
    this.modelChoice.set(id);
    if (id === '') {
      return;
    }
    if (this.touched()) {
      this.pendingModel = id;
      this.modelAsk.set(true);
    } else {
      void this.applyModel(id);
    }
  }

  protected onModelConfirmed(): void {
    const id = this.pendingModel as string;
    this.modelAsk.set(false);
    this.pendingModel = null;
    void this.applyModel(id);
  }

  protected onModelDismissed(): void {
    this.modelAsk.set(false);
    this.pendingModel = null;
    this.modelChoice.set('');
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.templateForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const wasNew = this.isNew();
        let result: VersionedTemplate;
        try {
          result = wasNew
            ? await this.api.create(this.groupId(), this.body(), this.key.forBody(this.body()))
            : await this.api.update(
                this.groupId(),
                this.templateId() as string,
                this.body(),
                (this.saved() as VersionedTemplate).etag,
              );
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.saved.set(result);
        this.toast.success(
          this.i18n.t(wasNew ? 'EMAIL_TEMPLATES.FORM.CREATED' : 'EMAIL_TEMPLATES.FORM.SAVED'),
        );
        if (wasNew) {
          await this.router.navigate(templateRoute(this.groupId(), result.template.id));
        }
        return undefined;
      },
      onInvalid: () => focusFirstError(this.templateForm),
    });
  }

  /** Whether the user typed something of their own (a model alone does not count as typed). */
  private touched(): boolean {
    return this.model().name.trim() !== '' || this.model().text !== '' || this.model().html !== '';
  }

  private async applyModel(id: string): Promise<void> {
    const model = TEMPLATE_MODELS.find((candidate) => candidate.id === id);
    if (model === undefined) {
      return;
    }
    this.modelBusy.set(true);
    try {
      const content = await this.models.content(model);
      this.model.set({ name: this.i18n.t(model.labelKey), text: content.text, html: content.html });
    } catch (error) {
      this.failure.set(failureMessage(this.i18n, error));
    } finally {
      this.modelBusy.set(false);
    }
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('EMAIL_TEMPLATES.FORM.STALE'));
      return undefined;
    }
    if (hasFieldDetails(error) && error.code === 'VALIDATION_ERROR') {
      const f = this.templateForm;
      const mapped = serverFieldErrors(this.i18n, error, {
        name: f.name,
        text: f.text,
        html: f.html,
      });
      if (mapped.unmatched) {
        this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      return mapped.errors;
    }
    this.failure.set(failureMessage(this.i18n, error));
    return undefined;
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}

/** The problem of a text or of an HTML, if any: more bytes than the server takes, or a control character it refuses. */
function bodyIssue(value: string, bytes: number): { kind: string } | undefined {
  if (value.length > bytes || utf8Length(value) > bytes) {
    return { kind: 'maxLength' };
  }
  return hasBodyControl(value) ? { kind: 'pattern' } : undefined;
}
