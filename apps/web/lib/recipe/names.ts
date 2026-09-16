/**
 * A list of names, without a line that runs off the control it sits in:
 * "A", "A and B", "A, B and 2 more". The share dialogs name a selection of
 * recipes with it and the header's Share button names the people.
 */
export function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ")
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`
}
