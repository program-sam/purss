// Copy for the public website (apps/site): one export per source file of apps/site/src, so each page's script
// bundles only its own text. Import it as `import * as copy from "@purss/copy/site"`.

// What several places say, written once.
export const words = {
  appsAndExtensions: "Apps and extensions",
  createAFreeAccount: "Create a free account",
  docs: "Docs",
  downloadForAndroid: "Download for Android",
  features: "Features",
  home: "Home",
  hostItYourself: "Host it yourself",
  legalNotice: "Legal notice",
  local: "Local",
  november2026: "November 2026",
  pricing: "Pricing",
  privacy: "Privacy",
  recipes: "Recipes",
  slowReads: "Slow reads",
  why: "Why",
};

export const compare = {
  feeds: {
    heading: "Algorithmic feeds",
    points: ["Ranked to keep you scrolling", "Strangers and ads in between", "Your attention is the product", "Gone when the platform changes its mind"],
  },
  purss: {
    heading: "Your PURSS",
    points: ["Only the sources you chose, in your order", "No ads, no third-party trackers, no suggested posts", "Open source: read the code, or run it yourself", "What you keep stays put. Export it all, any time"],
  },
};

export const desktop = {
  /** The button's text once the visitor's system is known. */
  download: { windows: "Download for Windows", macos: "Download for Mac", linux: "Download for Linux", android: words.downloadForAndroid },
};

export const home = {
  nav: { whatItDoes: "What it does" },
  hero: {
    heading: "Your internet, organized by you.",
    lead: "A reader you fill yourself. Pick the blogs, channels, podcasts and journals; PURSS brings what they post, in order, and nothing else.",
    switchOff: "Chosen for you",
    switchOn: "Chosen by you",
    points: [
      { title: "No algorithmic feed", text: "Everything in the order it was posted." },
      { title: "No ads, no trackers", text: "Nothing sponsored, nothing suggested." },
      { title: "You're in control", text: "You pick every source and what stays." },
    ],
  },
  /** The picture of the home screen, which flips between the feed everyone knows and PURSS. */
  picture: {
    labelOn: "PURSS Home: a dashboard with a box for each source you follow, and nothing else.",
    labelOff: "A typical feed: ads, suggestions and trending posts mixed in with the few things you follow, with more loading forever.",
    addressOff: "the feed",
    addressOn: "your.purss",
    titleOff: "For You",
    view: "View",
    greeting: "Good morning, Robin",
    sinceLastVisit: "New items since your last visit (yesterday) in 2&nbsp;collections",
    loadingMore: "Loading more for you…",
    newCount: (n: number) => `${n} new`,
    posts: {
      cyclePath: { title: "Council approves the Mill Road cycle path", source: "Millbrook Gazette", when: "12 min ago" },
      handPlane: { title: "Restoring a 1970s hand plane", source: "Maker Bench", when: "1 h ago · 24:10" },
      smallLibraries: { title: "Ep. 112: Small libraries", source: "Night Shift Radio", when: "3 h ago · 58 min" },
      nightSky: { title: "The night sky is getting brighter", source: "Slow Light Journal", when: "Today · 9 min read" },
      tomatoSauce: { title: "Slow-roast tomato sauce that keeps all week", source: "Kitchen Table", when: "Yesterday" },
    },
    junk: {
      sponsored: { tag: "Sponsored", title: "The mattress 4 million sleepers can't stop talking about", sub: "Shop now" },
      suggested: { tag: "Suggested for you", title: "A stranger is extremely angry about something", sub: "Because you paused on a post like this" },
      trending: { tag: "Trending", title: "Everyone is arguing about this today", sub: "48.2K posts" },
      people: { tag: "People you may know", title: "Someone you met once in 2014", sub: "Follow back" },
    },
    boxes: { watchListen: "Watch & listen" },
  },
  why: {
    heading: "The web was yours once. Take it back.",
    pitch: "You used to choose what you read. Then feeds started choosing for you, ranked to keep you scrolling. PURSS hands the choice back: you decide what comes in, in what order, and what's worth keeping.",
  },
  features: {
    follow: { label: "Follow", heading: "Nothing from the people you follow gets buried.", text: "Subscribing on YouTube or following someone on Bluesky doesn't mean you'll see what they post. Here it does: paste a link, and new posts arrive, unranked, until you say stop." },
    keep: { label: "Keep", heading: "Find it again in six months.", text: "Drop it in a basket for the project, the trip or the rainy Sunday, and its details, summary and, if you ask, a readable copy of the text stay with you." },
    read: { label: "Read", heading: "Start on the laptop, finish on the train.", text: "Your place, your highlights and your notes follow you to every device, so nothing you started gets lost." },
    share: { label: "Share", heading: "You're the one people ask for good links.", text: "Share a basket or collection as a page anyone can open. Anyone who follows it gets each new pick as you add it." },
  },
  apps: {
    heading: "Wherever you come across things.",
    lead: "Save it where you find it, read it where you are. Your browser, phone, computer and e-reader all share one PURSS.",
  },
  pricing: {
    heading: "Simple, honest pricing.",
    lead: "No ads, no engagement algorithm, and we don't sell your data. Run it yourself or let us run it: it's the same app, and one export moves you between them.",
    youRunIt: "You run it",
    ownServer: "Your own server",
    ownServerLimits: "unlimited sources · unlimited collections · public pages",
    installGuide: "Read the install guide",
    hostPoints: ["Every feature, free forever", "Runs on a spare computer, in about 1&nbsp;GB of memory", "Open source, AGPL-3.0"],
    weRunIt: "We run it",
    hostedNote: "Cancel any time · Export everything, any time · Prices include VAT",
    planLine: {
      sources: (n: string) => `${n} sources`,
      collections: (n: string) => `${n} collections`,
      publicPages: "public pages",
      smartFilters: "Smart filters",
    },
    chargedInEuros: " a month, charged in euros",
  },
  faq: { heading: "Questions" },
  end: { heading: "Make the internet yours again." },
};

