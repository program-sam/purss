export default {
  title: "Muted words",
  hint: "Items with one of these words or phrases in the title or summary are hidden from Home and lists for the time you choose. They stay in your PURSS, and search still finds them. Each list shows how many it hid.",
  until: (date: string) => `until ${date}`,
  untilRemoved: "until you remove it",
  wordLabel: "Word or phrase",
  placeholder: "for example: transfer news",
  howLong: "How long",
  forLabels: { week: "For a week", month: "For a month", forever: "Until I remove it" },
  mute: "Mute",
};
