# Send back

Accepted product direction (2026-09-27). Built in milestone OWN; vendor outreach and price matching
are in M5. Every number below is a configurable default, not a universal business rule.

## What it is

A third action beside **Approve** and **Reject** on any request in the Owner Inbox. It means "not
yet, here's what I need." It has two forms:

- **Ask a question:** e.g. "Did you get quotes in the system first?" Goes to the requester.
- **Counter:** two numbers.
  - **Aim for:** the number the requester or AI opens with.
  - **Maximum authorized total:** the most the decision maker will pay, as a total delivered cost
    (price, freight, fees). It is internal: it is never revealed automatically to the requester's
    counterparty.

Quick picks keep typing rare: "Did you price it in the system?", "Get another quote", "Try for a
lower price", "Not now, ask again on [date]", "Something else…".

## Who can send back

- Anyone authorized to decide a request can send it back.
- Office admins may **ask** on any request they can access, but may **counter** only within their
  own approval authority. Anyone may ask; only people who could approve may counter.

## Where it goes

- Always to the original **human requester**. If AI transcribed an employee's text into the request,
  the employee remains the requester.
- If the request came in by SMS, the send-back goes out by SMS from the business number (subject to
  messaging preferences, quiet hours and delivery rules), with a short reference code, e.g.
  "Micah sent back 'Mini-excavator $38,500': Try offering $34,000. Reply here or tap [link]".
  Otherwise in the app, plus a text if the person has a phone on file.
- If an AI workflow made the request, the workflow receives it.
- **Vendor outreach is a separate authorized action** (M5), not part of Send back.
- Replies are matched to the right request by reference code. An ambiguous reply (e.g. two open
  send-backs) gets a clarifying question, never a guess. Any change to price or terms comes back
  through a signed link, not a text reply alone.

## Rounds, revisions and history

- Up to **two** rounds of back-and-forth, then the request returns to an authorized decision maker
  for a yes or no.
- The original request is never edited (decided approvals stay immutable). Each answer creates a
  **revision linked to the original**, shown side by side ("was $38,500, now $34,000, seller
  accepted").
- Every send-back, answer and decision is in the audit history.
- While waiting, the request moves from "Needs your decision" to **Waiting on them**.

## Conditional approval ("count it as approved if they accept")

On by default only for eligible counters with explicit terms. It must:

- stay within the sender's own authority;
- apply only to the same scope, quantity, quality, delivery, fees and other required terms;
- use a **total-cost ceiling**, not a unit price;
- require adequate **evidence** of the agreed offer (written quote, email, photo or call transcript;
  "they said yes" by text is not enough);
- expire at the earlier of the authorization expiry or the quote's expiry (default **3 days**);
- never activate for a simple question.

Anything outside those terms comes back to a decision maker.

## Authority

Authority to **negotiate**, to **accept an offer** and to **place an order** are separate
permissions. Equipment and capital purchases stay **draft-only** for negotiation at first and keep
their extra review requirements.

## Preferred vendors and price matching (M5)

- Compare equivalent **delivered** offers: price, freight, availability and terms.
- A preferred vendor may win an equivalent offer; the owner can set a premium they'll pay for
  reliability.
- Offer a preferred vendor one chance to match, when time allows. Skip it when urgency or quote
  expiry make delay inappropriate.
- Never disclose a competitor's identity automatically.
- The match window (10% suggested) and the AI's own negotiation limit ($2,500 suggested) are owner
  settings to validate, not fixed rules. Autonomous negotiation waits until intake, comparison,
  approval, ordering and delivery tracking are dependable.

## Not in the first version

Suggesting new purchasing rules from repeated send-back reasons (e.g. "require 2 quotes over
$1,000"), and a running "send-backs saved $X" total.
