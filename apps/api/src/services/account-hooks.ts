import type { App } from "../app.ts";

type Hook = (app: App, accountId: string, workspaceId: string) => void;
const hooks: Hook[] = [];

/**
 * Work another module does for every new account, inside the transaction that creates it. The module registers
 * itself when it loads, so auth/accounts.ts imports none of them: a direct import would close an import cycle
 * (accounts → news → notifications → home → items → jobs → deletion → accounts) that breaks module loading.
 */
export function onAccountCreated(hook: Hook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}

export function runAccountCreated(app: App, accountId: string, workspaceId: string): void {
  for (const hook of hooks) hook(app, accountId, workspaceId);
}
