/**
 * Identity — Ed25519 keypair generation, signing, and verification.
 *
 * Each observer agent installation generates a local keypair on init.
 * The public key is registered with the ingestor. Every shipped batch
 * is signed with the private key. The ingestor verifies the signature
 * against the registered public key.
 *
 * This provides:
 * - Non-repudiation: batch was signed by this specific installation
 * - Tamper detection: modified batch → broken signature
 * - No shared secrets: ingestor holds only public keys
 * - Revocation: deactivate one installation without rotating all keys
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign, verify, createHash, createPrivateKey, createPublicKey } from "node:crypto";

const PRIVATE_KEY_FILE = "observer.key";
const PUBLIC_KEY_FILE = "observer.pub";

export interface Keypair {
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Generate an Ed25519 keypair and save to the state directory.
 * No-op if the keypair already exists.
 */
export function generateKeypair(stateDir: string): void {
  const privPath = join(stateDir, PRIVATE_KEY_FILE);
  const pubPath = join(stateDir, PUBLIC_KEY_FILE);

  if (existsSync(privPath) && existsSync(pubPath)) {
    return; // already exists
  }

  mkdirSync(stateDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  writeFileSync(privPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath, publicKey);
}

/**
 * Load an existing keypair from the state directory.
 * Returns null if no keypair exists.
 */
export function loadKeypair(stateDir: string): Keypair | null {
  const privPath = join(stateDir, PRIVATE_KEY_FILE);
  const pubPath = join(stateDir, PUBLIC_KEY_FILE);

  if (!existsSync(privPath) || !existsSync(pubPath)) {
    return null;
  }

  return {
    privateKeyPem: readFileSync(privPath, "utf-8"),
    publicKeyPem: readFileSync(pubPath, "utf-8"),
  };
}

/**
 * Load a keypair, preferring the keychain when configured.
 *
 * Resolution order:
 *   1. keychain (if `keychainService` is set and a SecureStore is given)
 *   2. file-based (~/.observer/observer.key + observer.pub)
 *
 * Public key always comes from the .pub file — keychain stores only the
 * private half. Public is non-secret and the file form makes
 * `observer auth status`-style ergonomics free.
 */
export async function loadKeypairWithKeychain(
  stateDir: string,
  options: {
    keychainService?: string | null;
    account?: string;
    secureStore?: { get(service: string, account: string): Promise<string | null> } | null;
  } = {},
): Promise<Keypair | null> {
  const fileKeypair = loadKeypair(stateDir);

  if (options.keychainService && options.secureStore) {
    const fromKeychain = await options.secureStore.get(
      options.keychainService,
      options.account ?? "default",
    );
    if (fromKeychain) {
      // Public key still comes from the on-disk pub file (it's not
      // secret; keeps fingerprint display + registration simple).
      const pubPath = join(stateDir, PUBLIC_KEY_FILE);
      if (!existsSync(pubPath)) return null;
      return {
        privateKeyPem: fromKeychain,
        publicKeyPem: readFileSync(pubPath, "utf-8"),
      };
    }
  }

  return fileKeypair;
}

/**
 * Sign a payload string with the private key.
 * Returns a base64-encoded Ed25519 signature.
 */
export function signPayload(payload: string, keypair: Keypair): string {
  const privateKey = createPrivateKey(keypair.privateKeyPem);
  const sig = sign(null, Buffer.from(payload), privateKey);
  return sig.toString("base64");
}

/**
 * Verify a payload against a base64 signature and PEM public key.
 */
export function verifyPayload(
  payload: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Get a SHA-256 fingerprint of the public key (for display/registration).
 */
export function getPublicKeyFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex");
}
