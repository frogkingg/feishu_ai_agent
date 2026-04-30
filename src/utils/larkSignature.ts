import { createHash, timingSafeEqual } from "node:crypto";

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
