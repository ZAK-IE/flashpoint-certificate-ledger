/**
 * Chain primitives.
 *
 * The canonical form defined here is the contract between the server and the
 * browser. public/ledger-core.js implements exactly the same two functions
 * against the Web Crypto interface, so any visitor can recompute every digest
 * for themselves and does not have to take the server's word for the chain.
 *
 * Canonical form of a block:
 *
 *   height \n sealedAt \n previousHash \n eventType \n canonicalJson(payload)
 *
 * sealedAt is always an Internet date and time string in Coordinated Universal
 * Time (UTC) with millisecond precision, for example 2026-09-15T08:12:33.123Z.
 * canonicalJson sorts object keys at every level so two equal payloads always
 * serialize to the same bytes.
 */

import crypto from "node:crypto";

export const GENESIS_PREVIOUS_HASH = "0".repeat(64);

export const EVENTS = {
  GENESIS: "GENESIS",
  ISSUED: "CERTIFICATE_ISSUED",
  RENEWED: "CERTIFICATE_RENEWED",
  REVOKED: "CERTIFICATE_REVOKED"
};

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function canonicalString(block) {
  return [
    String(block.height),
    block.sealedAt,
    block.previousHash,
    block.eventType,
    canonicalJson(block.payload)
  ].join("\n");
}

export function hashBlock(block) {
  return crypto.createHash("sha256").update(canonicalString(block), "utf8").digest("hex");
}

/** Timestamp in the exact shape the canonical form requires. */
export function sealTimestamp(date = new Date()) {
  return date.toISOString();
}
