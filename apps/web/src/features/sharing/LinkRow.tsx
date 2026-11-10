import { CopyButton } from "../shared/bits.tsx";

/** One public address with a copy button. */
export function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="fx-link">
      <span className="fx-link-l">{label}</span>
      <code className="fx-url">{url}</code>
      <CopyButton value={url} what={`${label} link`} />
    </div>
  );
}
