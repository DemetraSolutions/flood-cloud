import { Component, inject, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { focusRow, indexAfterRemoval } from './contact-list-focus';

@Component({
  template: `
    <ul class="rows">
      @for (row of rows(); track row) {
        <li>
          @if (row === 'text') {
            <p>{{ row }}</p>
          } @else {
            <input [value]="row" />
          }
          <button type="button">x</button>
        </li>
      }
    </ul>
    <div class="actions"><button type="button" id="add">add</button></div>
  `,
})
class Host {
  readonly injector = inject(Injector);
  readonly rows = signal(['a', 'b']);
}

async function render(rows: string[]) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.rows.set(rows);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const focus = async (index: number) => {
    focusRow(fixture.componentInstance.injector, root, index);
    fixture.componentRef.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { root, focus };
}

afterEach(() => document.body.replaceChildren());

describe('focusRow', () => {
  it('focuses the first input of the row', async () => {
    const { root, focus } = await render(['a', 'b']);
    await focus(1);
    expect(document.activeElement).toBe(root.querySelectorAll('input')[1]);
  });

  it('focuses the first button of a row that has no input', async () => {
    const { root, focus } = await render(['text']);
    await focus(0);
    expect(document.activeElement).toBe(root.querySelector('ul button'));
  });

  it.each([-1, 5])('focuses the button that adds a row when there is no row %i', async (index) => {
    const { root, focus } = await render(['a']);
    await focus(index);
    expect(document.activeElement).toBe(root.querySelector('#add'));
  });

  it('does nothing when there is neither a row nor an add button', async () => {
    const fixture = TestBed.createComponent(Host);
    const element = document.createElement('div');
    document.body.appendChild(element);
    focusRow(fixture.componentInstance.injector, element, 0);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('indexAfterRemoval', () => {
  it('is the next row, else the previous one, else none', () => {
    expect(indexAfterRemoval(0, 3)).toBe(0);
    expect(indexAfterRemoval(1, 3)).toBe(1);
    expect(indexAfterRemoval(3, 3)).toBe(2);
    expect(indexAfterRemoval(0, 0)).toBe(-1);
  });
});
