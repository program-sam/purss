// Server copy: apps/api/src/services/failures.ts
export default {
  delayedTooMuch: "New items are delayed: the collection engine is being asked for too much at once. Everything you have is still here, and we'll keep trying.",
  delayedNotResponding: "New items are delayed: the collection engine isn't responding. Everything you have is still here, and we'll keep trying.",
  heldBackNotSaved: "New items are held back: an update from one of your sources couldn't be saved. Everything you have is still here, and we'll keep trying.",
  heldBackUnknown: "New items are held back by a problem we couldn't work out. Everything you have is still here. We'll keep trying, a little less often each time; if it lasts, the person running this PURSS can check the worker log.",
  siteLimiting: "The site is limiting requests; we'll keep trying.",
  siteNotAnswering: "The site isn't answering right now; we'll keep trying.",
  siteKeptLimiting: "The site kept limiting requests, so we stopped trying for now. Try again later.",
  siteDidNotAnswer: "The site didn't answer, so this source couldn't be set up. Try again later.",
  noFeedAnyMore: "There's no feed at that address any more. Check the link and add it again.",
  siteRefused: "The site refused the request. Check that the link is public and still works.",
  notAFeed: "The address answers, but not with a feed we can read. It may be in a format we don't support.",
  couldNotFollow: "The collection engine couldn't follow this feed. Try again later or check the link.",
  pageNotCaptured: "The page couldn't be captured. Its details and feed content are still kept.",
};
