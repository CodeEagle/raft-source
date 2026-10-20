/** Metadata only: never include a secret value in this protocol. */
export const SECURE_INPUT_CAPABILITY = "secure-input:native-file-v1";
export interface SecureInputRequest {
  operation?: "collect" | "revoke"; requestId: string; ownerUserId: string; agentId: string; agentName: string; name: string; ttlSeconds: number;
}
export type SecureInputResult =
  | { status: "stored"; requestId: string; path: string; expiresAt: string }
  | { status: "revoked" | "cancelled" | "unsupported" | "busy" | "failed"; requestId: string };
