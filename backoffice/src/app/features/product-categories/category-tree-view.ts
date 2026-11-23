import { Component, computed, ElementRef, inject, input, output, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { CategoryNode, nodeName } from './category.types';

/** A visible row of the tree. */
interface Row {
  readonly node: CategoryNode;
  /** Level from 1, as `aria-level` wants it. */
  readonly level: number;
  /** Number of siblings, with the category. */
  readonly size: number;
  /** Position among the siblings, from 1. */
  readonly position: number;
  /** Id of the parent; `null` for a root. */
  readonly parent: string | null;
}

/**
 * The categories as an accessible tree (`role="tree"`): one row per visible category, with the
 * level, the number of siblings and the state of a branch in ARIA attributes, one tab stop and the
 * arrow keys (Up and Down move, Right opens a branch or goes to its first child, Left closes it or
 * goes to the parent, Home and End go to the ends); Enter, Space or a click opens the category.
 */
@Component({
  selector: 'fc-category-tree-view',
  imports: [StatusBadge, TPipe],
  templateUrl: './category-tree-view.html',
  styleUrl: './category-tree-view.css',
})
export class CategoryTreeView {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);

  /** The roots of the tree. */
  readonly nodes = input.required<readonly CategoryNode[]>();
  /** Accessible name of the tree (already translated). */
  readonly label = input.required<string>();
  /** Emitted with the id of the category the user opens. */
  readonly open = output<string>();

  /** The branches the user closed (every branch starts open). */
  protected readonly closed = signal<ReadonlySet<string>>(new Set());
  /** The row with the tab stop; the first one until the user moves. */
  private readonly current = signal<string | null>(null);

  protected readonly rows = computed<Row[]>(() => {
    const closed = this.closed();
    const walk = (nodes: readonly CategoryNode[], level: number, parent: string | null): Row[] =>
      nodes.flatMap((node, index) => [
        { node, level, size: nodes.length, position: index + 1, parent },
        ...(closed.has(node.id) ? [] : walk(node.children, level + 1, node.id)),
      ]);
    return walk(this.nodes(), 1, null);
  });
  /** The row that holds the tab stop: the chosen one when it is still visible, otherwise the first. */
  protected readonly stop = computed(() => {
    const current = this.current();
    const rows = this.rows();
    return rows.some((row) => row.node.id === current) ? current : (rows[0]?.node.id ?? null);
  });

  protected text(node: CategoryNode): string {
    return nodeName(node, this.i18n.t('PRODUCT_CATEGORIES.NO_NAME'));
  }

  protected hasChildren(node: CategoryNode): boolean {
    return node.children.length > 0;
  }

  protected isOpen(node: CategoryNode): boolean {
    return !this.closed().has(node.id);
  }

  protected toggle(node: CategoryNode, event: Event): void {
    event.stopPropagation();
    this.setOpen(node, !this.isOpen(node));
    this.current.set(node.id);
  }

  protected activate(node: CategoryNode): void {
    this.current.set(node.id);
    this.open.emit(node.id);
  }

  protected onKey(event: KeyboardEvent, row: Row): void {
    const rows = this.rows();
    const index = rows.indexOf(row);
    const node = row.node;
    switch (event.key) {
      case 'ArrowDown':
        this.focusRow(rows[index + 1]?.node.id);
        break;
      case 'ArrowUp':
        this.focusRow(rows[index - 1]?.node.id);
        break;
      case 'Home':
        this.focusRow(rows[0].node.id);
        break;
      case 'End':
        this.focusRow(rows[rows.length - 1].node.id);
        break;
      case 'ArrowRight':
        if (this.hasChildren(node) && !this.isOpen(node)) {
          this.setOpen(node, true);
        } else if (this.hasChildren(node)) {
          this.focusRow(node.children[0].id);
        }
        break;
      case 'ArrowLeft':
        if (this.hasChildren(node) && this.isOpen(node)) {
          this.setOpen(node, false);
        } else if (row.parent !== null) {
          this.focusRow(row.parent);
        }
        break;
      case 'Enter':
      case ' ':
        this.activate(node);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private setOpen(node: CategoryNode, open: boolean): void {
    this.closed.update((current) => {
      const next = new Set(current);
      if (open) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }

  /** Moves the tab stop to a row and the focus with it (nothing when there is no such row). */
  private focusRow(id: string | undefined): void {
    if (id === undefined) {
      return;
    }
    this.current.set(id);
    this.host.nativeElement
      .querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
      ?.focus();
  }
}
