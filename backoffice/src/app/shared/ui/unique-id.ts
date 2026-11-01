let counter = 0;

/**
 * Generates a document-unique element id, used to link labels, hints and errors to controls.
 *
 * @param prefix Readable prefix, e.g. `fc-field`.
 */
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
