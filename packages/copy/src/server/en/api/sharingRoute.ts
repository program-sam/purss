// Server copy: apps/api/src/routes/sharing.ts
export default {
  privateFeedLink: "This address has a key or token in it, so it looks like a private feed. A Follow button would show it to everyone; use the site's public feed address instead.",
  enterFeedAddress: "Enter a full feed address starting with https:// or http://.",
  notFoundPage: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex, nofollow\"><title>Not found</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1c2431}@media (prefers-color-scheme:dark){body{background:#181c22;color:#e8edf4}}</style></head><body><h1>Not found</h1><p>This page doesn't exist, or it isn't shared right now.</p></body></html>",
  reportTitle: (title: string) => `Report ${title}`,
  reportFormBody: (title: string, curator: string, error: string, action: string, reasons: string, details: string, contact: string, slug: string) => `<header>
<h1>Report this page</h1>
<p class="about">“${title}”, shared by ${curator}. Your report goes to the people who run this site, who can take down pages that break the law or the terms of use.</p>
</header>
<main id="main">
${error}
<form method="post" action="${action}" class="card">
<fieldset><legend>What's wrong?</legend>
${reasons}
</fieldset>
<label class="l" for="details">Tell us more</label>
<textarea id="details" name="details" rows="5" maxlength="2000" required>${details}</textarea>
<p class="hint">Which item, and why. For a copyright complaint, say which work is yours.</p>
<label class="l" for="contact">How to reach you (optional)</label>
<input type="text" id="contact" name="contact" maxlength="200" value="${contact}" autocomplete="email">
<p class="hint">Only if you'd like an answer. We keep only what you type here; the curator doesn't see it.</p>
<button class="btn primary" type="submit">Send report</button>
<a class="btn" href="/p/${slug}">Back to the page</a>
</form>
</main>`,
  reportSent: "Report sent",
  reportThanksBody: (title: string, slug: string) => `<header><h1>Thank you</h1><p class="about">Your report about “${title}” was sent. The people who run this site will look at it.</p></header>
<main id="main"><p><a class="btn" href="/p/${slug}">Back to the page</a></p></main>`,
  sendFromThisPage: "Please send your report from this page.",
};
