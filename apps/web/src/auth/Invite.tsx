import { useSearch } from "@tanstack/react-router";
import { SetupPage } from "./Setup.tsx";

/** Accept an invitation link of the form /invite?code=… (any installation). */
export function InvitePage() {
  const search = useSearch({ strict: false }) as { code?: string };
  return <SetupPage mode="invite" initialCode={search.code ?? ""} />;
}

/** Hosted installations with open sign-up: create an account without a code. */
export function SignupPage() {
  return <SetupPage mode="signup" />;
}
