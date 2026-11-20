// Server copy: apps/api/src/auth/accounts.ts
export default {
  emailInUseSignInOrReset: "An account with this email address already exists. Sign in instead, or reset its password.",
  passwordChangedElsewhere: "Your password was just changed somewhere else. Please try again.",
  alreadySetUp: "This installation is already set up. Please sign in.",
  badSetupCode: "That setup code isn't right. It's in the data/secrets/setup-code file on the server.",
  emailInUse: "An account with this email address already exists.",
  invitationInvalid: "That invitation isn't valid or has expired.",
  invitationOtherEmail: "This invitation is for a different email address. Use the address it was sent to.",
  signupsFull: "New accounts are full for now.",
  tooManyAccountAttempts: "Too many account attempts.",
  emailInUseConnectProvider: (label: string) => `An account with this email address already exists. Sign in with your email address and password, then connect ${label} in Settings → Security.`,
};
