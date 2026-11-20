// Server copy: apps/api/src/connect/devices.ts
export default {
  accountDeleting: "This account is set to be deleted, so no app can connect to it.",
  tooManyDevices: (max: number) => `You can connect up to ${max} apps. Disconnect one you no longer use in Settings → Connected apps first.`,
  thatApp: "That app",
};
