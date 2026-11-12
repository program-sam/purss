import { useSearch } from "@tanstack/react-router";
import { SetupPage } from "./Setup.tsx";

/** Accept an invitation link of the form /invite?code=…&email=… (any installation). */
export function InvitePage() {
  const search = useSearch({ strict: false }) as { code?: string; email?: string };
  return <SetupPage mode="invite" initialCode={search.code ?? ""} initialEmail={search.email ?? ""} />;
}
