# Text invoice app: product plan

*Draft, updated 2026-09-27. Coding plan: `TEXT_INVOICE_BUILD.md`. Launch steps are kept outside the repo. Working name only. A spin-off of Back Office OS, sold through social media ads. No repo changes yet.*

## The pitch

**"Text the job. Get paid."** A one-person trade texts what they did, and a professional invoice with a pay link goes to their customer. Reminders chase late payers. No app to download, no office.

**Positioning against Square:** Square sends invoices. **We get you paid and get you the next job.** Square is a tool you operate; this works for you without being asked.

**Ad line:** "Never forget to bill. Never chase a payment. Get reviews on autopilot."

**Who it's for:** solo and 2-3 person trades: handymen, cleaners, landscapers and lawn care, mobile mechanics, pressure washers, painters, pool service. They invoice from memory, a notebook or Venmo requests, and they get paid late.

## How it works

1. **Sign up from the ad.** Text START (or tap the ad's button). Send the business name and a logo photo if they have one. Tap a link to connect payouts through Stripe, about 5 minutes. Until then, invoices can say "pay by check or cash."
2. **Invoice by text or voice memo.** "Invoice Ann Wilson 555-123-4567, water heater swap, $450."
3. **Preview, then YES.** "Invoice #1042 to Ann Wilson: water heater swap $450. Total $450. Reply YES to send, or tell me what to change." Nothing goes out without YES, and replying YES twice never sends it twice.
4. **Customer gets it** (see "Sending" below) with a pay page for card, bank transfer or Apple/Google Pay.
5. **Paid.** "Ann Wilson paid $450." The money lands in their bank on Stripe's normal schedule.
6. **Late.** Polite reminders at 3, 7 and 14 days. "Stop reminding Wilson" turns them off. "Wilson paid cash" marks it paid.
7. **Ask anything.** "Who owes me?", "What did I make in May?", "Resend Wilson's invoice."

**Later:** estimates that turn into invoices, repeat invoices (weekly lawn care), deposits, a year-end export for taxes.

## How we beat Square

Things a free invoice tool doesn't do. The first three are in the ads; ★ marks what ships at launch.

| # | Feature | What it looks like |
|---|---|---|
| 1 ★ | **Never forget to bill** | At 6pm (their choice of time): "Did you do any jobs today you haven't billed?" Reply "Wilson gutters 175" and it's invoiced. Forgotten invoices are the biggest leak for solo trades, and Square can't know about a job nobody entered. |
| 2 ★ | **Chase like a person** | Customer replies go to us, not a dead end. "Can I pay Friday?" → it records the promise, reminds her Friday, and tells the tradesperson. "I already paid" or "the price is wrong" goes straight to the tradesperson, never argued by the AI. |
| 3 ★ | **Reviews after payment** | "Thanks for paying! Mind leaving Mike a Google review? [link]" Once per customer, off by default for anyone who complained. |
| 4 ★ | **Invoice from whatever's handy** | Voice memo, a photo of the parts receipt (parts added at their usual markup, which they set once), before-and-after photos attached as proof of work. |
| 5 | **Knows their prices** | "Gutter clean for Wilson, same as last time" works. Flags when a price is well under their usual: "You usually charge $175 for gutters. Send $125 anyway?" Suggests; never changes a price on its own. |
| 6 | **Brings back repeat work** | "Wilson's gutters were cleaned in April. Want me to text her about a fall cleaning?" Only sends when they say yes. |
| 7 | **Sets aside tax money** | Weekly: "You made $4,200 this week. Put about $1,000 aside for taxes." Quarterly estimated-tax reminders. A rough rule of thumb, not tax advice. |

Rules that apply to all of them: nothing goes to a customer without the tradesperson's YES (except reminders and review asks they turned on once), and nothing unclear is guessed.

## Customer info

The tradesperson only has to give **a phone number or an email**. Everything else is optional.

- **First time:** name and number in the text. We save the customer, so next time "Invoice Wilson $200" is enough.
- **Share a contact:** tap Share Contact on the phone and text it to us. No typing. This is the path we push in onboarding.
- **Photo or screenshot** of a work order or a text thread: we pull out the name and number and confirm them.
- **The customer fills in the rest** (email, billing address) on the pay page.
- **Never guess.** Two Wilsons: "Ann on Oak St or Tom?" A missing amount: "How much for the water heater?"

## Sending to the customer

| Way | Launch? | How |
|---|---|---|
| **Tap to send** | Yes, the default | We text back a link. Tapping it opens their own Messages app with the customer's number and a note already filled in ("Hi Ann, here's your invoice for $450: [link]"). They hit send. It comes from their real number, feels personal, and needs no carrier approval. |
| **Email** | Yes | Sent by us, from "Mike's Handyman via [app]," when they give an email address. |
| **Business number** | Paid add-on, after approval | We give them a local number as their business line and send automatically. Carriers require each business to register (small fee, days to weeks). The same number enables missed-call text-back ("Never miss a job"). |

Sending automatically from their existing cell number isn't possible without an app on their phone, and iPhones don't allow it at all. **Check the carrier registration rules before launch**; this is my current understanding, not confirmed.

## Business number add-on

A second phone number for their business that rings their cell, with an assistant behind it for anything they miss.

- **Setup:** they pick a local number in their area code by text. We run the carrier registration with their business name and tax ID, or their own name as a sole proprietor. While it's pending (days to a couple of weeks), invoices keep going by tap-to-send or email. They put the number on the truck, cards and Google listing.
- **Calls ring their cell** with a short "business call" whisper so they know it's a customer.
- **Missed call:** after about 20 seconds the caller gets a text: "Hi, this is Mike's Handyman, I'm on a job. What can I help with?" The AI gathers the details and texts Mike a summary: "New lead: Ann Wilson, leaking water heater, Oak St, wants this week."
- **Calling back from the business number:** they text "call Ann." We ring their cell, then connect Ann, who sees the business number.
- **Texts:** invoices, reminders and review asks go out from the business number. Billing replies ("Can I pay Friday?") are handled by the AI. Everything else is forwarded to their cell ("Ann Wilson: Can you come Tuesday?"), and their answer goes to Ann from the business number.
- **Existing numbers:** a landline or internet phone number can usually be moved over or text-enabled; a cell number on a carrier plan usually can't. To check.
- **Cost to us:** roughly $1-2/month for the number, a few cents a minute for forwarded calls, texts and a small registration fee (check against Twilio's current pricing). **Price: $15/month with about 300 minutes.**
- **Why it matters:** it's the only way "chase like a person" can read customer replies, and "Never miss a job" is an ad of its own. It's Back Office OS's call routing (CALL) and receptionist (M2) cut down for one person.

## Pricing

| Item | Price |
|---|---|
| Subscription | $29/month, 14-day free trial |
| Card payments | 3.5% + 30¢, paid by the tradesperson |
| Bank transfers | 1% |
| Business number add-on | $15/month with about 300 call minutes, includes missed-call text-back |

Keep it one clear rate with no surcharge on their customer: surcharge rules vary by state and aren't allowed on debit cards. For comparison, Square Invoices is free to use and charges only a card fee, so **our reason to pay $29 is money it finds: forgotten jobs billed, late payers chased to a promise, reviews and repeat work**. One recovered invoice a month pays for it. Check Square's, Jobber's and Invoice Simple's current rates before launch.

## Money per customer (estimates)

| | Monthly |
|---|---|
| Subscription | $29 |
| Payment margin (about 0.6% of card payments above Stripe's ~2.9% + 30¢; $8k invoiced by card) | about $48 |
| **Revenue** | **about $77** |
| SMS to and from the tradesperson (about 60 messages) | about $1 |
| AI parsing, voice memo transcription | under $1 |
| Email, hosting, database | under $0.50 |
| Stripe fee on the $29 subscription | about $1.15 |
| **Direct cost** | **about $3.50** |

The payment margin depends on how much they run through cards; a cleaner billing $2k a month adds only about $12. **Getting customers is the real cost:** ads for a $30 subscription often cost $50-150 per signup (rule of thumb, untested). With payment revenue, that pays back in about 1-3 months instead of 4-5.

## How it spins off the same code

**Reused:** the SMS adapter with idempotent webhooks, phone identity, per-organization isolation (RLS), the audit log, customer records, the clarification workflow (ask, don't guess), the approval pattern (the YES preview is an approval), and the jobs endpoint for scheduled reminders.

**New work:**
1. **Invoice model and numbering.** Overlaps with Back Office OS M4 (invoice drafts), so build it once for both.
2. **Payments adapter:** Stripe Connect (Express accounts), so Stripe handles identity checks, payouts and disputes.
3. **Hosted pay page:** branded, mobile first.
4. **Reminder schedule** and "mark paid" by text.
5. **Tap-to-send links** and an **email adapter.**
6. **Reading contacts and photos:** shared contact cards, and pictures of work orders.
7. **Self-serve signup and subscription billing.**
8. **Texting compliance:** opt-in, STOP/HELP, toll-free verification for our number, and later per-business registration for the add-on.
9. **The Square-beaters (launch set):** the daily "anything to bill?" nudge (Back Office OS's unbilled-work detector, M4), reading customer replies with promise-to-pay tracking (M6), the review ask, and parts-receipt photos with markup.
10. **After launch:** price memory, repeat-work prompts, tax set-aside.

Rough size: about one and a half milestones for the launch set, on top of production hardening. Items 9 and 10 are pulled forward from the Back Office OS plan, so they're shared work, not extra.

Customer replies only come to us when the invoice is sent from our number or email. With tap-to-send from their own phone, replies go to their phone as normal, and "chase like a person" works through the reminders we send by email or, with the add-on, from their business number.

## Launch plan

**Priority one, demand taken as given (2026-09-27).** Marketing to a waitlist starts now while the build runs; the system is designed for 100,000 paying customers. Build plan: `TEXT_INVOICE_BUILD.md`.

## Risks

- **Square is free.** The answer is selling results (bills found, payers chased, reviews) rather than invoices. The waitlist ads should try both angles to see which one pulls.
- **Nudges can annoy.** The daily text, reminders and review asks are all adjustable, with one-word replies to turn them off.
- **Payments bring disputes and fraud.** Stripe Connect Express puts most of this on Stripe, but we need terms of service and a way to freeze a bad account.
- **Scam look-alikes.** An invoice text from an unknown sender looks like phishing. Tap-to-send from their own number avoids that, which is another reason it's the default.
- **A wrong amount or customer is costly.** The YES preview and "never guess" rules are what stop it. Always show the total and the customer before sending.
- **Support at $29.** Onboarding and questions have to work by text with no person.
- **Focus.** This competes for build time with Back Office OS. Its invoice work carries over to M4, which softens that.

## The upsell

A solo tradesperson who grows to a crew is a Back Office OS customer: their customers, invoices and payment history are already in the system.
