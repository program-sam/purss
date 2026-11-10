/**
 * Redaction for text that may be logged or stored in job records. It is deliberately blunt:
 * credentials in URLs, query strings, authorization values, long opaque tokens and any caller-supplied
 * secret are removed. Article content never goes through this path.
 */
const MAX = 600;

export function redactText(input: string, secrets: readonly string[] = []): string {
  let text = input;
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[redacted]")
    .replace(/(Bearer|GoogleLogin\s+auth=)\s*[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(Auth|SID|LSID|Passwd|password|token|api[-_ ]?password)=\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}
