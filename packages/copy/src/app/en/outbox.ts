// App copy: apps/web/src/outbox
export default {
  signOutDialog: {
    title: "Some changes haven't been sent",
    stay: "Stay signed in",
    discard: "Discard them",
    sending: "Sending…",
    sendFirst: "Send them first",
    change: "change",
    waiting: (changes: string, is: string) => `${changes} you made ${is} still waiting to be sent to PURSS. They are kept on this device, so you can send them first or throw them away.`,
    is: "is",
    are: "are",
    failed: "They couldn't be sent just now; PURSS can't be reached. You can stay signed in and try again later, or discard them.",
    note: "Discarded changes are gone for good. Nothing already saved in PURSS is touched.",
  },
  messages: {
    sentOne: "Sent a change that was waiting.",
    sentMany: (changes: string) => `Sent ${changes} that were waiting.`,
    change: "change",
    conflicts: (count: number) => `Not changed: ${count} items were changed on another device.`,
    notApplied: (changes: string) => `Not changed: ${changes} couldn't be applied.`,
  },
  entries: {
    conflict: "Not changed: this item was changed on another device.",
    rejected: (detail: string) => `Not changed. ${detail}`,
    couldntApply: "Not changed. PURSS couldn't apply it.",
  },
};
