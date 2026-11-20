// Extension copy: apps/extension/src/lib/api.ts (what people read when the PURSS can't be reached or isn't a PURSS)
export default {
  offline: "Couldn't reach your PURSS. Check your connection, or that the PURSS is running.",
  signedOut: "This extension isn't connected to your PURSS any more. Connect it again.",
  tooLarge: "This page's text is too large to keep.",
  failed: (status: number) => `The PURSS answered with an error (${status}).`,
  notPurssOrTooOld: "There's no PURSS at that address, or it's too old for this extension.",
  notPurss: "There's no PURSS at that address.",
  otherAddress: (origin: string) => `This PURSS's address is ${origin}. Enter that address instead.`,
};
