import express from "express";
import { EVENTS } from "../chain.js";
import { query, withTransaction } from "../db.js";
import {
  appendBlock, chainHead, getCertificate, listCertificates,
  readChain, rebuildProjection, validityOf, verifyChain
} from "../ledger.js";

export const api = express.Router();

/* ------------------------------------------------------------ institutes */

async function instituteFromKey(key) {
  if (!key) return null;
  const { rows } = await query(
    "SELECT id, name, location FROM institutes WHERE api_key = $1", [key]
  );
  return rows[0] || null;
}

/** Writing to the ledger needs an institute key. Reading never does. */
async function requireInstitute(req, res, next) {
  const key = req.get("x-institute-key") || "";
  const institute = await instituteFromKey(key.trim());
  if (!institute) {
    return res.status(401).json({
      error: "unrecognised_key",
      message: "Send a valid institute key in the x-institute-key header to write to the ledger."
    });
  }
  req.institute = institute;
  next();
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ----------------------------------------------------------------- health */

api.get("/health", wrap(async (_req, res) => {
  const head = await chainHead();
  res.json({ status: "ok", height: head ? head.height + 1 : 0, head });
}));

api.get("/institutes", wrap(async (_req, res) => {
  const { rows } = await query("SELECT id, name, location FROM institutes ORDER BY name");
  res.json({ institutes: rows });
}));

api.get("/session", wrap(async (req, res) => {
  const institute = await instituteFromKey((req.get("x-institute-key") || "").trim());
  res.json({ signedIn: Boolean(institute), institute });
}));

/* ------------------------------------------------------------------ chain */

api.get("/chain", wrap(async (req, res) => {
  const blocks = await readChain({ from: Number(req.query.from) || 0, limit: req.query.limit });
  res.json({ height: blocks.length, blocks });
}));

api.get("/chain/head", wrap(async (_req, res) => res.json({ head: await chainHead() })));

api.get("/chain/verify", wrap(async (_req, res) => res.json(await verifyChain())));

api.post("/chain/rebuild", requireInstitute, wrap(async (_req, res) => {
  res.json(await rebuildProjection());
}));

/* ----------------------------------------------------------- certificates */

api.get("/certificates", wrap(async (req, res) => {
  const certificates = await listCertificates({
    institute: req.query.institute,
    status: req.query.status,
    search: req.query.q,
    limit: req.query.limit
  });
  res.json({ count: certificates.length, certificates });
}));

api.get("/certificates/:number", wrap(async (req, res) => {
  const found = await getCertificate(req.params.number);
  if (!found) {
    return res.status(404).json({
      error: "not_found",
      message: `No certificate on this ledger carries the number ${req.params.number}.`
    });
  }
  res.json(found);
}));

/* ------------------------------------------------------------- validation */

const REQUIRED = ["certificateNumber", "holderName", "organization", "course",
                  "courseDate", "completionDate", "expiryDate", "instructor", "location"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateCertificate(body) {
  const errors = {};
  for (const field of REQUIRED) {
    if (!body[field] || !String(body[field]).trim()) {
      errors[field] = "This field is needed before the record can be sealed.";
    }
  }
  for (const field of ["courseDate", "completionDate", "expiryDate"]) {
    if (body[field] && !DATE.test(body[field])) {
      errors[field] = "Use the form YYYY-MM-DD.";
    }
  }
  if (!errors.courseDate && !errors.completionDate && body.completionDate < body.courseDate) {
    errors.completionDate = "Completion cannot fall before the course started.";
  }
  if (!errors.completionDate && !errors.expiryDate && body.expiryDate <= body.completionDate) {
    errors.expiryDate = "Expiration must fall after completion.";
  }
  return errors;
}

function cleanCertificate(body, institute, extra = {}) {
  const record = {};
  for (const field of REQUIRED) record[field] = String(body[field]).trim();
  return { ...record, instituteId: institute.id, instituteName: institute.name, ...extra };
}

/* ------------------------------------------------------------------ issue */

api.post("/certificates", requireInstitute, wrap(async (req, res) => {
  const errors = validateCertificate(req.body || {});
  if (Object.keys(errors).length) return res.status(422).json({ error: "invalid_record", errors });

  const number = String(req.body.certificateNumber).trim();
  const clash = await query("SELECT 1 FROM certificate_state WHERE lower(certificate_number) = lower($1)", [number]);
  if (clash.rowCount) {
    return res.status(409).json({
      error: "already_sealed",
      errors: { certificateNumber: "This number is already sealed on the ledger. Use a number that has not been issued." }
    });
  }

  const payload = cleanCertificate(req.body, req.institute);
  const block = await withTransaction(client => appendBlock(client, {
    eventType: EVENTS.ISSUED,
    certificateNumber: payload.certificateNumber,
    instituteId: req.institute.id,
    payload
  }));

  res.status(201).json({ block, certificate: { ...payload, status: "ACTIVE", validity: validityOf({ ...payload, status: "ACTIVE" }) } });
}));

/* ------------------------------------------------------------------ renew */

api.post("/certificates/:number/renew", requireInstitute, wrap(async (req, res) => {
  const previous = await getCertificate(req.params.number);
  if (!previous) return res.status(404).json({ error: "not_found", message: "That certificate is not on the ledger." });
  if (previous.certificate.instituteId !== req.institute.id) {
    return res.status(403).json({ error: "not_your_certificate", message: "Only the institute that issued a certificate can renew it." });
  }
  if (previous.certificate.status === "REVOKED") {
    return res.status(409).json({ error: "revoked", message: "A revoked certificate cannot be renewed. Issue a new one instead." });
  }
  if (previous.certificate.status === "SUPERSEDED") {
    return res.status(409).json({ error: "superseded", message: `This certificate was already renewed as ${previous.certificate.supersededBy}.` });
  }

  const draft = {
    ...previous.certificate,
    certificateNumber: req.body.certificateNumber,
    courseDate: req.body.courseDate,
    completionDate: req.body.completionDate,
    expiryDate: req.body.expiryDate,
    instructor: req.body.instructor || previous.certificate.instructor,
    location: req.body.location || previous.certificate.location
  };

  const errors = validateCertificate(draft);
  if (Object.keys(errors).length) return res.status(422).json({ error: "invalid_record", errors });

  const clash = await query("SELECT 1 FROM certificate_state WHERE lower(certificate_number) = lower($1)", [draft.certificateNumber]);
  if (clash.rowCount) {
    return res.status(409).json({ error: "already_sealed", errors: { certificateNumber: "This number is already sealed on the ledger." } });
  }

  const payload = cleanCertificate(draft, req.institute, { supersedes: previous.certificate.certificateNumber });
  const block = await withTransaction(client => appendBlock(client, {
    eventType: EVENTS.RENEWED,
    certificateNumber: payload.certificateNumber,
    instituteId: req.institute.id,
    payload
  }));

  res.status(201).json({ block, certificate: payload, supersedes: previous.certificate.certificateNumber });
}));

/* ----------------------------------------------------------------- revoke */

api.post("/certificates/:number/revoke", requireInstitute, wrap(async (req, res) => {
  const found = await getCertificate(req.params.number);
  if (!found) return res.status(404).json({ error: "not_found", message: "That certificate is not on the ledger." });
  if (found.certificate.instituteId !== req.institute.id) {
    return res.status(403).json({ error: "not_your_certificate", message: "Only the institute that issued a certificate can revoke it." });
  }
  if (found.certificate.status === "REVOKED") {
    return res.status(409).json({ error: "already_revoked", message: "That certificate is already revoked." });
  }
  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 8) {
    return res.status(422).json({ error: "invalid_record", errors: { reason: "Give a reason of at least eight characters. It is sealed into the chain and stays readable." } });
  }

  const block = await withTransaction(client => appendBlock(client, {
    eventType: EVENTS.REVOKED,
    certificateNumber: found.certificate.certificateNumber,
    instituteId: req.institute.id,
    payload: {
      certificateNumber: found.certificate.certificateNumber,
      reason,
      instituteId: req.institute.id,
      instituteName: req.institute.name
    }
  }));

  res.status(201).json({ block });
}));

/* --------------------------------------------------------------- tracking */

api.get("/tracking", wrap(async (req, res) => {
  const all = await listCertificates({ institute: req.query.institute, limit: 500 });
  const bucket = key => all.filter(c => c.validity.key === key);
  res.json({
    counts: {
      total: all.length,
      valid: bucket("valid").length,
      expiring: bucket("expiring").length,
      expired: bucket("expired").length,
      revoked: bucket("revoked").length,
      superseded: bucket("superseded").length
    },
    expiring: bucket("expiring"),
    expired: bucket("expired"),
    revoked: bucket("revoked")
  });
}));

/* ------------------------------------------------------------------ misc */

api.use((_req, res) => res.status(404).json({ error: "no_such_endpoint" }));

api.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "server_error", message: err.message });
});
