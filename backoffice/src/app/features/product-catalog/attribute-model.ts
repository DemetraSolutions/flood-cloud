import { Attribute, AttributeGroup, LocalizedText } from './product-catalog.types';

/** One attribute in the form: the id is empty for one not saved yet (the server gives it one). */
export interface AttributeRow {
  id: string;
  /** The name for each language of the form (`''` for none). */
  name: Record<string, string>;
}

/** What the form of a group of attributes edits. */
export interface AttributesModel {
  attributes: AttributeRow[];
}

/** The texts a user filled in, trimmed. */
export function filledTexts(texts: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(texts)
      .map(([code, text]) => [code, text.trim()] as const)
      .filter(([, text]) => text !== ''),
  );
}

/** Every language of the form with its text (`''` where there is none). */
export function allLanguages(
  texts: LocalizedText,
  languages: readonly string[],
): Record<string, string> {
  return Object.fromEntries(languages.map((code) => [code, texts[code] ?? '']));
}

/** The languages of the form for a group of attributes: the ones of the group and the ones its attributes already use. */
export function attributeLanguages(
  group: AttributeGroup,
  groupLanguages: readonly string[],
): string[] {
  return [
    ...new Set([...groupLanguages, ...group.attributes.flatMap((a) => Object.keys(a.name))]),
  ];
}

/** The form model of a group of attributes. */
export function toAttributesModel(
  group: AttributeGroup,
  languages: readonly string[],
): AttributesModel {
  return {
    attributes: group.attributes.map((attribute) => ({
      id: attribute.id,
      name: allLanguages(attribute.name, languages),
    })),
  };
}

function sameTexts(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  const left = filledTexts(a);
  const right = filledTexts(b);
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** Whether the attributes of the form differ from the saved ones (an addition, a removal, a rename, a reorder). */
export function attributesChanged(
  model: AttributesModel,
  saved: readonly Attribute[],
): boolean {
  return (
    model.attributes.length !== saved.length ||
    model.attributes.some(
      (row, index) => row.id !== saved[index].id || !sameTexts(row.name, saved[index].name),
    )
  );
}

/**
 * The body of the save: the whole list (an attribute without `id` is a new one; one that is
 * missing is deleted).
 */
export function attributesBody(model: AttributesModel): { attributes: object[] } {
  return {
    attributes: model.attributes.map((row) => ({
      ...(row.id === '' ? {} : { id: row.id }),
      name: filledTexts(row.name),
    })),
  };
}
