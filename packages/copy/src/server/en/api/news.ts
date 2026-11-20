// Server copy: apps/api/src/services/news.ts
export default {
  thatPost: "That post",
  pageBody: (title: string, name: string, feed: string, posts: string) => `<header><h1>${title}</h1>
<p class="about">What's new on this ${name}. Every PURSS here follows it; any feed reader can too.</p>
<p class="acts"><a class="btn sm feed" href="${feed}">Atom feed</a></p></header>
<main>${posts}</main>`,
  noNewsYet: "<p class=\"empty\">No news yet.</p>",
};
