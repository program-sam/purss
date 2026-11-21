/** The letters on a source's avatar when it has no icon: the first letters of its title's first two words. */
export function initialsFor(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
