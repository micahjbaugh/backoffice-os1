# Milestone 2 readiness — Communications Core

## Product and architecture to preserve

**You run the work. We run the office.** Back Office OS is a managed back office for small service businesses. Customers buy completed work, with a human backstop for exceptions.

Keep the modular monolith, shared Business Brain, tenant RLS, deterministic domain tools, explicit policy checks, approvals, append-only events/audit, and provider adapters. AI may request validated actions; prompts never grant authority. Preserve the roadmap for inbound phone, supplier-calling procurement, crew text/voice capture, revenue protection and text-to-invoice, AR/AP, payroll preparation, tax readiness, scheduling/dispatch, employee center, and human operations.

## Next implementation sequence

1. Define voice/SMS adapter contracts in `packages/integrations`, agent tool contracts in `packages/agents`, and deterministic processing in `packages/workflows`. Provider SDKs stay in adapters.
2. Inspect existing communication/lead/webhook tables before extending them. Add only new numbered migrations; every tenant record carries `organization_id`, with RLS and tenant-safe references.
3. Receive verified provider webhooks, resolve the tenant from trusted route configuration, persist the receipt, and deduplicate by provider event ID. Do not trust a tenant identifier supplied by a caller or model.
4. Store call metadata, disposition, permitted transcript/summary, and links to the customer/lead. Ambiguous caller matches create clarification or an ops case rather than silently linking records.
5. Implement bounded receptionist tools: permitted business information, draft lead creation, callback/task creation, and transfer requests. Prices and committed dates require configured authority.
6. Add reliable delivery for external actions, with idempotency keys, retry state, and an outbox where appropriate. Consume approval decisions once by stable event/approval identity.
7. Build human transfer and fallback behavior: no answer, provider failure, caller requests a person, or uncertain intake must produce an actionable ops case.
8. Exercise the full loop using fake leads and designated test phone numbers before any real customer rollout.

## Acceptance gate

- A test caller reaches the business number and hears the correct company identity.
- The agent qualifies a fake lead, uses only permitted tenant information, and creates one lead and call summary.
- Warm transfer succeeds; failed transfer produces a callback/task or ops case.
- Duplicate and out-of-order webhooks do not duplicate leads or external actions.
- Cross-tenant requests, invalid webhook signatures, unauthorized tools, and prompt-based attempts to change authority fail closed.
- Every call and consequential action has an attributable event/audit trail.
- Existing M1 tests and opt-in live-stack checks remain green.

## Decisions needed before connecting a paid provider

- Voice/SMS provider and test account; keep selection behind the adapter boundary.
- Dedicated test number and transfer destination.
- Initial business script, business hours, permitted FAQs, intake fields, and fallback response.
- Recording/transcript settings, disclosure, and retention configuration.

No paid provider, production number, real outbound call, or M2 application feature was configured during M1 verification.

## Remaining M1 limits

The original build report still documents production hardening: MFA/re-authentication, membership invitation/removal flows, pagination, additional rate limiting, least-privilege production DB credentials, organization-timezone-aware datetime inputs, and document storage uploads. Live local verification does not establish production readiness.
