import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FieldTree, ReadonlyFieldTree, submit, TreeValidationResult } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { GroupContext } from '../../core/groups/group-context';
import { TPipe } from '../../core/i18n/t-pipe';
import { serverFieldErrors } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { UserAccessSection } from './user-access-section';
import { UserAction, UserActions } from './user-actions';
import { UserFormState } from './user-form-state';
import { UserPermissionsSection } from './user-permissions-section';
import { UserPosSection } from './user-pos-section';
import { UserProfileSection } from './user-profile-section';
import { UserScopeSection } from './user-scope-section';
import { UserShiftsSection } from './user-shifts-section';
import { buildCreateBody } from './user-payload';
import { userRoute } from './user.types';
import { UsersApi } from './users-api';
import { fieldAt, normalizeField, userFailureMessage } from './users-errors';
import { focusFirstError } from '../../shared/forms/form-errors';

export { USERNAME_PATTERN } from './user-form-state';

/** Sections of the form, in order; the dictionary has `USERS.SECTION.<ID>` for each. */
export type UserSection = 'profile' | 'access' | 'scope' | 'permissions' | 'pos' | 'shifts';

/**
 * Create and edit page of a user (`.../users/new`, `.../users/:userId`), for the users of a
 * group and for the platform users. The complete user is one Signal Form split in sections
 * (tabs) that share a state ({@link UserFormState}); saving sends only what changed, and a
 * creation sends the permissions and POS data only when the creator defined them. Server
 * `422`, `403` and `409` errors land on the fields and mark the sections that have them.
 */
@Component({
  selector: 'fc-user-form',
  imports: [
    Button,
    Can,
    ErrorState,
    FormError,
    RouterLink,
    StatusBadge,
    TPipe,
    UserAccessSection,
    UserActions,
    UserPermissionsSection,
    UserPosSection,
    UserProfileSection,
    UserScopeSection,
    UserShiftsSection,
  ],
  providers: [UserFormState],
  templateUrl: './user-form.html',
  styleUrl: './user-form.css',
})
export class UserForm {
  protected readonly state = inject(UserFormState);
  private readonly api = inject(UsersApi);
  private readonly groups = inject(GroupContext);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Route parameters; the group is absent in the platform area, the user when creating. */
  readonly groupId = input<string>();
  readonly userId = input<string>();

