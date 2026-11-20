// Server copy: apps/api/src/services/account-email.ts
export default {
  notAnEmail: "That doesn't look like an email address.",
  emailUnavailable: "Email isn't available yet.",
  emailTakenByAnother: "Another account already uses this email address.",
  linkSpent: "That link has expired or was already used.",
  linkSpentSettings: (spent: string) => `${spent} Send a new one from Settings → Security.`,
  noPasswordToReset: "That account has no password to reset.",
  linkSpentSignIn: (spent: string) => `${spent} Ask for a new one on the sign-in page.`,
};