export const kit = {
  skipToContent: "Skip to content",
  /** Buttons that appear in the header and again on the home page. */
  actions: { signUpShort: "Start free", dashboard: "Open dashboard", signedIn: "Go to your PURSS" },
  nav: { apps: "Apps" },
  footer: {
    source: "Source code",
    terms: "Terms",
    credit: { before: "Run by ", middle: ". Built on the ", engine: "FreshRSS", after: " engine. No trackers on this site." },
  },
  /** The app's sidebar as pictured on the home page. */
  sidebar: {
    addSource: "Add source",
    search: "Search",
    collectionsTitle: "Collections",
    collections: { watch: "Watch", listen: "Listen" },
    basketsTitle: "Baskets",
    baskets: { localHistory: "Local history", thesisSources: "Thesis sources" },
    storage: "37 of 100 sources",
  },
  plans: {
    selfHosted: "Self-hosted",
    unlimited: "unlimited",
    billedMonthly: "per month, billed monthly",
    billedYearly: (year: string) => `per month, billed yearly as ${year}`,
    free: { name: "Free", per: "per month", lede: "We run it for you. No card needed." },
    plus: { name: "Plus", lede: "For people who follow a lot, and keep a lot.", cta: "Start with Plus" },
    pro: { name: "Pro", lede: "For busy feeds you want curated for you.", cta: "Start with Pro" },
  },
  billing: {
    yearly: "Yearly",
    save: (percent: number) => `save ${percent}%`,
    monthly: "Monthly",
    showPricesIn: "Show prices in",
  },
  apps: {
    extension: {
      title: "Browser extension",
      text: (platforms: string) => `Found something good? Keep it or follow its site without leaving the page. For ${platforms}.`,
    },
    phone: {
      title: "Phone and tablet",
      text: (platforms: string) => `Catch up in the queue or on the plane. The ${platforms} app plays with the screen off, keeps downloads for offline and takes links shared from any app.`,
    },
    desktop: {
      title: "Windows, Mac and Linux",
      text: "Close the window and it keeps working: alerts and downloads carry on from the tray, and it updates itself.",
      download: "Download",
      otherSystems: "Other systems",
    },
    bookmarklets: { title: "Bookmarklets", text: "Can't install anything? Two bookmarks send any page to PURSS, in any browser." },
    assistant: { title: "Your assistant, if you want one", text: "Ask Claude, ChatGPT or another assistant you already use what you've read about something, and let it tidy up if you allow. Connects through MCP; off until you turn it on." },
    eink: { title: "E-ink compatible", text: "Made to work on e-readers: black on white, with page buttons instead of scrolling." },
  },
  terminal: {
    host: "your-server",
    steps: { code: "Get the code", settings: "Settings (empty is fine for one machine)", start: "Start" },
    running: "✔ PURSS running on http://localhost:8940",
    developers: { before: "Developers: ", phone: "build the phone app", between: " or ", extension: "load the browser extension", after: " from the source." },
  },
  /** The questions and answers on the home page. An answer may contain the HTML it always had. */
  faq: [
    { question: "What can I follow?", answer: "Anything with a feed: blogs, news sites, journals, newsletters with a feed, YouTube channels, podcasts, and the public posts of Mastodon and Bluesky accounts. Paste a link or a handle and PURSS finds the feed and shows you a preview before you follow." },
    { question: "Can I follow sites in other languages, including Arabic?", answer: "Yes. Sources in any language or script work, and right-to-left text such as Arabic reads the right way round, even in a list next to English titles. Nothing is translated or changed. PURSS's own menus and buttons are in English for now." },
    { question: "Is self-hosting really the full product?", answer: "Yes. It's the same app with no limits unless you set them. The hosted plans exist for people who'd rather not run a server." },
    { question: "What happens if I stop paying?", answer: "Plus and Pro are billed yearly or monthly, as you choose, and you can cancel any time. Your plan runs to the end of the year or month you paid for, then your account moves to the Free limits. Nothing is deleted automatically to fit the free plan. You keep reading and exporting everything; new items pause until you're back under the free limits or renew." },
    { question: "What are Smart filters?", answer: "An optional filter for a source or collection that floods your lists. You describe which posts you want (\"keep posts about food, travel and gardening\", \"drop job ads\"), try it on the latest 20 posts, then turn it on. Jev, an AI model by TypeSafe AI that answers yes or no, judges each new post, and the ones it drops are marked Ignored: nothing is deleted, and a post you move back stays where you put it. Only a post's title, summary, author and source name are sent to be judged, never your reading, notes or account. Smart filters are included in the Pro plan. They are off until you set one up." },
    { question: "Why not just run FreshRSS?", answer: "FreshRSS does the fetching here too, and it's excellent at it. PURSS adds the parts people actually live in: guided Add source with YouTube, podcast, Mastodon and Bluesky discovery, collections, baskets with kept copies, five views, workflow with undo, highlights and notes, a podcast player, search, fingerprint and face sign-in, backups and invitations, plus a browser extension and phone apps. You never touch FreshRSS settings." },
    { question: "How does Discovery work?", answer: "Discovery is coming soon to the hosted service. It suggests sources you don't follow yet, from what other readers who follow your sources also follow, and says which of your sources led to each one, with a few chance picks for variety. It's an exchange: your followed sources count, without your name, and only readers who share get suggestions. A source counts only once at least 10 readers follow it, nobody sees who follows what or how many do, private sources never count, and suggestions never appear in your lists. Switch it off in Settings any time. A PURSS you host yourself has no Discovery." },
    { question: "Who can see my data on the hosted plans?", answer: "Your PURSS is private to your account; other users never see it. The admin tools we use to run the service show health, jobs and storage use, not your items or reading history; the only content they show is a shared page you published that someone reported. We don't sell your data or show ads, and you can export everything at any time. The hosted service is run by Program Sam on a server it manages." },
    { question: "Who runs the hosted service?", answer: 'Program Sam, the company behind the open-source code, runs it on a server it manages; how to reach Program Sam is on the <a class="link" href="/legal.html">legal notice</a>. You aren\'t locked in: every plan exports everything, and the same software runs on your own server. If the hosted service ever closed, the terms promise notice well in advance and time to export.' },
    { question: "Does a basket save the whole web page?", answer: "A basket keeps the item's details and summary, and can keep a readable text copy; with the browser extension, also the text as your browser shows it. Videos and episodes stay with their publisher; the phone app can download an episode to your device. None of that keeps the original page, video or episode online." },
    { question: "Does a basket keep pictures?", answer: "Yes, when the basket keeps a readable text copy: it then keeps the item's main picture and the pictures inside the text with it, so a recipe or a comic keeps its images. Items you only follow, without keeping them, still load their pictures from the publisher. Videos and episodes stay with their publisher." },
    { question: "Can I be reminded about something I kept?", answer: "Yes. Choose Remind me on a kept item, pick a date and add a note if you like. On that day the bell tells you, and an email comes too if you turn on Email me reminders in Settings. Home shows what's coming up in the next 7 days. It's meant for things like an exhibition or a deadline." },
    { question: "Can I share something with other people?", answer: "Yes. Copy link to the original on an item copies the original page's address, so you can send it to anyone and they need no account. A separate Copy your private link to this item opens it for you after you sign in. You can also share a whole basket or collection with Share on its page: it becomes a public page and feed that anyone can read without an account and follow from their own PURSS or any feed reader, and it keeps showing what you add. You can add a public note to any item on it. Before anything is shared you see the page and what of yours becomes public; it never shows your reading, private notes, highlights or saved text. Sharing is part of Plus and Pro, and included when you host PURSS yourself." },
    { question: "Can readers of my blog follow it here?", answer: "Yes. In Settings → Connected apps, paste your blog's feed address to get a Follow button for your pages. Readers who press it can follow you in their PURSS, or copy the feed into any other reader. The button is a plain link: no script, no tracking." },
    { question: "What works without a connection?", answer: "In the installed app, your reading list is saved on the device: your To read and In progress items, recent new ones, and kept items with saved text. You can read them, mark them and write highlights and notes; changes are sent when you're back online. Adding sources, search, settings and anything not saved need a connection, and so can pictures. The phone app can also download an episode to your device for listening offline." },
    { question: "Is there a phone app or a browser extension?", answer: "Both are on the way to the stores. The Android app can already be downloaded from this page; the extension for Chrome, Edge and Firefox isn't in the browser stores yet. On an iPhone or iPad, add PURSS to your home screen from your browser: it opens like an app and keeps your reading list for offline. Bookmarklets work in any browser with nothing to install. If you're technical, you can already build both from the source code." },
    { question: "Can I sign in on a borrowed or shared computer?", answer: "Yes. Fingerprint, face or screen lock is the quickest way in on your own devices, but you can also sign in with your email address and password on any computer. On a library, work or borrowed computer, choose This is a shared computer on the sign-in page: the session ends when the browser closes, and after eight hours at the latest, and offline copies stay off in an ordinary browser tab. Two people on one laptop each use their own account." },
    { question: "Is it accessible?", answer: (issuesUrl: string) => `We build the website and the app for keyboard use and screen readers: named controls, visible focus, keyboard shortcuts in the app, a skip link on the website, and text that still fits when enlarged. We have checked them with the keyboard alone, with the browser's accessibility tree and with enlarged text, and we fix what that finds. We have not had an independent audit or tested with a panel of people who use assistive technology, so there will be gaps. If something doesn't work for you, <a class="link" href="${issuesUrl}">open an issue</a> or reach Program Sam through the <a class="link" href="/legal.html">legal notice</a>, and say what you were doing and what you use. We treat it as a bug.` },
    { question: "Does it use AI?", answer: "Not unless you ask it to. If you want, you can connect your own assistant, such as Claude or ChatGPT, to search and read your PURSS, and organise it if you allow. It's off until you turn it on, and you can disconnect it at any time. You can also give a source or collection a Smart filter: you describe in plain words which posts you want, instead of combining keywords and rules, and an AI model sets the rest aside. Smart filters are off until you set one up." },
    { question: "Can I move between hosted and self-hosted?", answer: "Yes. Export your PURSS from one and import it into the other. Coming from Feedly, Inoreader or another reader? Import its OPML file (the export file most readers offer) and your sources come with you." },
  ],
};

