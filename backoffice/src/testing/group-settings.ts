import { Provider, signal, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GroupFeatures } from '../app/core/groups/group-features';
import { I18nService } from '../app/core/i18n/i18n.service';
import { Profile } from '../app/core/session/session.types';
import { Group } from '../app/features/groups/group.types';
import { GroupSettings } from '../app/features/groups/group-settings';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, provideApiTesting, settle } from './api';
import { errorOf, findControl } from './forms';
import { fakeGroup } from './groups';
import { signIn } from './session';

/** Permissions of a platform administrator who manages groups. */
export const GROUP_ADMIN_PERMISSIONS = ['groups:read', 'groups:update'];

/**
 * Mounts a section of the group record (a child route of the real layout) for the group
 * `fakeGroup().id`, answers the `GET` of the group and returns helpers to drive the section.
 * `GroupFeatures` is replaced by a spy (`refresh`), so no request is made to read the features.
 */
export async function renderGroupSection(
  section: Type<unknown>,
  options: {
    profile?: Partial<Profile>;
    group?: Group;
    providers?: Provider[];
  } = {},
) {
  const group = options.group === undefined ? fakeGroup() : options.group;
  const url = `${API}/v1/groups/${fakeGroup().id}`;
  const refresh = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: GroupFeatures, useValue: { refresh } },
      ...(options.providers ?? []),
      provideRouter(
        [
          {
            path: 'groups/:groupId/settings',
            component: GroupSettings,
            children: [{ path: '', component: section }],
          },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    role: 'PSA',
    groupId: null,
    permissions: GROUP_ADMIN_PERMISSIONS,
    ...options.profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${fakeGroup().id}/settings`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const load = async (loaded: Group = group) => {
    backend().expectOne(url).flush({ data: loaded });
    await view();
  };
  const control = (label: string) => findControl(scope, label);
  const type = async (label: string, value: string) => {
    const field = control(label);
    field.value = value;
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const box = (label: string) => control(label) as HTMLInputElement;
  const toggle = async (label: string, checked: boolean) => {
    const field = box(label);
    field.checked = checked;
    field.dispatchEvent(new Event('change'));
    await view();
  };
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => root.querySelector<HTMLButtonElement>('button[type=submit]');
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.message);
  return {
    root,
    url,
    refresh,
    view,
    load,
    control,
    box,
    type,
    toggle,
    submit,
    save,
    toasts,
    error: (label: string) => errorOf(scope, label),
    formError: () => root.querySelector('fc-form-error')?.textContent?.trim() ?? null,
  };
}

/** A stand-in for the state of the record with a writable group, to reach states the layout never shows. */
export function fakeSettingsState(group: Group | null = null) {
  return {
    group: signal<Group | null>(group),
    groupId: signal<string | null>(group?.id ?? null),
    canUpdate: signal(true),
    canManage: signal(true),
    canDemo: signal(true),
    canPublicApi: signal(true),
    apply: vi.fn(),
    reload: vi.fn(),
    adopt: vi.fn(),
  };
}
