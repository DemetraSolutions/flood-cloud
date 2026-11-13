import { SelectOption } from '../../shared/ui/select/select';

/**
 * The options of a select with the stored value always among them, so that a value the list
 * does not have (another dealer's hub, a legacy province) is shown and kept instead of being
 * silently replaced by an empty choice.
 *
 * @param options The options the lists offer.
 * @param current The stored value (`''` for none).
 * @param label Label of the stored value when it is not among the options.
 */
export function withCurrent(
  options: readonly SelectOption[],
  current: string,
  label: (value: string) => string,
): SelectOption[] {
  return current === '' || options.some((option) => option.value === current)
    ? [...options]
    : [...options, { value: current, label: label(current) }];
}