  protected readonly userForm = this.state.userForm;
  protected readonly listRoute = computed(() =>
    this.state.area().kind === 'platform' ? ['/users'] : ['/groups', this.groupId(), 'users'],
  );
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.userForm().submitting());

  private readonly requested = signal<UserSection>('profile');
  /** The section shown: the requested one while it applies, otherwise the first. */
  protected readonly section = computed(() => {
    const sections = this.state.sections() as UserSection[];
    return sections.includes(this.requested()) ? this.requested() : sections[0];
  });

  private readonly sectionFields: Record<UserSection, () => FieldTree<unknown>[]> = {
    profile: () => {
      const form = this.userForm;
      return [
        form.avatar,
        form.firstName,
        form.lastName,
        form.email,
        form.phone,
        form.language,
        form.description,
        form.hiddenInStats,
      ];
    },
    access: () => {
      const form = this.userForm;
      return [form.username, form.password, form.pin, form.role, form.status];
    },
    scope: () => [this.userForm.companyIds, this.userForm.placeIds, this.userForm.serviceIds],
    permissions: () => [this.userForm.permissions],
    pos: () => [this.userForm.pos],
    shifts: () => [this.userForm.shiftTime],
  };

  /** Errors shown in each section (server errors, and client errors once touched). */
  protected readonly errorCounts = computed(() =>
    Object.fromEntries(
      (this.state.sections() as UserSection[]).map((id) => [
        id,
        this.sectionFields[id]().reduce(
          (count, field) =>
            count +
            field()
              .errorSummary()
              .filter((error) => error.kind === 'server' || error.fieldTree().touched()).length,
          0,
        ),
      ]),
    ),
  );

  constructor() {
    this.state.attach(this.groupId, this.userId);
    // The page loaded: the group in the URL becomes the working group of the selector.
    effect(() => {
      const groupId = this.groupId();
      if (groupId !== undefined && this.state.user() !== null) {
        untracked(() => this.groups.adopt(groupId));
      }
    });
  }

  protected sectionLabel(id: string): string {
    return this.state.i18n.t(`USERS.SECTION.${id.toUpperCase()}`);
  }

  protected select(id: string): void {
    this.requested.set(id as UserSection);
  }

  protected onTabKey(event: KeyboardEvent): void {
    const sections = this.state.sections();
    const last = sections.length - 1;
    const at = sections.indexOf(this.section());
    const target = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (target !== undefined) {
      event.preventDefault();
      this.select(sections[target]);
      this.host.nativeElement.querySelector<HTMLElement>(`#user-tab-${sections[target]}`)?.focus();
    }
  }

  protected onAction(action: UserAction): void {
    if (action === 'delete') {
      void this.router.navigate(this.listRoute());
    } else {
      this.state.reload();
    }
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.userForm, {
      action: async () => {
        this.failure.set(null);
        const wasNew = this.state.isNew();
        let saved;
        try {
          saved = wasNew
            ? await this.api.create(
                this.state.area(),
                buildCreateBody(this.state.model(), this.state.writeScope()),
              )
            : await this.api.update(
                this.state.area(),
                this.state.userId() as string,
                this.state.patch(),
              );
        } catch (error) {
          return this.reject(error);
        }
        this.userForm().reset();
        this.toast.success(this.state.i18n.t(wasNew ? 'USERS.FORM.CREATED' : 'USERS.FORM.SAVED'));
        if (wasNew) {
          if (this.groupId() !== undefined) {
            // The backend accepted the creation in this group: it is a real working group.
            this.groups.adopt(this.groupId() as string);
          }
          // The record opens with the values the server applied (defaults of the role).
          await this.router.navigate(userRoute(saved));
        } else {
          this.state.apply(saved);
        }
        return undefined;
      },
      onInvalid: () => this.reveal(),
    });
  }

  /** Shows the first section that has an error and moves the focus to its first invalid field. */
  private reveal(): void {
    const first = (this.state.sections() as UserSection[]).find((id) =>
      this.sectionFields[id]().some((field) => field().errorSummary().length > 0),
    );
    // With no section found the current one stays (the computed falls back to the first).
    this.select(first as string);
    afterNextRender(() => focusFirstError(this.userForm), { injector: this.injector });
  }

  private reject(error: unknown): TreeValidationResult {
    const withFields =
      error instanceof ApiError &&
      (error.code === 'VALIDATION_ERROR' ||
        error.code === 'CONFLICT' ||
        error.code === 'FORBIDDEN') &&
      error.details.length > 0;
    if (!withFields) {
      this.failure.set(userFailureMessage(this.state.i18n, error));
      return undefined;
    }
    const normalized = new ApiError({
      status: error.status,
      code: error.code as ApiError['code'],
      message: error.message,
      requestId: error.requestId,
      details: error.details.map((detail) => ({
        field: normalizeField(detail.field),
        issue: detail.issue,
      })),
    });
    const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
    for (const { field } of normalized.details) {
      const tree = fieldAt(this.userForm, field);
      if (tree !== undefined) {
        fields[field] = tree;
      }
    }
    const mapped = serverFieldErrors(this.state.i18n, normalized, fields);
    if (mapped.unmatched) {
      this.failure.set(
        this.state.i18n.t(
          error.code === 'FORBIDDEN' ? 'USERS.FORBIDDEN_TARGET' : 'ERRORS.API.VALIDATION_ERROR',
        ),
      );
    }
    return mapped.errors;
  }
}
