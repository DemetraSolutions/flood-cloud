import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { FeatureName } from './feature-catalog';
import { HasFeature } from './has-feature';

@Component({ imports: [HasFeature], template: `<p *fcFeature="feature()">Magazzino</p>` })
class Host {
  readonly feature = signal<FeatureName>('warehouse');
}

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
});

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

describe('HasFeature', () => {
  it('renders the content when the group has the feature and follows changes', async () => {
    signIn({
      role: 'SA',
      groupFeatures: fakeFeatureFlags(false, { warehouse: true, media: true }),
    });
    const { fixture, root } = await render();
    expect(root.querySelector('p')).not.toBeNull();
    fixture.componentInstance.feature.set('media');
    await fixture.whenStable();
    expect(root.querySelector('p')).not.toBeNull();
    fixture.componentInstance.feature.set('cash');
    await fixture.whenStable();
    expect(root.querySelector('p')).toBeNull();
    fixture.componentInstance.feature.set('warehouse');
    await fixture.whenStable();
    expect(root.querySelector('p')).not.toBeNull();
  });

  it('renders nothing while the features are unknown', async () => {
    signIn({ role: 'CA', groupFeatures: null });
    const { root } = await render();
    expect(root.querySelector('p')).toBeNull();
  });
});
