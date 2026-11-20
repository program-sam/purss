// Server copy: apps/api/src/services/plans.ts
export default {
  plusAllowsMore: " Plus allows more.",
  proAllowsMore: " Pro allows more.",
  sourcesLimit: (limit: string, more: string) => `Your plan allows ${limit} sources. Unfollow one to follow another.${more}`,
  collectionsLimit: (limit: string, more: string) => `Your plan allows ${limit} collections. Remove one to add another.${more}`,
};
