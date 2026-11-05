/** Sort direction of a table column. */
export type SortDirection = 'asc' | 'desc';

/** Current sort of a table: the column key and the direction. */
export interface TableSort {
  readonly key: string;
  readonly direction: SortDirection;
}

/** Declarative description of a table column. */
export interface TableColumn<T> {
  /** Unique key; also the sort key sent to the backend. */
  readonly key: string;
  /** Header text (already translated). */
  readonly header: string;
  /** Plain-text cell value; omit when a `fcCell` template renders the column. */
  readonly cell?: (row: T) => string;
  /** Adds a sort button to the header. */
  readonly sortable?: boolean;
  /** Shrinks the column to its content (checkbox and similar narrow columns). */
  readonly narrow?: boolean;
  /** Hides the column when the table container is narrow (it stays available elsewhere). */
  readonly hideNarrow?: boolean;
  /** Text alignment; numbers and amounts should use `end`. */
  readonly align?: 'start' | 'end';
}
