# Olympus reviewer demo data (synthetic)

Everything in this folder is made up. Robin Vale, Priya Vale, Sam Okafor and
every other person, business, address, amount and booking here are fictional.
Email addresses use the reserved `example.com`, `example.net` and
`example.org` domains. The "passwords" and "recovery codes" are labelled
fakes. Nothing here came from a real mailbox or drive.

This is the only data the reviewer demo engine may hold. The demo engine is
the one install where `remote.demoConsent` may be on, and its data directory
carries the demo marker (`src/core/remote-access.ts`, `DEMO_INSTALL_MARKER_TEXT`).

## The person

Robin Vale rents a flat at 14 Larch Court with their partner Priya. This
autumn they are renewing the lease, renovating the kitchen, planning a trip
to Lisbon, hosting a book club and running a library workshop. Robin also has
a clinic visit, blood test results, a bank overdraft notice and tax notes:
these are the Private items, there to show that Olympus keeps their contents
out of ChatGPT and answers from them only in the private answer panel.

## Files and intended tiers

Olympus decides each item's tier itself. The "intended" column is what the
demo is built to show; check it on the demo engine before submission
(`chatgpt-plugin/SUBMISSION.md`, pre-submission checklist). The demo engine
is a fresh install, so it has three tiers (Personal, Private, Secret): the
newsletter and the bylaws are general reference material, which a fresh
install keeps as Personal (there is no Public tier).

| File | Kind | Intended tier | Used by test case |
|---|---|---|---|
| `mail/001-sam-lease-renewal.eml` | mail | Personal | P1 |
| `mail/002-sam-lease-followup.eml` | mail | Personal | P1 |
| `mail/003-dentist-appointment.eml` | mail | Personal | P2 |
| `mail/004-garden-newsletter.eml` | mail | Personal (reference) | - |
| `mail/005-priya-budget.eml` | mail | Personal | P3 |
| `mail/006-contractor-quote.eml` | mail | Personal | P3 |
| `mail/007-flight-confirmation.eml` | mail | Personal | - |
| `mail/008-lab-results.eml` | mail | Private (health) | N1 |
| `mail/009-bank-notice.eml` | mail | Private (money) | - |
| `mail/010-book-club-reminder.eml` | mail | Personal | - |
| `mail/011-library-events.eml` | mail | Personal | - |
| `notes/2026-08-14-garden-plan.md` | note | Personal | - |
| `notes/2026-09-02-budget-decision.md` | note | Personal | P3 |
| `notes/2026-09-10-book-club.md` | note | Personal | - |
| `notes/2026-09-18-lisbon-itinerary.md` | note | Personal | - |
| `notes/2026-09-20-clinic-visit.md` | note | Private (health) | N1 |
| `notes/2026-09-24-ideas-workshop.md` | note | Personal | - |
| `notes/old-router-recovery.md` | note | Secret | - |
| `notes/reading-list.md` | note | Personal | - |
| `docs/lease-summary.md` | document | Personal | P1 |
| `docs/kitchen-renovation-plan.md` | document | Personal | P3 |
| `docs/household-budget-2026.csv` | document | Personal | - |
| `docs/garden-bylaws.md` | document | Personal (reference) | - |
| `docs/insurance-claim.md` | document | Private (health, money) | - |
| `docs/tax-notes-2025.md` | document | Private (money) | - |

Mail is stored as plain-text `.eml` files so the demo needs no mail account.
How the demo engine ingests them (as local files, or through a mail source)
is still to be settled [CONFIRM]; the answers in the test cases do not depend
on it.

## Keeping it small

25 data files plus this README. Add an item only when a test case needs it,
and keep every addition obviously fictional.
