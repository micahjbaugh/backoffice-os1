// Realistic provider payloads, shaped like the providers' real deliveries (Twilio messaging webhooks
// are form-encoded with these parameter names; Vapi server messages are JSON `{ message: {...} }`).
// The Twilio signing helper is validated against Twilio's published example in twilio.test.ts.

import { createHmac } from "node:crypto";

// Built at runtime so no credential-shaped literal is committed (GitHub push protection).
export const TWILIO_ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
export const TWILIO_AUTH_TOKEN = "twilio-auth-token-for-tests-0001";
export const TWILIO_WEBHOOK_URL = "https://app.example.com/api/webhooks/sms";
export const BUSINESS_NUMBER = "+15125550100";
export const CUSTOMER_NUMBER = "+15125550142";
export const MESSAGE_SID = "SM9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";
export const OUTBOUND_MESSAGE_SID = "SMaa11bb22cc33dd44ee55ff66aa77bb88";

export function twilioSign(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function twilioRequest(
  params: Record<string, string>,
  opts: { query?: string; token?: string; idempotencyToken?: string } = {},
) {
  const url = `${TWILIO_WEBHOOK_URL}${opts.query ?? ""}`;
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": twilioSign(opts.token ?? TWILIO_AUTH_TOKEN, url, params),
  });
  if (opts.idempotencyToken) headers.set("i-twilio-idempotency-token", opts.idempotencyToken);
  // The app may sit behind a proxy: the request arrives on an internal host.
  return {
    rawBody: new URLSearchParams(params).toString(),
    headers,
    url: `http://internal:3000/api/webhooks/sms${opts.query ?? ""}`,
  };
}

export const twilioInboundSms = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  ToCountry: "US",
  ToState: "TX",
  SmsMessageSid: MESSAGE_SID,
  NumMedia: "0",
  ToCity: "AUSTIN",
  FromZip: "78701",
  SmsSid: MESSAGE_SID,
  FromState: "TX",
  SmsStatus: "received",
  FromCity: "AUSTIN",
  Body: "Me Jake Tyler 7-5:30 Wilson. Hoe 8 hrs",
  FromCountry: "US",
  To: BUSINESS_NUMBER,
  ToZip: "78701",
  NumSegments: "1",
  MessageSid: MESSAGE_SID,
  AccountSid: TWILIO_ACCOUNT_SID,
  From: CUSTOMER_NUMBER,
  ApiVersion: "2010-04-01",
  ...overrides,
});

export const twilioStatusCallback = (
  status: string,
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  SmsSid: OUTBOUND_MESSAGE_SID,
  SmsStatus: status,
  MessageStatus: status,
  To: CUSTOMER_NUMBER,
  MessageSid: OUTBOUND_MESSAGE_SID,
  AccountSid: TWILIO_ACCOUNT_SID,
  From: BUSINESS_NUMBER,
  ApiVersion: "2010-04-01",
  ...overrides,
});

export const VAPI_WEBHOOK_SECRET = "vapi-webhook-secret-for-tests-01";
export const VAPI_CALL_ID = "4b8f3c2e-1d9a-4e7b-9c6f-2a1b3c4d5e6f";
export const VAPI_PHONE_NUMBER_ID = "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b";

export function vapiRequest(message: Record<string, unknown>, secret = VAPI_WEBHOOK_SECRET) {
  return {
    rawBody: JSON.stringify({ message }),
    headers: new Headers({ "content-type": "application/json", "x-vapi-secret": secret }),
    url: "http://internal:3000/api/webhooks/voice",
  };
}

const vapiCall = {
  id: VAPI_CALL_ID,
  orgId: "vapi-org-1",
  type: "inboundPhoneCall",
  phoneNumberId: VAPI_PHONE_NUMBER_ID,
  customer: { number: CUSTOMER_NUMBER },
  status: "in-progress",
};

/** Fixture clock: the call rings at T0 and ends 5 minutes later. */
export const T0 = 1_790_000_000_000;
const isoAt = (ms: number) => new Date(ms).toISOString();

export const vapiStatusUpdate = (status: string, timestamp = T0) => ({
  type: "status-update",
  status,
  timestamp,
  call: vapiCall,
  phoneNumber: { id: VAPI_PHONE_NUMBER_ID, number: BUSINESS_NUMBER },
  customer: { number: CUSTOMER_NUMBER },
});

export const vapiEndOfCallReport = () => ({
  type: "end-of-call-report",
  endedReason: "customer-ended-call",
  timestamp: T0 + 300_000,
  call: vapiCall,
  phoneNumber: { id: VAPI_PHONE_NUMBER_ID, number: BUSINESS_NUMBER },
  customer: { number: CUSTOMER_NUMBER },
  startedAt: isoAt(T0),
  endedAt: isoAt(T0 + 300_000),
  durationSeconds: 300,
  summary: "Caller asked for a quote to grade a 200 ft driveway.",
  analysis: { summary: "Caller asked for a quote to grade a 200 ft driveway." },
  artifact: {
    transcript:
      "AI: Thanks for calling Acme Excavation.\nUser: I need a quote for grading a driveway.",
    recordingUrl: "https://storage.vapi.ai/recordings/4b8f3c2e.wav",
  },
});

export const vapiAssistantRequest = () => ({
  type: "assistant-request",
  timestamp: T0 - 10_000,
  call: vapiCall,
  phoneNumber: { id: VAPI_PHONE_NUMBER_ID, number: BUSINESS_NUMBER },
  customer: { number: CUSTOMER_NUMBER },
});

export const vapiToolCalls = (
  toolCallList: { id: string; name: string; arguments: Record<string, unknown> }[],
  timestamp = T0 + 5_000,
) => ({
  type: "tool-calls",
  timestamp,
  call: vapiCall,
  phoneNumber: { id: VAPI_PHONE_NUMBER_ID, number: BUSINESS_NUMBER },
  customer: { number: CUSTOMER_NUMBER },
  toolCallList: toolCallList.map((t) => ({
    id: t.id,
    type: "function",
    function: { name: t.name, arguments: t.arguments },
  })),
});
