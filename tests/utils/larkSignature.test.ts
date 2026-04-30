import { createHash } from "node:crypto";
import { verifyLarkWebhookSignature } from "../../src/utils/larkSignature";

function sign(input: {
  timestamp: string;
  nonce: string;
  body: string;
  verificationToken: string;
}) {
  return createHash("sha256")
    .update(input.timestamp + input.nonce + input.verificationToken + input.body)
    .digest("hex");
}

describe("verifyLarkWebhookSignature", () => {
  it("accepts a matching Lark webhook signature", () => {
    const input = {
      timestamp: "1234567890",
      nonce: "nonce-test",
      body: '{"event":{"meeting_id":"om_test"}}',
      verificationToken: "verification-token"
    };

    expect(
      verifyLarkWebhookSignature({
        ...input,
        signature: sign(input)
      })
    ).toBe(true);
  });

  it("rejects missing or mismatched signatures", () => {
    const input = {
      timestamp: "1234567890",
      nonce: "nonce-test",
      body: '{"event":{"meeting_id":"om_test"}}',
      verificationToken: "verification-token"
    };

    expect(verifyLarkWebhookSignature(input)).toBe(false);
    expect(
      verifyLarkWebhookSignature({
        ...input,
        signature: "bad-signature"
      })
    ).toBe(false);
  });
});
