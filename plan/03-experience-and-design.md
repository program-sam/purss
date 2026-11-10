# Experience and design language

## T3 Code study

The reference inspection covers T3 Code's documented thread/sidebar behavior,
appearance system, project setting scopes, provider onboarding, and the web sidebar
layout source. See the pinned [reference inventory](15-references.md). This is source
and documentation inspection, not a claim of measured usability or a complete UI audit.

| Observed pattern | Adaptation for this product |
| --- | --- |
| Projects establish context; threads remain accessible in a persistent sidebar | Collections and baskets establish context; items open without losing the current view |
| Provider integrations expose models and capabilities behind a common shell | Connections expose sources and supported actions behind one Add source flow |
| Scoped settings show defaults and overrides | PURSS defaults with explicit collection/view overrides; no mysterious setting inheritance |
| Pinning, settling, snoozing, and undo make state changes visible | Clear workflow transitions, Keep in basket, bulk actions, and undo; no developer-state vocabulary |
| Resizable navigation and auxiliary panels | Collapsible navigation, central collection view, optional reader/details panel |
| Semantic palettes, light/dark choice, restrained motion | Original tokens, themes, comfortable density, reduced-motion support |

Do not map model selection literally onto content: a user follows a source, not
an ingestion engine. Do not expose a giant provider picker just because T3 has one.
Do not copy logos, exact visual assets, or code as part of this plan.

## Understand at a glance

Keep interface chrome light on text. People should recognize what they can do
from familiar controls, placement, visual hierarchy, and immediate feedback, not
from reading instructions. Prioritize content over explanatory paragraphs; this
does not mean shortening the articles or other material people came to read.

Use short, concrete action labels such as Follow, Keep, Move, and Undo. Pair icons
with labels when their meaning is not obvious; a minimal interface is not an
unlabeled interface. Every control needs an accessible name, visible keyboard focus,
and a usable touch target. Do not rely on color, hover tooltips, or gestures alone.
Show selected states and action results clearly, with undo for reversible changes.

Reveal secondary options and explanations on demand. Empty states should offer
one clear next action; errors should say what happened and how to recover in a
brief, plain-language message. Keep essential context visible for publishing,
permanent deletion, privacy, and storage consequences: reducing reading must not
hide what someone is agreeing to. Do not remove content titles or source identity
merely to make cards look cleaner.

Validate the primary flows with first-time users on desktop and mobile, without
a walkthrough. Ask what they expect each action to do before using it; observe
confusion and simplify the control rather than add a paragraph explaining it.
Test keyboard and screen-reader use too. The goal is little required reading,
not an arbitrary word limit or an icon-only aesthetic.

## Application shell

- Left navigation: Home, Following, Collections, Baskets, source health, Settings.
- Central header: current context, search/filter, view switcher, Add source / Keep action.
- Main surface: gallery, list, board, table, timeline, or dashboard sections.
- Optional detail pane: article/media, provenance, workflow, basket memberships.
- Narrow screens: navigation drawer, full-screen item detail, persistent return position.

Home should offer curated sections, not a mandatory unread counter. Unread counts
are optional information, never a debt meter. Remember view choice and navigation
position without making layout geometry a cross-device requirement.

Show a restrained storage indicator near PURSS/account navigation, expandable
into feed versus basket usage, allocation, measurement freshness, and management as implemented.
It should convey ownership rather than anxiety or an upgrade countdown. Hosted
users see their account, not other tenants or the operator's disk. Self-hosters can
open a separate server-capacity view. Warnings must name the affected action and
offer implemented cleanup choices (and export from Gate 4) without suggesting kept items will vanish.

## Enjoyment and engagement

This is an inviting place to spend time with a personally chosen internet, not an
anti-algorithm campaign or an austere productivity tool. Attractive cards, playful
details, badges, new-item highlights, optional counts, and familiar browsing patterns
are allowed. Do not reject a design just because it also appears in popular social
or video apps. Judge it by enjoyment, clarity, accessibility, and user control,
not by whether it minimizes all engagement.

Distinguish recently arrived content (the New marker) from unread and from the Undecided workflow state.
Opening a view or clearing a highlight must not silently finish, ignore, or read an
item. Let people choose how prominent freshness cues and counts are; someone may
enjoy a busy feed while another prefers a quiet one. Respect reduced motion.

Plan notifications with per-source/collection preferences, mute, quiet hours, and
digest versus individual delivery where supported. Ask for device permission in
context, provide an obvious off switch, and keep sensitive titles out of lock-screen
previews by default. Notification timing depends on source polling and channel
support, not on a promise of immediate delivery. Channels remain a delivery choice
to validate, not a requirement to connect an external paid service.

Useful engagement is welcome; fake unread counts, invented urgency, and hidden
subscription changes are not. Design review should include both casual, fun browsing
and focused reading, rather than optimize exclusively for either time spent or exit.

Anniversary reminders (on by default, owner decision) can reconnect people with their own choices:
"You kept this a year ago" or, if an explicit Like action is introduced, "You liked
this a year ago." Use the actual recorded action and date, never infer liking from
opening an item. Offer an in-PURSS memory card and optional notifications, with
hide, snooze, and disable controls. Private memories never become shared-collection
updates. Resurfacing does not reset workflow, mark unread, or make another stored copy.

## Settings: common and advanced

Use progressive disclosure, not separate products or paid tiers. Common settings
cover theme, text size/density, default view, new-content cues, notification mode,
quiet hours, anniversary reminders, and storage visibility. Good defaults should
make the experience useful without visiting Settings.

An explicitly labeled Advanced area exposes supported fine-grained controls:
per-source/collection overrides, reminder intervals and eligibility, notification
grouping, sorting/date choices, and supported reading-state behavior. Show effective
values, inherited defaults, scope, and Reset to default; common and advanced settings
edit the same preferences rather than creating conflicting layers. Hide unsupported
controls until their features exist, and make settings searchable when warranted.
Advanced does not mean raw code, arbitrary SQL, unsafe fetching, or bypassing storage
and privacy rules. Deployment secrets and server-only controls remain operator-only,
not accessible to ordinary hosted accounts.

## Content cards

Video cards prioritize thumbnail, creator, date, and duration when provided.
Articles prioritize title, publisher/author, excerpt, and reading context. Papers
can show journal and DOI when present. Missing metadata must not be invented.
Preserve attribution and expose Open original. No autoplay or automatic third-party
embeds; use explicit playback consent and disclose privacy implications.

## Accessibility and visual acceptance

Plan light and dark semantic tokens, original typography choices, focus rings,
keyboard navigation, non-drag alternatives for board moves, meaningful controls,
contrast checks, reduced motion, and responsive targets. Prefer restrained borders,
clear hierarchy, consistent spacing, and contextual actions over dense toolbars.

First design deliverable: linked desktop/mobile flows for Add source, collection
gallery, workflow board, basket, and reader. Validate labels and empty/loading/error
states before application styling. User approval of those flows gates broad UI work.
