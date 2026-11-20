// Extension copy: apps/extension/src/lib/connect.ts (what the approval page's answer means, and how a connection is named)
export default {
  unexpectedAnswer: "The PURSS sent back something unexpected. Try connecting again.",
  otherAttempt: "That answer didn't come from this connection attempt. Try connecting again.",
  declined: "You chose not to connect.",
  noCode: "The PURSS didn't send a connection code. Try connecting again.",
  deviceName: (browser: string, os: string) => `${browser} on ${os}`,
};
