// Server copy: apps/api/src/services/assistant.ts
export default {
  notAvailableYet: "Assistant access isn't available yet.",
  administratorNotEnabled: "Your administrator hasn't turned on assistant access for this PURSS.",
  tooManyTokens: (max: number) => `You can have up to ${max} tokens. Revoke one you no longer use first.`,
  thatToken: "That token",
  thatAssistant: "That assistant",
};
