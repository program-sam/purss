// Server copy: apps/api/src/auth/passwords.ts
export default {
  tooShort: (min: number) => `Use at least ${min} characters for the password.`,
  tooLong: (max: number) => `Use at most ${max} characters for the password.`,
  sameAsEmail: "The password can't be the same as your email address.",
};