export const legal = {
  lastUpdated: (date: string) => `Last updated ${date}`,
  terms: {
    title: "Terms of service",
    body: (plans: { free: string; plus: string; pro: string; plusYear: string; plusMonth: string; proYear: string; proMonth: string }) => `
<p class="s-lead">These terms cover the hosted PURSS that Program Sam runs for you. If you run the software on your own server, these terms don't apply: the software itself is licensed under the <a class="link" href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL-3.0</a>.</p>

<h2>1. The plans</h2>
<ul>
<li><b>${plans.free}</b>, €0: up to 5 collections and 100 sources.</li>
<li><b>${plans.plus}</b>, ${plans.plusYear} per year or ${plans.plusMonth} per month, including VAT: unlimited collections, up to 1,000 sources, and sharing baskets and collections as public pages.</li>
<li><b>${plans.pro}</b>, ${plans.proYear} per year or ${plans.proMonth} per month, including VAT: everything in Plus, up to 5,000 sources, and Smart filters under fair use. If an account reaches the week's fair-use limit, its filters pause until the next week and new posts arrive unfiltered.</li>
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
<p>On ${plans.plus} and ${plans.pro} you can share a basket or a collection as a public page and feed: anyone with the link can read it without an account, and, if you choose, search engines can list it. It keeps showing what you add to that basket or what that collection gathers, until you pause it or stop sharing. You decide what to share, and you are responsible for it, including the public notes you write. If your account moves to the Free limits, your pages stop showing until you choose Plus again; nothing is deleted. Share only links and words you are allowed to share. Each item shows its title, link, a short summary, source name and date, never a copy of the article.</p>
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
    updated: words.november2026,
  },
  privacy: {
    body: `
<p class="s-lead">The short version: your PURSS is yours. We keep what the service needs to work, we don't track you, and we don't sell or advertise on your data. This page covers the hosted PURSS run by Program Sam. If you host it yourself, your data stays on your server and this policy doesn't apply.</p>

<h2>This website</h2>
<p>This site sets no cookies and loads no analytics, trackers or third-party scripts. Our server sees the usual request details (your IP address and browser) when you visit, only to serve the pages.</p>

<h2>What the hosted service stores</h2>
<ul>
<li><b>Your account:</b> your display name and how you sign in. With fingerprint, face or screen lock we store only its public key; with a password, only a secure hash. If you choose Continue with Google, Google sends us your name, your email address (we use it only if Google has verified it), your profile picture and your given and family names, and a stable Google account ID; never your Google password. We keep only your name, your email address and the account ID (to recognise you next time) and discard the rest.</li>
<li><b>Your email address,</b> if you give one; signing up asks for it. We email it only: to confirm it's yours; about your account's security, such as a password reset link you asked for or a changed password or address; with your digest of what's new in your PURSS, once you have confirmed the address (weekly unless you choose otherwise; every digest links to the setting that stops them, under Settings → Notifications and New); and with reminders, only if you turn those on. No newsletters or marketing. A log of what was sent (the kind of message, a masked address and whether it arrived) is kept for 90 days, without the messages.</li>
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
<li><b>Brevo</b> delivers our email (confirming your address, resetting your password, your digest, reminders you ask for), so it sees your address and those messages. A digest names your collections, counts what's new and shows the titles of the newest items, never those of private sources.</li>
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
<p>Your PURSS is kept until you delete it: items you delete, sources you unfollow, or your whole account. Kept items never expire on a schedule. Disconnecting an app or assistant deletes its access key at once. When you delete your account in Settings, it is locked at once (connected apps and assistants are disconnected too) and its data, saved episodes included, is deleted from the service 7 days later, unless you sign in and keep it. Copies in backups made before then are deleted when those backups expire; how long backups are kept is stated here before the hosted plans open.</p>

<h2>Your rights</h2>
<p>You can see and export everything at any time, correct it in the app, and close your account to have it deleted. If you live in the EU you also have the right to object, to restrict processing and to complain to your data protection authority. We use your data only to provide the service you signed up for.</p>

<h2>Contact</h2>
<p>Questions about privacy go to Program Sam; see the <a class="link" href="/legal.html">legal notice</a>. If we change this policy, we tell you in PURSS before the change applies.</p>
`,
    title: words.privacy,
    updated: words.november2026,
  },
  legal: {
    body: `
<p class="s-lead">Who runs PURSS, and how to reach them.</p>

<h2>Operator</h2>
<p>The hosted PURSS is run by <b>Program Sam</b>, on a server Program Sam manages.</p>

<h2>Contact</h2>
<p>Reach Program Sam through <a class="link" href="https://github.com/program-sam">github.com/program-sam</a>.</p>

<h2>The software</h2>
<p>PURSS is free software under the <a class="link" href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License v3.0</a>. It is built on <a class="link" href="https://freshrss.org">FreshRSS</a>, which fetches the feeds. Anyone may use, change and host it; anyone who distributes it, or runs a changed version as a network service, shares their source under the same license.</p>

<h2>Content you follow</h2>
<p>Articles, videos and podcasts shown in a PURSS come from the sources each person chose to follow and belong to their publishers. PURSS doesn't rank them. On the hosted service, Discovery (coming soon) suggests sources, never single items, to readers who share their own, and says why; suggestions are never mixed into your lists.</p>

<h2>Shared pages</h2>
<p>A shared page (an address with <code>/p/</code> in it) is published by the person named on it, not by Program Sam. It links to articles that belong to their publishers and shows only their titles, short summaries and that person's own public notes. To report a page that breaks the law or our terms, including a copyright complaint, use the <b>Report this page</b> link at its foot.</p>

<h2>Terms and privacy</h2>
<p>Using the hosted service is covered by the <a class="link" href="/terms.html">terms of service</a> and the <a class="link" href="/privacy.html">privacy policy</a>.</p>
`,
    title: words.legalNotice,
    updated: words.november2026,
  },
};

export const pages = {
  index: {
    title: (name: string) => `${name}: your internet, organized by you`,
    description: "Follow blogs, journals, YouTube channels and podcasts in one calm place, with no engagement algorithm. Keep what matters in baskets. Open source: host it yourself for free, or let us host it.",
  },
  /** Structured data on the home page. */
  structuredData: {
    description: "A calm reader for blogs, journals, YouTube channels and podcasts that you can host yourself.",
    operatingSystem: "Any modern browser; self-hosted with Docker on Linux",
    offer: (plan: string, period: string) => `${plan}, billed ${period}`,
    yearly: "yearly",
    monthly: "monthly",
  },
  terms: {
    title: (name: string) => `Terms of service · ${name}`,
    description: "The terms for the hosted PURSS: the plans, paying and cancelling, your data, fair use and closing your account.",
  },
  privacy: {
    title: (name: string) => `Privacy · ${name}`,
    description: "What the hosted PURSS stores, who else is involved, how long it is kept and your rights. No trackers, no ads, no selling your data.",
  },
  legal: {
    title: (name: string) => `Legal notice · ${name}`,
    description: "Who runs PURSS, how to reach them, and the GNU AGPL-3.0 license the software is under.",
  },
  notFound: {
    title: (name: string) => `Page not found · ${name}`,
    description: "This page doesn't exist.",
    heading: "This page isn't here.",
    lead: { before: "The link may be old or mistyped. Try the ", home: "home page", between: ", or the ", faq: "questions and answers" },
  },
  /** The text of the link preview image. */
  previewImageAlt: "PURSS: Your internet, organized by you.",
};
