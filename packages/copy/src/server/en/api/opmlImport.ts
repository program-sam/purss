// Server copy: apps/api/src/services/opml-import.ts
export default {
  thatImport: "That import",
  listAlreadyRunning: "A list is already being followed. Wait for it to finish, or stop it first.",
  nameNewCollection: "Name the new collection first.",
  noWebAddress: "None of those feeds has a web address to follow.",
  listTooLong: "That list is too long to follow at once.",
  stopListFirst: "Stop the list first.",
  notPutIn: (name: string) => `Not put in “${name}”: a filter collection has that name.`,
  privateLinkGone: "This feed's private link is no longer here. Import the list again.",
  couldNotFollow: "That address couldn't be followed.",
  moreThanOneFeed: "More than one feed was found there. Add it from Add source to choose the right one.",
  noFeedFound: "No feed was found at that address.",
  wentWrongFollowing: "Something went wrong while following this feed.",
};
