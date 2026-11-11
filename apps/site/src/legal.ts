import { footer, nav, PLANS, PLUS, PRO } from "./kit.ts";
import type { Site } from "./site.ts";

/** Terms of service, privacy policy and legal notice for the hosted service. Self-hosted copies are covered by the AGPL-3.0 only. */
export const LEGAL = {
  terms: {
    title: "Terms of service",
    updated: "November 2026",
    body: `
<p class="s-lead">These terms cover the hosted PURSS that program-sam runs for you. If you run the software on your own server, these terms don't apply: the software itself is licensed under the <a class="link" href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL-3.0</a>.</p>

<h2>1. The plans</h2>
<ul>
<li><b>${PLANS.free.name}</b>, €0: up to 4 collections and 100 sources.</li>
<li><b>${PLANS.plus.name}</b>, €${PLUS.year} per year or €${PLUS.month} per month, including VAT: unlimited collections, up to 1,000 sources, and sharing baskets and collections as public pages.</li>
<li><b>${PLANS.pro.name}</b>, €${PRO.year} per year or €${PRO.month} per month, including VAT: everything in Plus, up to 5,000 sources, and Smart filters under fair use. If an account reaches the week's fair-use limit, its filters pause until the next week and new posts arrive unfiltered.</li>
</ul>
<p>Every plan includes the full reader: every view, baskets, search, and export of everything. Saved links don't count as sources. To protect the service, each account also has a limit on the space it takes on our server; ordinary use stays well below it. If an account reaches it, new items and readable copies pause until we give it more; nothing is deleted.</p>

<h2>2. Paying and cancelling</h2>
<p>Plus and Pro are billed in advance, yearly or monthly, as you choose. You can cancel at any time. Your plan then runs to the end of the year or month you paid for, after which your account moves to the Free limits. We don't charge you again after you cancel. Deleting your account cancels its plan too.</p>
<p>If you live in the EU you have the right to withdraw from a new Plus or Pro subscription within 14 days. If you asked for it to start straight away, you pay only for the days you used and we refund the rest.</p>
<p>If we ever change the price, we tell you at least 30 days before it applies to you, and you can cancel before then.</p>

<h2>3. Going over your limits</h2>
<p>Nothing is deleted automatically to fit a plan. If your account is over its limits, for example after moving from Plus to Free, you can still read, organize and export everything. New items and new readable copies pause until you're back under the limits or choose a paid plan again. You decide what to clean up.</p>

<h2>4. Your data</h2>
<p>What you follow, keep and write in your PURSS is yours. You can export all of it at any time, on every plan, and import it into a PURSS on your own server. We don't sell your data, use it for advertising, or show you ads. While you share your sources for Discovery, they count without your name towards suggestions for others; you can switch that off in Settings at any time. The admin tools we use to run the service show health, jobs and storage use, not your items or reading history; the only content they show is a shared page you published that someone reported. For our own news posts they count how many PURSSes opened, kept or ignored each one, never whose. Our <a class="link" href="/#faq">questions and answers</a> explain more.</p>

<h2>5. What a basket keeps</h2>
<p>A basket keeps your copy of an item's details and summary, and its readable text if you asked for it. The original page, video or podcast belongs to its publisher and can change or go offline; a basket doesn't keep a copy of the video or audio. Videos and episodes play from where they are published, under that service's own terms. The phone app can download an episode to your device; that copy stays on your device only.</p>

<h2>6. Fair use</h2>
<p>Use PURSS for your own reading and for sharing what you're allowed to share. Don't use it to break the law, to overload or attack other sites, to reach private or internal networks (PURSS blocks such addresses), or to get at other people's accounts or data. If an account puts the service or others at risk, we may pause its sources or suspend it. Where it is safe to do so we tell you first, and you keep the chance to export.</p>

<h2>7. Sharing baskets and collections</h2>
<p>On ${PLANS.plus.name} and ${PLANS.pro.name} you can share a basket or a collection as a public page and feed: anyone with the link can read it without an account, and, if you choose, search engines can list it. It keeps showing what you add to that basket or what that collection gathers, until you pause it or stop sharing. You decide what to share, and you are responsible for it, including the public notes you write. If your account moves to the Free limits, your pages stop showing until you choose Plus again; nothing is deleted. Share only links and words you are allowed to share. Each item shows its title, link, a short summary, source name and date, never a copy of the article.</p>
<p>Anyone can report a public page, and reports come to us. If we find that a page breaks the law or these terms, we take it down: our server stops showing its page and feed at once (a browser or feed reader may show a copy it fetched in the minute before), you see our reason in PURSS, and you keep the basket or collection but can't share it again unless we restore it. Repeated or serious breaches can lead to suspension. Copies that visitors or feed readers fetched before a page was paused, unpublished or taken down can't be recalled.</p>

<h2>8. The service</h2>
<p>We work to keep the service running and to back it up, but we can't promise it will always be available or free of errors. Export your PURSS now and then, so you always have your own copy. If we ever close the hosted service, we give you notice well in advance and time to export everything or move to your own server.</p>

<h2>9. Closing your account</h2>
<p>You can delete your account yourself in Settings → Account. You confirm it's you, can export everything first, and type your name to confirm. The account is locked and signed out everywhere at once, and deleted for good after 7 days; sign in before then to keep it. After that, its data can't be recovered. The last administrator of an installation can't delete their account until someone else is an administrator.</p>

<h2>10. Liability</h2>
<p>We are responsible for running the service with reasonable care. As far as the law allows, we aren't liable for indirect loss or for content published by others that you follow. Nothing in these terms limits the rights you have as a consumer under the law of the country where you live.</p>

<h2>11. Changes to these terms</h2>
<p>If we change these terms, we tell you in PURSS before the change applies. If you don't agree, you can export your data and close your account.</p>
`,
  },
  privacy: {
    title: "Privacy",
    updated: "November 2026",
    body: `
<p class="s-lead">The short version: your PURSS is yours. We keep what the service needs to work, we don't track you, and we don't sell or advertise on your data. This page covers the hosted PURSS run by program-sam. If you host it yourself, your data stays on your server and this policy doesn't apply.</p>

<h2>This website</h2>
<p>This site sets no cookies and loads no analytics, trackers or third-party scripts. Our server sees the usual request details (your IP address and browser) when you visit, only to serve the pages.</p>

<h2>What the hosted service stores</h2>
<ul>
<li><b>Your account:</b> your display name and how you sign in. With fingerprint, face or screen lock we store only its public key; with a password, only a secure hash. If you choose Continue with Google, Google sends us your name, your email address (we use it only if Google has verified it), your profile picture and your given and family names, and a stable Google account ID; never your Google password. We keep only your name, your email address and the account ID (to recognise you next time) and discard the rest.</li>
<li><b>Your email address,</b> if you give one; signing up asks for it. We use it to confirm it's yours, to send password reset links, and for notices about your account, such as a changed password or address. No newsletters or marketing. A log of what was sent (the kind of message, a masked address and whether it arrived) is kept for 90 days, without the messages.</li>
<li><b>Your PURSS:</b> the sources you follow, the items they publish, your collections, baskets, reading progress and workflow states, readable copies you asked for, your highlights and notes, where you stopped listening to an episode, and your settings.</li>
<li><b>Page text from your browser:</b> when you ask the browser extension to keep a page with its text, it sends the readable part of the page as your browser shows it, which can include pages you are signed in to. It is stored like other readable copies.</li>
<li><b>Connected apps and assistants:</b> for the phone app, the browser extension and each assistant you connect, a name, when it was connected and last used, and a secure hash of its access key, never the key itself. If you turn on notifications on a phone, also the phone's random notification handle from our push relay, a secure hash of the key the phone fetches its notifications with, and which notifications it has been shown.</li>
<li><b>Counts for Discovery:</b> how many accounts follow each public source, and each two public sources together, counted only once at least 10 accounts do and kept without any name or account. Your followed public sources count while sharing is on, which it is unless you switch it off in Settings; switching it off takes you out of the counts within minutes and stops your own suggestions, because Discovery is for readers who share. Private sources never count. Beside the counts we keep each counted source's public feed address, a title and site used by at least 10 of its followers, and its kind. Sources you mark Not interested are kept with your account and deleted with it.</li>
<li><b>A history of your own actions,</b> such as moving an item to Finished, used only for your private statistics. It is deleted with the item.</li>
<li><b>A sign-in cookie</b> that keeps you signed in for up to 30 days. It's the only cookie the app uses.</li>
<li><b>Reports about shared pages:</b> when a visitor reports a public shared page, we keep what they typed (the reason, their explanation and, only if they gave one, a way to reach them) so an administrator can review it. We don't keep their IP address, and the page's owner doesn't see the report. Reports are deleted when the page is.</li>
</ul>
<p>We don't record which items you look at for anyone but you, build profiles, or use your data to train AI. The app has no built-in AI; assistant access is off until you turn it on and connect an assistant yourself.</p>

<h2>Who else is involved</h2>
<ul>
<li><b>The sites you follow.</b> Feeds are fetched by our server, so those sites see our server, not you. Images inside articles load directly from the publisher, so they can see your IP address when you open an article. Podcast episodes and other audio or video files play in PURSS's player, or download to the phone app, from the publisher, so the publisher sees your IP address while you listen. YouTube videos play on YouTube.</li>
<li><b>Assistants you connect.</b> If you turn on assistant access and connect an assistant (such as Claude or ChatGPT), with a token or by approving it in PURSS, its provider can search and read your items, sources, collections, baskets, and your highlights and notes; if you allow organising, it can also change states, keep items and follow or unfollow sources. What it reads goes to that provider under its own privacy terms. You can disconnect it in Settings at any time.</li>
<li><b>Notifications on your phone,</b> only if you turn them on. The phone gives its push address (from Google's Firebase) to our push relay, which hands back a random handle; your PURSS keeps only that handle. When something new reaches your bell, your PURSS asks the relay to wake the phone, and the relay asks Google to deliver a push with no text in it. The phone then fetches the notification's text from your PURSS itself. So the relay sees the phone's push address, its IP address when it registers, the server that asks it to wake that phone and when; Google sees that the app got a push and when. None of them see your account, your items or any notification text. Turning it off, or disconnecting the app, deletes the handle from your PURSS, and the app asks the relay to delete it too; the relay deletes any handle it hasn't used for 180 days.</li>
<li><b>The browser extension and phone app</b> talk only to your PURSS (and, for notifications, the phone to our push relay). The extension sends a page's address and title when you click its button or keep the page (and, only if you turn on marking kept pages, the address of each page you open), your search words, and a page's text when you ask. Once they are published in app and extension stores, those stores handle installing and updating them under their own terms.</li>
<li><b>Google,</b> only if you choose Continue with Google. You sign in on Google's own page, and Google sees that you signed in to PURSS and when, under its own privacy policy. We don't send Google anything about your PURSS.</li>
<li><b>Brevo</b> delivers account email (confirming your address, resetting your password, reminders you ask for), so it sees your address and those messages.</li>
<li><b>Our hosting provider</b> runs the server hardware the service lives on. We don't share your PURSS with it or anyone else.</li>
<li><b>Smart filters</b>, if you turn one on (Pro plan), send each new post's title, summary, author and source name to OpenRouter, which passes them to Jev, TypeSafe AI's decision model, to judge whether you'd want it. Nothing else is sent: not your reading, notes, account or other items.</li>
<li><b>Stripe</b> handles Plus and Pro payments. When you pay, Stripe receives your email address, card and billing details and keeps them under its own privacy policy. We never see or store your card details: we keep which plan you're on, and next to your account's ID the Stripe customer and subscription it pays with.</li>
</ul>

<h2>Visiting a shared page</h2>
<p>Opening someone's shared page, its feed or its follow page needs no account and sets no cookies; these pages load no scripts, trackers or outside resources. As with this website, our server sees the usual request details (your IP address and browser) to serve the page. PURSS also holds the address briefly in memory (never on disk, at most two hours) to limit how often one address can load pages or send reports, and never saves it with a report. Following the articles' links takes you to their publishers, who have their own policies.</p>

<h2>Who can see your PURSS</h2>
<p>Only you. Other users never see it. If you share a basket or collection, its page and feed show its items (each item's title, link, short summary, source name and date), the public notes you wrote for that page and the name you picked, to anyone with the link. Sharing a basket shows what you keep in it; links you saved yourself show with the title you gave them. Your reading progress and states, private notes and highlights, and saved text are never on it. Discovery, coming soon, suggests sources that are followed together by at least 10 accounts that share them; it never shows who follows what or how many do. The admin tools we use to run the service show health, jobs and storage use, not your items or reading history; the only content they show is a published shared page that someone reported. For our own news posts, which every PURSS gets as a source you can unfollow, they count how many PURSSes opened, kept or ignored each post, never whose.</p>

<h2>How long we keep it</h2>
<p>A report about a shared page is kept until you stop sharing it or delete its basket or collection, so that an administrator can review it and see what was decided.</p>
<p>Your PURSS is kept until you delete it: items you clean up, sources you unfollow, or your whole account. Kept items never expire on a schedule. Disconnecting an app or assistant deletes its access key at once. When you delete your account in Settings, it is locked at once (connected apps and assistants are disconnected too) and its data, saved episodes included, is deleted from the service 7 days later, unless you sign in and keep it. Copies in backups made before then are deleted when those backups expire; how long backups are kept is stated here before the hosted plans open.</p>

<h2>Your rights</h2>
<p>You can see and export everything at any time, correct it in the app, and close your account to have it deleted. If you live in the EU you also have the right to object, to restrict processing and to complain to your data protection authority. We use your data only to provide the service you signed up for.</p>

<h2>Contact</h2>
<p>Questions about privacy go to program-sam; see the <a class="link" href="/legal.html">legal notice</a>. If we change this policy, we tell you in PURSS before the change applies.</p>
`,
  },
  legal: {
    title: "Legal notice",
    updated: "November 2026",
    body: `
<p class="s-lead">Who runs PURSS, and how to reach them.</p>

<h2>Operator</h2>
<p>The hosted PURSS is run by <b>program-sam</b>, on a server program-sam manages.</p>

<h2>Contact</h2>
<p>Reach program-sam through <a class="link" href="https://github.com/program-sam">github.com/program-sam</a>.</p>

<h2>The software</h2>
<p>PURSS is free software under the <a class="link" href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License v3.0</a>. It is built on <a class="link" href="https://freshrss.org">FreshRSS</a>, which fetches the feeds. Anyone may use, change and host it; anyone who distributes it, or runs a changed version as a network service, shares their source under the same license.</p>

<h2>Content you follow</h2>
<p>Articles, videos and podcasts shown in a PURSS come from the sources each person chose to follow and belong to their publishers. PURSS doesn't rank them. On the hosted service, Discovery (coming soon) suggests sources, never single items, to readers who share their own, and says why; suggestions are never mixed into your lists.</p>

<h2>Shared pages</h2>
<p>A shared page (an address with <code>/p/</code> in it) is published by the person named on it, not by program-sam. It links to articles that belong to their publishers and shows only their titles, short summaries and that person's own public notes. To report a page that breaks the law or our terms, including a copyright complaint, use the <b>Report this page</b> link at its foot.</p>

<h2>Terms and privacy</h2>
<p>Using the hosted service is covered by the <a class="link" href="/terms.html">terms of service</a> and the <a class="link" href="/privacy.html">privacy policy</a>.</p>
`,
  },
} satisfies Record<string, { title: string; updated: string; body: string }>;

export type LegalKey = keyof typeof LEGAL;

/** A text page: the legal pages and the 404 page. */
export function docPage(site: Site, title: string, body: string, updated?: string): string {
  return `<a class="s-skip" href="#main">Skip to content</a>${nav(site, "/")}
<main id="main" tabindex="-1" class="s-doc"><div class="s-wrap"><article>
<h1 class="s-h2">${title}</h1>${updated ? `<p class="fine">Last updated ${updated}</p>` : ""}${body}</article></div></main>
${footer(site)}`;
}

export const legalPage = (site: Site, key: LegalKey): string => docPage(site, LEGAL[key].title, LEGAL[key].body, LEGAL[key].updated);
