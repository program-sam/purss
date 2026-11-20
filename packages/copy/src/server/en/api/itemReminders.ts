// Server copy: apps/api/src/services/item-reminders.ts
export default {
  keepFirst: "Keep this item in a basket first. A reminder is for something you kept.",
  notADate: "That isn't a date.",
  pickToday: "Pick today or a day to come.",
  pickWithin: (years: number) => `Pick a day within ${years} years.`,
  reminderTitle: (title: string) => `Reminder: ${title}`,
};
