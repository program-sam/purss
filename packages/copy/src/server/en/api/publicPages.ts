// Server copy: apps/api/src/services/public-pages.ts
export default {
  followTitle: (name: string) => `Follow ${name}`,
  followBody: (name: string, shared: string, product: string, feed: string, add: string, newHere: string) => `<header>
<h1>Follow ${name}</h1>
${shared}<p class="about">Get its new posts in your ${product}, next to everything else you follow. You see a preview before anything is followed.</p>
</header>
<main id="main">
<div class="card">
<p style="margin:0"><b>The feed:</b> <code>${feed}</code></p>
<div class="acts"><a class="btn primary" href="${add}">Follow in my PURSS</a></div>
<p class="hint">You sign in first if you aren't already.</p>
</div>
<div class="card">
<p style="margin:0"><b>Use another feed reader, or a PURSS somewhere else?</b> Copy the feed address above and paste it into that reader's “add” or “subscribe” box.</p>
${newHere}
</div>
</main>`,
  sharedBy: (by: string) => `<p class="by">Shared by ${by}</p>\n`,
  newToProduct: (product: string, home: string) => `<p style="margin:.6rem 0 0">New to this? ${product} is a calm place to follow blogs, news, YouTube channels and podcasts, without an algorithm. <a href="${home}">See how it works</a>.</p>`,
  followErrorTitle: "This follow link doesn't work",
  followErrorBody: "<header><h1>This follow link doesn't work</h1></header><main id=\"main\"><p>It should carry a web address starting with http:// or https://. Ask whoever made the link to check it.</p></main>",
};
