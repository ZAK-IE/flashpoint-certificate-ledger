/**
 * The ledger service.
 *
 * The blocks table is the single source of truth and is append only, enforced
 * by a database trigger as well as by this code. The certificate_state table
 * is nothing but a cached replay of the chain, kept so the tracking screens can
 * be answered with one query. It can be thrown away and rebuilt at any time
 * from the blocks alone, which is the point of POST /api/chain/rebuild.
 */

import { EVENTS, GENESIS_PREVIOUS_HASH, hashBlock, sealTimestamp } from "./chain.js";
import { SEALED_AT, query, withTransaction } from "./db.js";

const APPEND_LOCK = 902_610; // advisory lock so two writers cannot claim the same height

/* ------------------------------------------------------------------ append */

export async function appendBlock(client, { eventType, certificateNumber = null, instituteId = null, payload }) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [APPEND_LOCK]);

  const head = await client.query("SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1");
  const previous = head.rows[0] || null;

  const block = {
    height: previous ? previous.height + 1 : 0,
    sealedAt: sealTimestamp(),
    previousHash: previous ? previous.hash : GENESIS_PREVIOUS_HASH,
    eventType,
    payload
  };
  block.hash = hashBlock(block);

  await client.query(
    `INSERT INTO blocks (height, sealed_at, previous_hash, hash, event_type, certificate_number, institute_id, payload)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb)`,
    [block.height, block.sealedAt, block.previousHash, block.hash, eventType,
     certificateNumber, instituteId, JSON.stringify(payload)]
  );

  await applyToProjection(client, block);
  return block;
}

/* -------------------------------------------------------------- projection */

const CERT_COLUMNS = `certificate_number, holder_name, organization, course, course_date,
  completion_date, expiry_date, instructor, location, institute_id, status,
  issued_height, last_height, supersedes, superseded_by, revoked_reason, revoked_at`;

async function applyToProjection(client, block) {
  const p = block.payload;

  if (block.eventType === EVENTS.GENESIS) return;

  if (block.eventType === EVENTS.ISSUED || block.eventType === EVENTS.RENEWED) {
    await client.query(
      `INSERT INTO certificate_state (${CERT_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$11,$12,NULL,NULL,NULL)
       ON CONFLICT (certificate_number) DO UPDATE SET
         holder_name = EXCLUDED.holder_name,
         organization = EXCLUDED.organization,
         course = EXCLUDED.course,
         course_date = EXCLUDED.course_date,
         completion_date = EXCLUDED.completion_date,
         expiry_date = EXCLUDED.expiry_date,
         instructor = EXCLUDED.instructor,
         location = EXCLUDED.location,
         status = 'ACTIVE',
         last_height = EXCLUDED.last_height,
         supersedes = EXCLUDED.supersedes`,
      [p.certificateNumber, p.holderName, p.organization, p.course, p.courseDate,
       p.completionDate, p.expiryDate, p.instructor, p.location, p.instituteId,
       block.height, p.supersedes || null]
    );

    if (block.eventType === EVENTS.RENEWED && p.supersedes) {
      await client.query(
        `UPDATE certificate_state
            SET status = 'SUPERSEDED', superseded_by = $1, last_height = $2
          WHERE certificate_number = $3`,
        [p.certificateNumber, block.height, p.supersedes]
      );
    }
    return;
  }

  if (block.eventType === EVENTS.REVOKED) {
    await client.query(
      `UPDATE certificate_state
          SET status = 'REVOKED', revoked_reason = $1, revoked_at = $2::timestamptz, last_height = $3
        WHERE certificate_number = $4`,
      [p.reason, block.sealedAt, block.height, p.certificateNumber]
    );
  }
}

/** Throw away the cache and rebuild it from the chain. */
export async function rebuildProjection() {
  return withTransaction(async client => {
    await client.query("DELETE FROM certificate_state");
    const { rows } = await client.query(
      `SELECT height, ${SEALED_AT}, previous_hash AS "previousHash", hash,
              event_type AS "eventType", payload
         FROM blocks ORDER BY height ASC`
    );
    for (const row of rows) await applyToProjection(client, row);
    return { blocksReplayed: rows.length };
  });
}

/* ------------------------------------------------------------------ verify */

