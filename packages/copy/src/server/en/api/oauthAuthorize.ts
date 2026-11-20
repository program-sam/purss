// Server copy: apps/api/src/oauth/authorize.ts
export default {
  oauthOff: "This PURSS doesn't let assistants connect with a sign-in page. Use a personal access token from Settings → Assistants instead.",
  noClientId: "This sign-in link doesn't say which assistant is asking (no client_id).",
  redirectNotListed: (host: string) => `This sign-in link would send you to an address that ${host} doesn't list as its own, so it was stopped.`,
  requestInvalid: "The assistant's request isn't valid.",
  signInKindNotOffered: "The assistant asked for a kind of sign-in this PURSS doesn't offer.",
  notSecureEnough: "The assistant's request isn't secure enough (it needs PKCE with S256).",
  otherResource: "The assistant asked for access to something other than this PURSS.",
  repeatedParameter: (name: string) => `This sign-in link gives “${name}” more than once, so it can't be trusted. Start connecting again from the assistant.`,
  readOnlyRequest: "The assistant only asked to read. It can't be allowed more than it asked for.",
  tooManyAssistants: (max: number) => `You can connect up to ${max} assistants. Disconnect one you no longer use in Settings → Assistants first.`,
};
