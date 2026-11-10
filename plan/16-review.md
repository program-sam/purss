# Independent review

## Review scope

Review the plan and scaffold against the owner's requested product. This review
cannot approve a non-existent application, FreshRSS runtime behavior, deployment,
security posture, or usability. Keep those as explicit milestone gates.

## Review ledger

Reviewer: Claude Opus 5.5 through `claudeAgent`, effort `high`. Round 1 verdict:
**CHANGES**, four should findings, two nits, no blockers. Review was read-only and
did not run the application or scaffold checks. Lead checks: `npm run check` and
`npm test`, all five scaffold-validator tests pass. Usage was not returned.

| ID | Severity | Disposition |
| --- | --- | --- |
| S1 | should | Accepted: explicitly schedule manual/source collections in the first slice, query collections and timeline in Gate 4 |
| S2 | should | Accepted: no automatic product-item deletion in the first slice; later pruning requires opt-in, preview, and pin protection |
| S3 | should | Accepted with narrower evidence: add replacement-engine reconciliation and ambiguity staging; standard GReader output hardcodes compatibility mode, so the richer internal conversion is not assumed API-accessible |
| S4 | should | Accepted: require real engine/bridge egress tests, including redirects after subscription; safe discovery alone is insufficient |
| S5 | nit | Accepted: evaluate existing OPML/CLI paths before extensions; trusted import accepts product-generated, validated fields only |
| S6 | nit | Accepted: choose explicit upstream retention and warn about potential import gaps after outages, including count-based limits |

The lead verified the identity conversion, standard stream call, trusted OPML
import, extended OPML documentation, CLI script names, and retention configuration
against the pinned FreshRSS source. Also replaced a YouTube help link that redirected
to a generic page with an accurate channel-identity reference.

Focused round 2 verdict: **APPROVE**. The same reviewer and effort confirmed S1–S6
resolved and independently spot-checked the pinned FreshRSS conversion and import
code. Two non-blocking nits were accepted: name timeline/query-mode collections in
the product summary (N1), and tidy a roadmap line break (N2). No findings were
rejected. Usage was not returned; no additional round is needed for these wording fixes.

All changes are planning clarifications; no runtime application behavior exists
or changed. Approval covers the plan/scaffold, not application readiness or permission
to deploy or launch a service. Earlier research reviews do not count as approval of
this repository plan. The owner has explicitly authorized committing/pushing the
plan; application implementation and deployment remain outside this request.

## Storage and hosting scope

The storage indicator, accounting contract, and official hosted/free-account direction
are reviewed separately from the baseline plan. Expansion round 1, Claude Opus 5.5
at high effort: **CHANGES**, six should findings and five nits, no blockers.

| ID | Severity | Disposition |
| --- | --- | --- |
| H1 | should | Accepted: Gate 3 has indicator/breakdown and a confirmed permanent-delete path; full management and export are Gate 4, without dead links |
| H2 | should | Accepted: Gate 3 exit explicitly proves metering, shared references, concurrent admission, reservation recovery, and disk-reserve pause |
| H3 | should | Accepted: immutable content versions, admitted live updates, post-unpin classification, and explicit reference-aware deletion |
| H4 | should | Accepted: bounded disclosed control-operation headroom, actual usage visibility, and quota-exempt deletion; content growth remains blocked |
| H5 | should | Accepted: full-account export scope and engine-free restore with replacement-engine reconciliation |
| H6 | should | Accepted: inactive free-account policy is an explicit pre-beta decision, no silent purge |
| H7 | nit | Accepted: pending reservations displayed separately from used bytes |
| H8 | nit | Accepted: chargeable trash/pending-deletion objects are included once in Other |
| H9 | nit | Accepted: distinguish household/shared-PURSS use from official hosted Gate 6 |
| H10 | nit | Accepted: record expansion review independently of baseline approval |
| H11 | nit | Accepted: first slice only needs operator-set/unallocated capacity; funding lifecycles are later |

