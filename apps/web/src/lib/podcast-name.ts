/**
 * Does the text read as the name of a show rather than an address? A name has no scheme, slash, @ or port, and no dot
 * inside a word: "football weekly", "99% Invisible", "Dr. Phil" and "Serial: Season 3" are names;
 * "quietharbour.example", "bbc.co.uk/news" and "@name@server" are not. A single word counts ("serial").
 */
export function looksLikePodcastName(input: string): boolean {
  const t = input.trim();
  if (t.length < 2 || t.length > 100) return false;
  if (/^(?:https?|ftp|file|feed|mailto|javascript|data|tel):/i.test(t) || /[/\\@]/.test(t)) return false;
  if (/\S\.\S/.test(t) || /\S:\d/.test(t)) return false;
  return /\p{L}/u.test(t);
}
