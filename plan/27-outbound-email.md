# Outgoing email

The owner decided (2026-11-05) that the server needs outgoing email for account management:
required for the official hosted service, fully optional for self-hosters and not recommended to
them (no nagging; everything works without it). This document records the build decisions.

## Where email is used

| Moment | Who | What is sent |
| --- | --- | --- |
| An administrator makes an invitation and types an address | Any installation with email set up | The invitation link; the address is used for that one message and not stored |
| Open sign-up | Hosted, where an address is required | A link to confirm the new account's address |
| Adding or changing the address (*Settings → Security*, needs a recent sign-in) | Any installation with email set up | A confirmation link to the new address; a notice to the old confirmed one, naming the new one masked |
| *Forgot your password?* | Any installation with email set up; accounts with a password and a confirmed address | A single-use reset link (one hour) |
| A password reset with that link | Any installation with email set up | A notice that the password changed. The account is signed out everywhere: sessions, connected apps, pending connection codes, assistant tokens, OAuth grants and email links not used yet (`auth/sign-out.ts`) |
| `cli.ts test-email <address>` | Operator | A test message |

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Library | nodemailer 10.3.1, pinned exactly; no other new dependency | Maintained, no dependencies of its own, MIT-0; SMTP is not something to hand-write |
| Configuration | `PURSS_SMTP_HOST`, `_PORT`, `_SECURITY` (`starttls` default, `tls`, `none`), `_USER`, `_PASSWORD`, `PURSS_MAIL_FROM`, passed through Compose; documented only in the self-hosting reference | Optional and neutral for self-hosters; STARTTLS is required by default rather than opportunistic |
| Hosted open sign-up | Open only when configured open, in hosted mode, and the last mail server check passed; the API checks at start and every 10 minutes while failing, logs why sign-up is closed, and shows the state under *Administration → Health* | "Refuse to enable hosted open signup without working SMTP"; a configured but broken server counts as not working |
| Account address | `accounts.email` plus `email_verified_at`; every account has one and signs in with it, one account per address (`accounts_email`, compared without regard to case). Where a mail server is set up (`accountEmailAvailable`) an address is proven by a link: open sign-up starts with the address and makes the account only with its link (`signup_requests`); an invitation's code is emailed only to the address the administrator typed (`invites.emailed_at`; one that can't be sent is withdrawn), which confirms it; a new address takes effect only once confirmed. Without a mail server the administrator makes every account, so addresses are taken as typed | Owner decision: the address is the sign-in identity, and verification keeps bulk or spam accounts from being made with addresses nobody controls. plan/21: the internal account id stays the key; the address never links accounts or grants the administrator role |
| Links | 32-byte random tokens, only SHA-256 stored (`email_tokens`, `signup_requests`), single use, tied to the address they were sent to (a later address change voids them); sign-up and confirmation 48 hours, reset one hour; a new link replaces older unused ones; sign-up sends one address at most three messages an hour | Credentials, treated like invitation codes |
| Reset scope | Only active, non-administrator accounts that have a password and a confirmed address; the address stays; the account is signed out everywhere, its assistant tokens revoked, and the address told | A mailbox is weaker proof than a passkey; administrators, and servers without email, use the operator's audited `password-reset-link` (plan/21), the same kind of reset link made at the server: it is single use, valid for 60 minutes, tied to no address, and works whether or not email is set up |
| Enumeration | `/api/password-reset` and `/api/signup/start` always answer the same and send after the response; starting sign-up with an address that has an account sends it a note with sign-in and reset links instead of a sign-up link. Reset is limited per network address (10 an hour), per email address (5) and per account (3 links an hour) | Whether an address has an account stays private |
| Delivery | Messages sent after the response (sign-up, confirmation, reset, notices) are first written to `mail_queue`, sealed with AES-256-GCM under a key in the secrets folder (`mail-queue-key`, made at startup: a secrets folder where it can't be made stops the server with the reason, so queueing after a committed change can't fail), then sent at once by the API. Started without email set up, the server drops what is still queued, logs each as failed (`unconfigured`) and says how many. One the server can't take yet (down, or the process stopped) is retried by the maintenance tick, after a restart too, from 30 seconds doubling to 15 minutes, for up to a day; a refused one is dropped. Shutdown gives sends in flight ten seconds and leaves the rest queued. Invitations and the test message are sent while the person waits | A restart never drops a reset link; the database alone never holds a usable link; no worker or broker needed |
| Send log | `mail_log`: kind, masked recipient (`a•••@example.com`), outcome, error code (`EAUTH 535`); no body, subject or link; purged after 90 days. Audit events mask addresses too | "A send log without message bodies"; operators can diagnose without keeping addresses |
| Messages | Plain text plus simple HTML with the same words, in the product's plain language; nothing a person typed appears except the recipient's own address | No injection through display names or notes |
| Account deletion | Asking to delete ends unused email links (`auth/sign-out.ts`); a reset link still works in the grace period and is refused once removal starts. Removal deletes the account's email links and queued mail, clears its address, and keeps its `mail_log` lines without the account id | Nothing of the address outlives the account except masked log lines |

## Open questions for the owner

- Should a new hosted account be usable before its address is confirmed? Built: yes; an
  unconfirmed address only can't receive reset links. Requiring confirmation first is a small
  change in the sign-up route.
- Email-based password reset is a self-service recovery path wherever email is set up (plan/21
  asks for a reviewed policy). It needs the owner's review before hosted launch.

## Not built

Bounce and complaint handling, DKIM/SPF guidance beyond "the server must allow the sender",
sending through an HTTP mail API, digests or notifications by email, email changes confirmed from
the old address before they take effect, and adding a password to a passkey-only account by email.
