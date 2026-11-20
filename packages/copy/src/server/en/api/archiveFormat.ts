// Server copy: apps/api/src/services/archive-format.ts
export default {
  neverExportedCredentials: "Passwords, passkeys, sign-in sessions and access tokens are never exported.",
  engineDataNotIncluded: "Service secrets and the collection engine's own data and identifiers are not included.",
  privateLinksLeftOut: "Private source links, and any link, image or media address that belongs to an item from a private source, are left out. Those sources are exported as references that need to be reconnected.",
  secretAddressesLeftOut: "Addresses that carry a password or access key are left out of item links and media.",
  temporaryDataNotExported: "Readable-text captures that were still in progress, and temporary data (undo history, pending confirmations, discovery previews, notifications), are not exported.",
  onlySavedIncluded: "Only text and links that were actually saved are included. Pages, images, audio and video that were never captured are not, and may no longer exist at their original address.",
  sharingExported: "Sharing settings and public notes are exported; importing them never shares anything.",
  defaultOrigin: "RSS feed",
  notExport: "That file isn't a PURSS export.",
  noReadableVersion: "That export file has no readable version.",
  newerVersion: "That export was made by a newer version of PURSS. Update this installation before importing it.",
  incomplete: "That export file looks incomplete: it has no integrity manifest. It may have been cut short while downloading.",
  missingSection: (name: string) => `That export file is missing its "${name}" section.`,
  damagedSection: (name: string) => `That export file looks damaged: its "${name}" section doesn't match its integrity check.`,
  unreadableDetailsAt: (path: string) => `That export file has details this version can't read (${path}).`,
  unreadableDetails: (where: string) => `That export file has details this version can't read${where}.`,
};