All changes are planning prose. Reviewer independently reran both checks (5/5
validator tests); no runtime service was tested. Usage was not returned.

Expansion round 2, same model/effort: **CHANGES**, with H1–H11 resolved except a
one-line H3 classification contradiction (S1). Reviewer explicitly conditioned
approval on changing Feed-only from feed-derived provenance to a live feed reference,
and waived another round. The lead applied and verified that exact correction in
the classification rule against the lifecycle paragraph. Accepted the three optional
nits: gate-aware management/export copy, explicit basket definitions in full export,
and state-headroom/quota-exempt-deletion validation cases. No findings were rejected.
This records conditional review and lead verification, not an unissued unconditional
APPROVE verdict. Checks pass; application behavior remains unimplemented/unproven.

## Whole-person narrative review

Claude Opus 5.5 (`claudeAgent`, effort `high`) reviewed the twenty fictional stories,
their index, and the independent product-fit review guide. Editorial round 1:
**CHANGES**, three should findings and five nits, no blockers. Editorial round 2:
**CHANGES**, with approval explicitly conditional on removing the index's universal
"chosen news" framing; the reviewer waived another round for that correction.
The lead applied the correction: the framing now describes different combinations
of interests rather than a checklist every person must satisfy.

| ID | Severity | Disposition |
| --- | --- | --- |
| ED-01 | should | Accepted: varied friends' channels and news habits; removed universal index framing |
| ED-02 | should | Accepted: mainstream platforms named without promising access; Kenji's Signal need is remembering shared links, not ingesting private chat |
| ED-03 | should | Accepted: different attitudes to recommendations and organization, concrete stakes instead of a repeated anti-homework refrain |
| ED-04 | nit | Accepted: personalized login/offline/weather experiences instead of authorial capability warnings |
| ED-05 | nit | Accepted: humanized Nia, Marta, and Farah outcome bullets |
| ED-06 | nit | Accepted: Farah misses Instagram pop-ups and loses addresses in chat, giving leisure its own stakes |
| ED-07 | nit | Accepted: restored teaser, topic-pause/payment, graduation email, and unavailable-artist-update concerns |
| ED-08 | nit | Declined: preserve existing filenames and links; visible titles and index describe the whole person |
| ED-09 | nit | Accepted: removed repeated laptop setup and reflowed edited paragraphs |
| ED-10 | nit | Accepted: replaced ambiguous "hobby collection" with "my interests" |

Conditional editorial sign-off covers narrative alignment only, not product fit,
source access, user research, or market validation. Independent product-fit
assessments remain unperformed. Reviews were read-only; usage was not returned.
Lead scaffold/link checks, five validator tests, and whitespace checks pass.

## Collection-sharing review

Claude Opus 5.5 (`claudeAgent`, effort `high`), sharing round 1: **CHANGES**, three
should findings and four nits, no blockers. Scope was the shareable-collection
proposal and its product/roadmap/validation links, not broader architecture.

| ID | Severity | Disposition |
| --- | --- | --- |
| SC-01 | should | Accepted: separate published membership; private additions never publish, Public status and preview on publication actions |
| SC-02 | should | Accepted: chosen public display name, pseudonyms allowed; no email/login/internal-ID defaults |
| SC-03 | should | Accepted: no follower identities shown to curators, minimized access logs with stated retention, no claim of anonymous remote polling |
| SC-04 | nit | Accepted: one-time import is conditional future work, not a promised feature |
| SC-05 | nit | Accepted: no indexing requested by default, opt-in indexing is not access control |
| SC-06 | nit | Accepted: deletion/suspension/uninstall stop publication; operator retirement and cache limits are explicit |
| SC-07 | nit | Accepted: source-bundle consent tests apply when that later capability is introduced |

