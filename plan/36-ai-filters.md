# Smart filters

## Direction

The owner approved optional Smart filtering for sources that flood a list and for curating
collections whose content is hard to judge by words alone. A filter is never on by default. A
person describes which posts to keep (and, optionally, which to drop), tries the words on the
latest 20 posts, and turns the filter on. [Jev](https://docs.typesafe.ai), TypeSafe AI's
decision model, judges each new post. It answers yes or no, as a probability, and does not
generate text. Jev is closed-weight and runs only at TypeSafe.

This keeps the promise in [01 Product](01-product.md): no mandatory AI service, and rules the
person chooses.

## Behaviour

- **Scope.** A filter belongs to one source (all its posts, wherever they are listed) or to one
  collection that groups sources (every source in it). A post covered by several filters is
  dropped when any of them drops it.
- **Outcome.** A dropped post is marked **Ignored**, the existing workflow state, through the
  same path as the person's own change: the workflow log, the read mirror to FreshRSS, the state
  version for synced devices, and clearing New. No undo token is made. Nothing is deleted.
  Retention and baskets are unaffected.
- **The person's word is last.** A filter changes only a post that nobody has touched since the
  filter last did. The post's state revision is still the one the filter left, or 0. A post that
  was opened, kept or moved is never changed by a filter again.
- **Re-checking.** Adding, changing or turning on a filter re-checks the untouched Undecided
  posts of the last 30 days (at most 500). Untouched posts it dropped before and would now keep
  go back to Undecided. Turning a filter off or removing it changes no post.
- **Announcements.** New posts of a filtered source are announced (notifications) only after
  judging, and only the ones that stay. If posts can't be judged (no usable key, a refused key,
  the job failing for good), they stay as they are and are announced as a sync would announce
  them.
- **Threshold.** "When unsure: keep" drops a post below a 0.3 probability of belonging; "drop"
  drops one below 0.6. The preview shows each probability.
- **What Jev is sent.** The post's title, summary (the stored excerpt, at most 300 characters),
  author and source name, and the person's words. Pages are never fetched for filtering. The
  dialog and the user guide say so. Private sources are not excluded, because the person turns
  the filter on per source.

## Keys, routes and Hosted Pro

- **No personal keys.** The owner ruled that a person never hands the server a Jev key: collecting
  people's provider keys is a leak risk the product doesn't take. Filters use only the server key.
- **Server key.** An administrator sets one Jev key for the server in Admin → Smart filters (with
  step-up confirmation and audit). It is stored in `<secrets>/jev-server-key` and shown only by
  its last four characters. A refusal by Jev is recorded until the key is replaced.
- **Self-hosted.** Once the administrator (the self-hoster) sets the server key, every account
  uses it. There are no plans and no
  allowance.
- **Hosted Pro.** The plan (€10 a month or €96 a year; 5,000 sources, unlimited collections and
  everything in Plus) includes Smart filters on the server key, with 25 million Jev input tokens
  a week (ISO week, Monday to Sunday UTC). The owner chose a week over a month: hitting it is less
  harsh and it resets sooner. People never see tokens or amounts, only that this week's allowance
  is used up and that their administrator can change their limits. Administrators set plans in Admin → Accounts (audited, with step-up
  confirmation) and always have it. When the week's allowance is used up, filters wait (fail
  open). Moving to a smaller plan stops filters on the server key and undoes nothing.
  **Payment handling is deliberately not built.**
  Plans are separate from any payment provider, as [18 Hosted service](18-hosted-service.md)
  requires. Choosing a provider, VAT, renewal, cancellation and the grace policy are open decisions.
- **Usage.** Input tokens and requests per account and ISO week on the server key, from Jev's own `usage`
  report. Previews count. The allowance is checked when a job starts, so jobs already running may
  overshoot it by their posts (a few tens of thousands of tokens at most).

## Cost

Jev bills $0.042 per million input tokens, and output is free (TypeSafe's published rate,
September 2026). A judged post is about 200 to 500 input tokens. The fixed instructions,
the person's words and the post together are well under 500, which comes to about $0.00002 per
post. Pro's full allowance costs at most about $1.05 a week (about $4.55 a month), against about €7.90 net of 21% VAT and
typical payment fees on €10. Typical use (a few thousand to tens of thousands of posts a
month) costs cents.

## Architecture

- A sync batch queues `filter.judge` jobs (20 posts each) in its transaction for new posts of
  filtered sources, when PURSS has a usable route. The worker asks the API what to ask
  (`POST /internal/filters/:jobId/input`, current lease only), as the filters are when the job
  runs. It sends one Jev request per post, with one `noul` question per applying filter, keyed by
  filter version, and reports the answers. Answers to an older filter version are ignored.
  Posts Jev couldn't be asked about while others were answered are queued again a minute later.
  When none could be asked, the job fails and retries normally.
- Previews run in the API, with 5 requests at a time and at most 40 previews per account every
  10 minutes.
- Jev's address is operator-fixed (`PURSS_JEV_URL`, default `https://api.typesafe.ai`), with
  redirects refused, so a key is only ever sent there. By default the model is the newest Jev
  (`jev-latest`, or `~typesafe/jev-latest` through OpenRouter), so filters follow TypeSafe's
  releases. An operator pins a version with `PURSS_JEV_MODEL` if a release behaves worse. Posts
  are judged once, so a model change affects new posts only.
- **Providers.** TypeSafe directly (`https://api.typesafe.ai`, the default) or OpenRouter
  (`PURSS_JEV_URL=https://openrouter.ai/api`), which serves the same System One endpoint and
  reports `usage.input_tokens`. Keys must come from the provider the server is set up for, and the
  key fields say which one that is. A reply without a token count is counted by request size.
- Post text is untrusted input. Jev has no tools and answers only probabilities, so a
  manipulated post can at worst win a wrong verdict for itself.

## Deferred

Payment integration for the paid plans. Item-level "filtered by AI" markers in lists (dropped posts
are found under Ignored). Filters in exports and imports (the definitions are short to
re-create, and keys are never exported).
