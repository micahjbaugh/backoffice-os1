export type UUID = string;

export type ActorType =
  | "user"
  | "agent"
  | "internal_operator"
  | "integration"
  | "system";

export type RiskClass = "green" | "yellow" | "red";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface TenantEntity {
  id: UUID;
  organizationId: UUID;
  createdAt: string;
  updatedAt: string;
}

export interface Approval extends TenantEntity {
  type: string;
  title: string;
  description?: string;
  status: ApprovalStatus;
  amountCents?: number;
  currency?: string;
  entityType?: string;
  entityId?: UUID;
  requestedByActorType: ActorType;
  requestedByActorId?: UUID;
  decidedByUserId?: UUID;
  decidedAt?: string;
  idempotencyKey: string;
}

export interface BusinessEvent {
  id: UUID;
  organizationId: UUID;
  type: string;
  occurredAt: string;
  source: string;
  sourceRef?: string;
  actorType: ActorType;
  actorId?: UUID;
  entityType?: string;
  entityId?: UUID;
  payload: Record<string, unknown>;
  correlationId?: UUID;
  causationId?: UUID;
  idempotencyKey?: string;
}
