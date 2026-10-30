import crypto from "crypto";
import { argon2id } from "hash-wasm";

/**
 * Standard OWASP-recommended parameters for Argon2id hashing:
 * - memorySize: 65536 KB (64 MB)
 * - iterations: 3 passes
 * - parallelism: 1 thread
 * - hashLength: 32 bytes (256-bit key output)
 */
const ARGON2_CONFIG: {
  iterations: number;
  memorySize: number;
  hashLength: number;
  parallelism: number;
} = {
  iterations: 3,
  memorySize: 65536,
  hashLength: 32,
  parallelism: 1,
};

// Cryptographically secure salt for Safe Key derivation
const SAFE_KEY_SALT = new Uint8Array(Buffer.from("scriptrunner-safekey-salt-2026"));

// Canonical Argon2id hash of normalized "FEAR GOD"
const envHash = (process.env.SAFE_KEY_ARGON2ID_HASH || "").replace(/^["']|["']$/g, "").trim();
export const CANONICAL_SAFE_KEY_ARGON2ID_HASH =
  (envHash.startsWith("$argon2id$") ? envHash : null) ||
  "$argon2id$v=19$m=65536,t=3,p=1$c2NyaXB0cnVubmVyLXNhZmVrZXktc2FsdC0yMDI2$nR3Gf+hvC5UFT01lWawGxC+C4FrzPozZI9gXsnZMGxQ";

/**
 * Verifies whether the supplied emergency safe key matches the Argon2id hash.
 * Uses constant-time comparison to protect against timing attacks.
 */
export async function verifySafeKey(providedKey: string): Promise<boolean> {
  if (!providedKey || typeof providedKey !== "string") {
    return false;
  }

  // Canonicalize: trim whitespace and normalize casing
  const normalized = providedKey.trim().toUpperCase();

  try {
    const computedHash = await argon2id({
      password: normalized,
      salt: SAFE_KEY_SALT,
      ...ARGON2_CONFIG,
      outputType: "encoded",
    });

    const expectedBuffer = Buffer.from(CANONICAL_SAFE_KEY_ARGON2ID_HASH);
    const computedBuffer = Buffer.from(computedHash);

    if (expectedBuffer.length !== computedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
  } catch (err) {
    console.error("Argon2id Safe Key verification error:", err);
    return false;
  }
}

/**
 * Hashes an arbitrary password using Argon2id with a cryptographically secure random 16-byte salt.
 */
export async function hashPasswordArgon2id(password: string): Promise<string> {
  const randomSalt = new Uint8Array(crypto.randomBytes(16));
  return await argon2id({
    password,
    salt: randomSalt,
    ...ARGON2_CONFIG,
    outputType: "encoded",
  });
}

/**
 * Verifies a password against an RFC-compliant encoded Argon2id string.
 */
export async function verifyPasswordArgon2id(
  password: string,
  encodedHash: string
): Promise<boolean> {
  try {
    // Encoded format: $argon2id$v=19$m=65536,t=3,p=1$<b64salt>$<b64hash>
    const parts = encodedHash.split("$");
    if (parts.length < 6 || parts[1] !== "argon2id") {
      return false;
    }

    const paramsPart = parts[3];
    const saltB64 = parts[4];

    let memorySize = ARGON2_CONFIG.memorySize;
    let iterations = ARGON2_CONFIG.iterations;
    let parallelism = ARGON2_CONFIG.parallelism;

    for (const param of paramsPart.split(",")) {
      const [k, v] = param.split("=");
      if (k === "m") memorySize = parseInt(v, 10);
      if (k === "t") iterations = parseInt(v, 10);
      if (k === "p") parallelism = parseInt(v, 10);
    }

    const salt = new Uint8Array(Buffer.from(saltB64, "base64"));
    const computedHash = await argon2id({
      password,
      salt,
      iterations,
      memorySize,
      hashLength: ARGON2_CONFIG.hashLength,
      parallelism,
      outputType: "encoded",
    });

    const expectedBuffer = Buffer.from(encodedHash);
    const computedBuffer = Buffer.from(computedHash);

    if (expectedBuffer.length !== computedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
  } catch (err) {
    console.error("Argon2id password verification error:", err);
    return false;
  }
}
