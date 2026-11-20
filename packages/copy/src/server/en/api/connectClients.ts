// Server copy: apps/api/src/connect/clients.ts
export default {
  appOnThisDevice: "The PURSS app on this device",
  chromiumExtension: (id: string | undefined) => `Extension ${id} in Chrome, Edge or another Chromium browser`,
  firefoxExtension: (id: string) => `Extension ${id}… in Firefox`,
  defaultDeviceMobile: "Phone, tablet or computer",
  defaultDeviceExtension: "Browser extension",
};
