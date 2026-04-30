import { createHash } from "node:crypto";
import {
  verifyLarkCardActionSignature,
  verifyLarkWebhookSignature
} from "../../src/utils/larkSignature";

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

function signCardAction(input: {
  timestamp: string;
  nonce: string;
  body: unknown;
  verificationToken: string;
}) {
  return createHash("sha1")
    .update(input.timestamp + input.nonce + input.verificationToken + JSON.stringify(input.body))
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

describe("verifyLarkCardActionSignature", () => {
  it("accepts a matching legacy card-action sha1 signature", () => {
    const input = {
      timestamp: "1234567890",
      nonce: "nonce-test",
      body: {
        action: {
          value: {
            confirmation_id: "conf_test",
            action: "confirm"
          }
        }
      },
      verificationToken: "verification-token"
    };

    expect(
      verifyLarkCardActionSignature({
        ...input,
        signature: signCardAction(input)
      })
    ).toBe(true);
  });

  it("rejects missing or mismatched legacy card-action signatures", () => {
    const input = {
      timestamp: "1234567890",
      nonce: "nonce-test",
      body: {
        action: {
          value: {
            confirmation_id: "conf_test",
            action: "confirm"
          }
        }
      },
      verificationToken: "verification-token"
    };

    expect(verifyLarkCardActionSignature(input)).toBe(false);
    expect(
      verifyLarkCardActionSignature({
        ...input,
        signature: "bad-signature"
      })
    ).toBe(false);
  });
});
