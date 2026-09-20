/**
 * Browser verification.
 *
 * These three functions are a deliberate mirror of src/chain.js. They let the
 * page recompute every digest for itself using the browser's own cryptography,
 * so the integrity check shown in the interface is not the server marking its
 * own homework. If the server ever returned a block whose contents had been
 * changed, this code would catch it.
 */

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
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

export async function hashBlock(block) {
  const bytes = new TextEncoder().encode(canonicalString(block));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export const GENESIS_PREVIOUS_HASH = "0".repeat(64);

/** Recompute the whole chain in the browser. Returns one result per block. */
export async function verifyLocally(blocks) {
  const results = [];
  let intact = true;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const recomputed = await hashBlock(block);
    const contentsOk = recomputed === block.hash;
    const linkOk = i === 0
      ? block.previousHash === GENESIS_PREVIOUS_HASH
      : block.previousHash === blocks[i - 1].hash;
    if (!contentsOk || !linkOk) intact = false;
    results.push({ height: block.height, contentsOk, linkOk, recomputed });
  }
  return { intact, results, firstBreak: results.find(r => !r.contentsOk || !r.linkOk) || null };
}