Focused sharing round 2: **APPROVE**. SC-01–SC-07 are resolved. Four optional nits
were accepted without another review as permitted: safe feed author-name fields
(SC-08), poll-only first slice and separate push privacy review (SC-09), no-index
requests covering feed URLs too (SC-10), and explicit publication-editor additions
versus future derived scope (SC-11). Usage was not returned. This approval covers
planning prose, not implementation or public exposure.

## Unified sources, sign-in, and administration review

Claude Opus 5.5 (`claudeAgent`, effort `high`), round 1: **CHANGES**, eight should
findings and one nit, no blockers. Scope: the shared RSS gateway, coherent source
workflow, private-data policy, external authentication, and administrator tooling.
The reviewer made no edits; runtime behavior was not tested and usage was not returned.

| ID | Severity | Disposition |
| --- | --- | --- |
| UA-01 | should | Accepted: connector policy cannot delete/expire/rewrite kept snapshots; incompatible providers or Keep are unsupported, emitted content enforces capability limits |
| UA-02 | should | Accepted: staging backpressure, product-seen GUID acknowledgment before eviction, bounded eviction with visible gap, prove identity path before private connectors ship |
| UA-03 | should | Accepted: no concealed upstream failures; shared health primary, engine errors secondary; UA-10 distinguishes permitted staged delivery from failed refresh |
| UA-04 | should | Accepted: dedicated authenticated internal feed-only listener, no product/admin/worker routes or public proxy routing on engine egress exception |
| UA-05 | should | Accepted: private policy covers native feeds too; no initial provider-password Basic auth, capability URLs treated as secrets, redacted exports require reconnect and private sources excluded from publication |
| UA-06 | should | Accepted: operator-registered or supported public clients for self-hosting, no bundled confidential client secret or unreviewed relay; unsupported/hosted-only restrictions visible |
| UA-07 | should | Accepted: origin-independent recovery and origin-change warnings/callback reconfiguration without disabling authentication |
| UA-08 | should | Accepted: offer independent recovery at signup, evidence-based admin-assisted recovery with step-up/audit/notice/delay, no direct identity rebinding |
| UA-09 | nit | Accepted: self-host Accounts limited to the owner until multi-user scope is approved |

Focused round 2: **CHANGES**, UA-01–UA-09 resolved, two new should findings and two
nits, no blockers. The same model/effort reviewed the prose without edits or runtime
tests. Usage was not returned.

| ID | Severity | Disposition |
| --- | --- | --- |
| UA-10 | should | Accepted: temporary upstream outage can drain authorized unacknowledged staging while degraded health stays visible; authorization loss still blocks; add outage-beyond-bound test |
| UA-11 | should | Accepted: export/restore rulebook excludes capability URLs/grants/gateway credentials and pauses private-source restore for reconnection; domain identity is opaque, not a secret URL |
| UA-12 | nit | Accepted: known-pattern/credential-like URL checks plus owner privacy selection; uncertain locations redacted and not automatically public, no claim of perfect detection |
| UA-13 | nit | Accepted: acknowledge only after durable commit through authenticated control path, never engine listener; separate single-owner host recovery from hosted/multi-user support recovery |

Focused round 3: **APPROVE**. UA-10–UA-13 are resolved; no blocker or should findings
remain. Three optional wording nits were accepted without reopening the design:
token expiry during a transient refresh outage is not confirmed grant loss (UA-14),
source status explicitly names last provider success rather than delivery (UA-15),
and item/enclosure URLs follow the same secret classification/redaction/exclusion
rules as feed URLs (UA-16). Private exports keep the existing stronger rule of no
credential export and explain redacted links, rather than implicitly permitting
working secret links with only a warning. No findings were rejected.

The same model/effort reviewed the prose read-only; it did not rerun the lead's
checks and usage was not returned. Lead checks: `npm run check`, all five
scaffold-validator tests, and whitespace checks pass. Approval covers planning prose
only. Provider APIs, private RSS transport, acknowledgment identity, auth/recovery,
and administrator controls remain unproven until their implementation gates pass.
No implementation, exposure, or deployment is authorized by this verdict.