export async function readChain({ from = 0, limit = 1000 } = {}) {
  const { rows } = await query(
    `SELECT height, ${SEALED_AT}, previous_hash AS "previousHash", hash,
            event_type AS "eventType", certificate_number AS "certificateNumber",
            institute_id AS "instituteId", payload
       FROM blocks
      WHERE height >= $1
      ORDER BY height ASC
      LIMIT $2`,
    [from, Math.min(Number(limit) || 1000, 5000)]
  );
  return rows;
}

export async function verifyChain() {
  const blocks = await readChain({ from: 0, limit: 5000 });
  const results = [];
  let intact = true;

  blocks.forEach((block, i) => {
    const recomputed = hashBlock(block);
    const contentsOk = recomputed === block.hash;
    const linkOk = i === 0
      ? block.previousHash === GENESIS_PREVIOUS_HASH
      : block.previousHash === blocks[i - 1].hash;
    if (!contentsOk || !linkOk) intact = false;
    results.push({
      height: block.height,
      eventType: block.eventType,
      certificateNumber: block.certificateNumber,
      contentsOk,
      linkOk,
      storedHash: block.hash,
      recomputedHash: recomputed
    });
  });

  const firstBreak = results.find(r => !r.contentsOk || !r.linkOk) || null;
  return { intact, height: blocks.length, checkedAt: sealTimestamp(), firstBreak, blocks: results };
}

export async function chainHead() {
  const { rows } = await query(
    `SELECT height, ${SEALED_AT}, hash FROM blocks ORDER BY height DESC LIMIT 1`
  );
  return rows[0] || null;
}

/* ------------------------------------------------------- certificate reads */

const STATE_SELECT = `
  SELECT certificate_number AS "certificateNumber",
         holder_name        AS "holderName",
         organization,
         course,
         to_char(course_date,     'YYYY-MM-DD') AS "courseDate",
         to_char(completion_date, 'YYYY-MM-DD') AS "completionDate",
         to_char(expiry_date,     'YYYY-MM-DD') AS "expiryDate",
         instructor,
         location,
         cs.institute_id    AS "instituteId",
         i.name             AS "instituteName",
         status,
         issued_height      AS "issuedHeight",
         last_height        AS "lastHeight",
         supersedes,
         superseded_by      AS "supersededBy",
         revoked_reason     AS "revokedReason"
    FROM certificate_state cs
    JOIN institutes i ON i.id = cs.institute_id`;

export function validityOf(cert, today = new Date()) {
  if (cert.status === "REVOKED") return { key: "revoked", label: "Revoked", days: null };
  if (cert.status === "SUPERSEDED") return { key: "superseded", label: "Superseded", days: null };
  const midnight = new Date(today.toISOString().slice(0, 10) + "T00:00:00Z");
  const expiry = new Date(cert.expiryDate + "T00:00:00Z");
  const days = Math.round((expiry - midnight) / 86_400_000);
  if (days < 0) return { key: "expired", label: "Expired", days };
  if (days <= 90) return { key: "expiring", label: "Expires soon", days };
  return { key: "valid", label: "Valid", days };
}

export async function listCertificates({ institute, status, search, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (institute) { params.push(institute); where.push(`cs.institute_id = $${params.length}`); }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(`(lower(certificate_number) LIKE $${params.length}
              OR lower(holder_name) LIKE $${params.length}
              OR lower(organization) LIKE $${params.length}
              OR lower(course) LIKE $${params.length})`);
  }
  params.push(Math.min(Number(limit) || 200, 500));
  const sql = `${STATE_SELECT}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY expiry_date ASC
    LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  const decorated = rows.map(r => ({ ...r, validity: validityOf(r) }));
  return status ? decorated.filter(r => r.validity.key === status) : decorated;
}

export async function getCertificate(certificateNumber) {
  const { rows } = await query(`${STATE_SELECT} WHERE lower(certificate_number) = lower($1)`, [certificateNumber]);
  if (!rows[0]) return null;
  const cert = { ...rows[0], validity: validityOf(rows[0]) };

  const history = await query(
    `SELECT height, ${SEALED_AT}, previous_hash AS "previousHash", hash,
            event_type AS "eventType", payload
       FROM blocks
      WHERE certificate_number = $1 OR payload->>'supersedes' = $1
      ORDER BY height ASC`,
    [cert.certificateNumber]
  );

  const trail = history.rows.map(block => ({
    ...block,
    contentsOk: hashBlock(block) === block.hash
  }));

  return { certificate: cert, history: trail, sealIntact: trail.every(b => b.contentsOk) };
}

export { EVENTS };
