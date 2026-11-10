/**
 * Where to go after signing in: only a path on this PURSS ("/connect?…"), never another site.
 * "//host" and "/\host" are refused because browsers read them as other sites.
 */
export function safeNext(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 4000) return undefined;
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return undefined;
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return undefined;
  return v;
}
