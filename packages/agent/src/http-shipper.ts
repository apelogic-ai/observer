/**
 * HTTP shipper — POSTs batches to the centralized ingestor API.
 */

import { randomBytes } from "node:crypto";
import type { ShippedBatch } from "./shipper";
import type { Keypair } from "./identity";
import { signPayload, getPublicKeyFingerprint } from "./identity";

export interface HttpShipperConfig {
  endpoint: string;
  apiKey?: string;
  keypair?: Keypair;
  timeoutMs?: number;
}

/**
 * Create a ship function that POSTs batches to the ingestor endpoint.
 */
export function createHttpShipper(
  config: HttpShipperConfig,
): (batch: ShippedBatch) => Promise<void> {
  const timeout = config.timeoutMs ?? 30_000;

  return async (batch: ShippedBatch): Promise<void> => {
    const body = JSON.stringify(batch);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
    if (config.keypair) {
      // Replay protection (OBS-005). Bind the signature to a
      // timestamp and a fresh nonce so a captured POST can't be
      // resubmitted by an attacker. The signed payload is the
      // canonical string `${timestamp}.${nonce}.${body}` — the
      // server reconstructs the same string and refuses the request
      // outside ±5min or with a duplicate nonce.
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString("hex");
      const canonical = `${timestamp}.${nonce}.${body}`;
      headers["X-Observer-Timestamp"] = timestamp;
      headers["X-Observer-Nonce"] = nonce;
      headers["X-Observer-Signature"] = signPayload(canonical, config.keypair);
      headers["X-Observer-Key-Fingerprint"] = getPublicKeyFingerprint(
        config.keypair.publicKeyPem,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Ingestor returned ${response.status}: ${body.slice(0, 200)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
