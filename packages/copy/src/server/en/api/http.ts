// Server copy: apps/api/src/http.ts
export default {
  that: "That",
  notFound: (what: string) => `${what} doesn't exist or isn't yours.`,
  uploadStalled: "The upload stopped or was too slow. Please try again.",
  busy: "PURSS is busy. Please try again in a moment.",
  notJson: "The request body isn't valid JSON.",
  uploadNotStored: "PURSS couldn't store the upload. Please try again later.",
  invalidDetails: (where: string) => `Some details aren't valid${where}.`,
  tooManyAttempts: "Too many attempts. Please wait a few minutes and try again.",
};
