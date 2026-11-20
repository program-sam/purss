export default {
  title: "How often do you want to hear about new items?",
  notNow: "Not now",
  save: "Save",
  suggested: " (suggested)",
  digestOff: "No digest. Sources set to “Notify me”, reminders and problem notices still show in the bell. Add browser alerts in Settings.",
  digestEmailed: (address: string | null) => `In your time zone. It arrives in the bell and by email to ${address}; turn the email off in Settings.`,
  digestBell: "In your time zone. It arrives in the bell; add browser alerts in Settings.",
  shareHint: "PURSS counts sources followed by people who share, anonymously, to suggest sources followed by people with similar taste. Other people can't see your list, and private sources never count.",
  shareSources: "Share my sources",
  keepNewFor: "Keep items marked New for",
  markerOnly: "Then only the marker goes; the items stay where they are.",
  changeAnytime: "Change either any time in Settings → Notifications and New.",
};
