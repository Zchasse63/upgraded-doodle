// HMAC-SHA256 verification of the PushPress webhook signature.
//
// Mirrors @pushpress/pushpress@1.15.0's webhook-security-custom.ts exactly.
// We don't import the SDK in the Edge Function (alpha + esm.sh dual-export
// resolution = unknown Deno cold-start failure mode; a cold-start failure
// means 500s on every webhook delivery until redeploy).
//
// Algorithm:
//   key     = UTF-8 bytes of the signing secret
//   message = UTF-8 bytes of JSON.stringify(parsedBody.data)  // NOT raw HTTP body
//   digest  = HMAC-SHA256(key, message)
//   sig     = lowercase hex of digest
// Compare with the value in the `webhook-signature` request header.

const ENC = new TextEncoder();

// Cache the imported HMAC key per signing-secret. The secret is constant for
// the isolate lifetime in production but may change between tests, so we key
// on the secret value rather than assuming a fixed one.
let _keyPromise: Promise<CryptoKey> | undefined;
let _keySecret: string | undefined;

function getHmacKey(signingSecret: string): Promise<CryptoKey> {
  if (_keySecret !== signingSecret) {
    _keySecret = signingSecret;
    _keyPromise = crypto.subtle.importKey(
      "raw",
      ENC.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return _keyPromise!;
}

export async function verifyPushPressSignature(
  parsedBody: { data: unknown },
  providedSignature: string,
  signingSecret: string,
): Promise<boolean> {
  if (!providedSignature || !signingSecret) return false;

  // Parse the provided hex up front. If it's not 64 chars of hex (= 32 bytes,
  // the SHA-256 output length), it can't possibly match — reject without
  // entering the crypto path. SHA-256 output length is a public fact, so this
  // early exit leaks nothing about the secret.
  const providedBytes = hexToBytes(providedSignature);
  if (!providedBytes || providedBytes.length !== 32) return false;

  try {
    const cryptoKey = await getHmacKey(signingSecret);
    const messageBytes = ENC.encode(JSON.stringify(parsedBody.data));
    const signatureBytes = await crypto.subtle.sign("HMAC", cryptoKey, messageBytes);
    return constantTimeBytesEqual(new Uint8Array(signatureBytes), providedBytes);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  const s = hex.toLowerCase();
  if (s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexNibble(s.charCodeAt(i * 2));
    const lo = hexNibble(s.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexNibble(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 87; // a-f (after toLowerCase)
  return -1;
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Both inputs are the fixed SHA-256 output length (32 bytes) — length
  // equality is established by the caller and is public information.
  let diff = a.length ^ b.length;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
