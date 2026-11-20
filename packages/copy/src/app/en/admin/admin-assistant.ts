export default {
  accessName: "assistant access",
  intro: (signIn: string) => `Lets people connect an AI assistant (through MCP) to their own PURSS, using tokens they make in Settings → Assistants${signIn}. Off by default. An assistant only reaches the PURSS of the person who connected it, never administration.`,
  orSigningIn: ", or by signing in from assistants such as Claude and ChatGPT",
  switchHint: "Turning it off stops every token and connected assistant at once; they are kept and work again when it's turned back on.",
  switchLabel: "Allow assistant access on this installation",
  account: "account",
  token: "token",
  connectedAssistant: "connected assistant",
  usage: (accounts: string, tokens: string, assistants: string | null) => `${accounts} turned it on · ${tokens}${assistants !== null ? ` · ${assistants}` : ""}.`,
};
