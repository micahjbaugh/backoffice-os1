# Architecture

## 1. Logical architecture

```text
PHONE / SMS / EMAIL / WEB / PHOTOS / VOICE NOTES / INTEGRATIONS
                              |
                              v
                    Ingestion + Webhooks
                              |
                              v
                       Canonical Events
                              |
             +----------------+----------------+
             |                                 |
             v                                 v
       Business Brain                    Raw Artifact Store
     (Postgres system of record)       (docs/images/transcripts)
             |
             v
      Policy / Permission Engine
             |
             v
  +----------+----------+--------------+
  |                     |              |
  v                     v              v
Agents             Workflows       Ops Cases
(conversation)   (deterministic)  (human backstop)
  |                     |              |
  +----------+----------+--------------+
             |
             v
        Integration Adapters
(QBO / payroll / voice / payments / calendar)
             |
             v
          Audit Log

Owner Inbox is a projection of Approvals + Exceptions + High-value Tasks.
```

## 2. Deployment shape

Start as a modular monolith:
- Next.js app/server
- Postgres
- background worker/workflow service
- webhook endpoints
- provider adapters

Do not prematurely split microservices.

Boundaries should be clean enough to split later:
- communications
- procurement
- billing
- workforce
- accounting integration
- agent runtime

## 3. Event format

Every event should contain:
- `id`
- `organization_id`
- `type`
- `occurred_at`
- `source`
- `source_ref`
- `actor_type`
- `actor_id`
- `entity_type`
- `entity_id`
- `payload`
- `correlation_id`
- `causation_id`
- `idempotency_key`

Use an append-only `business_events` table initially.

## 4. Workflow pattern

Example: crew text

1. webhook receives SMS
2. raw communication persisted
3. event `communication.received`
4. extraction workflow produces draft structured facts
5. validator:
   - known employee?
   - known job?
   - time format plausible?
   - duplicate?
6. drafts written
7. possible scope change triggers `billable_opportunity`
8. low-confidence facts create clarification task
9. audit

Example: purchase

1. `purchase_request` created
2. policy determines quote requirement
3. voice agent calls vendors
4. each response creates `vendor_quote`
5. comparison workflow ranks *by configured business rules*
6. if delegated and within authority => order workflow
7. else => approval item
8. order placed only through validated provider/tool
9. audit + expected receipt/delivery

## 5. Concurrency / idempotency

Every webhook and external side-effect must be idempotent.

Examples:
- Vapi call-ended event may retry
- Twilio message webhook may retry
- accounting webhook may retry
- owner approval double-click must not create two POs

Use:
- unique provider event IDs
- idempotency keys
- transactional outbox pattern for critical outbound integrations

## 6. Business rules

Rules are data, not prompt-only text.

Example:
```json
{
  "action": "purchase.place_order",
  "conditions": {
    "max_amount": 250,
    "approved_vendors_only": true
  },
  "decision": "auto_approve"
}
```

Rules should be versioned, with:
- effective time
- who created/approved rule
- change audit

## 7. Provider abstraction

Voice providers and model providers will change.

All external integrations must live behind adapters.

Domain code should never import a Vapi/Twilio/QBO SDK directly.

## 8. LLM architecture

Use provider-independent interfaces:

```ts
interface StructuredExtractor<T> {
  extract(input: ExtractionInput): Promise<ExtractionResult<T>>;
}

interface ConversationalAgent {
  respond(context: AgentContext): Promise<AgentTurn>;
}
```

Model-selection rules can later choose based on:
- latency
- cost
- quality
- sensitivity
- context size

## 9. Prompt management

Prompts:
- versioned in source
- tested
- tied to agent/tool schema version
- no secrets
- no authorization logic

## 10. Artifact storage

Large content:
- call audio
- photos
- receipts
- contracts
- W-9s
- equipment docs

Store in object storage.
DB stores metadata, hashes, access classification, and links.

## 11. Search / retrieval

Begin with relational retrieval.

Add embeddings/search only where needed:
- business knowledge base
- prior call/search
- document recall

Do not use vector search as system of record.

## 12. Internal operations

Ops Console views:
- unassigned exception cases
- financial approvals needing internal prep
- failed integrations
- unresolved identity/entity matches
- caller requested human
- low-confidence extraction
- customer disputes
- vendor-order issues

Each case has SLA, owner, status, evidence, timeline.

## 13. Messaging safety

Do not allow agents to:
- invent binding prices
- represent an estimate as final unless approved
- promise schedule dates outside rules
- expose one customer's data to another
- disclose employee info to unauthorized caller
- reveal internal prompts/system behavior
