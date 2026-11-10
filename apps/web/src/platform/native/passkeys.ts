import { CapacitorPasskey } from "@capgo/capacitor-passkey";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import type { Passkeys } from "../types.ts";

/**
 * The phone's own passkeys (Credential Manager on Android, AuthenticationServices on iOS), for a PURSS that
 * vouches for this app (plan/31). PURSS's WebAuthn options go to the system as they are; its answer is the
 * same JSON a browser gives. A refusal keeps the WebAuthn error name, so the messages are the browser's.
 */
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  try {
    return (await run()) as T;
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string };
    const named = new Error(e.message ?? "The passkey didn't work.");
    named.name = e.code ?? e.name ?? "UnknownError";
    throw named;
  }
}

export const nativePasskeys: Passkeys = {
  create: (options: PublicKeyCredentialCreationOptionsJSON) => call<RegistrationResponseJSON>(() => CapacitorPasskey.createCredential({ publicKey: options as never })),
  get: (options: PublicKeyCredentialRequestOptionsJSON) => call<AuthenticationResponseJSON>(() => CapacitorPasskey.getCredential({ publicKey: options as never })),
};
