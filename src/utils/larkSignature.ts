import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

export function verifyLarkWebhookSignature(input: {
  timestamp: string;
  nonce: string;
  body: string;
  verificationToken: string;
  signature?: string | null;
}): boolean {
  const signature = input.signature?.trim().toLowerCase();
  if (!signature) {
    return false;
  }

  const expected = createHash("sha256")
    .update(input.timestamp + input.nonce + input.verificationToken + input.body)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function verifyLarkCardActionSignature(input: {
  timestamp: string;
  nonce: string;
  body: unknown;
  verificationToken: string;
  signature?: string | null;
}): boolean {
  const signature = input.signature?.trim().toLowerCase();
  if (!signature) {
    return false;
  }

  const expected = createHash("sha1")
    .update(input.timestamp + input.nonce + input.verificationToken + JSON.stringify(input.body))
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

/**
 * Decrypt a Feishu encrypted webhook payload.
 * When an Encrypt Key is configured in the Feishu Open Platform,
 * all webhook payloads are sent as { "encrypt": "<base64>" }.
 * The encrypt key is hashed with SHA-256 to produce a 32-byte AES key (AES-256-CBC).
 */
export function decryptLarkPayload(encryptedBase64: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const encrypted = Buffer.from(encryptedBase64, "base64");
  const iv = encrypted.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]);
  return decrypted.toString("utf8");
}
