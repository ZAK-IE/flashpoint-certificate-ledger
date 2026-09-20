/**
 * Creates the schema and seeds the demonstration data.
 * Safe to run repeatedly: it only seeds when the chain is empty.
 *
 *   npm run migrate
 */

import "./env.js";
import { EVENTS } from "./chain.js";
import { pool, withTransaction } from "./db.js";
import { appendBlock, rebuildProjection } from "./ledger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS institutes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  location    TEXT NOT NULL,
  api_key     TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks (
  height              INTEGER     PRIMARY KEY,
  sealed_at           TIMESTAMPTZ NOT NULL,
  previous_hash       CHAR(64)    NOT NULL,
  hash                CHAR(64)    NOT NULL UNIQUE,
  event_type          TEXT        NOT NULL,
  certificate_number  TEXT,
  institute_id        TEXT        REFERENCES institutes(id),
  payload             JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS blocks_certificate_idx ON blocks (certificate_number);
CREATE INDEX IF NOT EXISTS blocks_institute_idx   ON blocks (institute_id);

-- The chain is append only. This refuses any attempt to rewrite history,
-- including one made directly against the database with a console or a client.
CREATE OR REPLACE FUNCTION refuse_block_rewrite() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The ledger is append only: % on block % was refused',
    TG_OP, OLD.height;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blocks_are_immutable ON blocks;
CREATE TRIGGER blocks_are_immutable
  BEFORE UPDATE OR DELETE ON blocks
  FOR EACH ROW EXECUTE FUNCTION refuse_block_rewrite();

-- Derived cache. Never a source of truth; rebuilt by replaying blocks.
CREATE TABLE IF NOT EXISTS certificate_state (
  certificate_number  TEXT PRIMARY KEY,
  holder_name         TEXT NOT NULL,
  organization        TEXT NOT NULL,
  course              TEXT NOT NULL,
  course_date         DATE NOT NULL,
  completion_date     DATE NOT NULL,
  expiry_date         DATE NOT NULL,
  instructor          TEXT NOT NULL,
  location            TEXT NOT NULL,
  institute_id        TEXT NOT NULL REFERENCES institutes(id),
  status              TEXT NOT NULL,
  issued_height       INTEGER NOT NULL,
  last_height         INTEGER NOT NULL,
  supersedes          TEXT,
  superseded_by       TEXT,
  revoked_reason      TEXT,
  revoked_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS certificate_expiry_idx    ON certificate_state (expiry_date);
CREATE INDEX IF NOT EXISTS certificate_institute_idx ON certificate_state (institute_id);
`;

const INSTITUTES = [
  { id: "atlantic",  name: "Atlantic Safety Institute",      location: "St. John's, Newfoundland and Labrador", key: process.env.KEY_ATLANTIC  || "demo-atlantic-key" },
  { id: "fundy",     name: "Fundy Coast Training Group",     location: "Dartmouth, Nova Scotia",                key: process.env.KEY_FUNDY     || "demo-fundy-key" },
  { id: "bowvalley", name: "Bow Valley Industrial Training", location: "Calgary, Alberta",                      key: process.env.KEY_BOWVALLEY || "demo-bowvalley-key" }
];

const SEED_CERTIFICATES = [
  { certificateNumber: "CERT-NL-2026-0417", holderName: "Sarah Mercer",
    organization: "Oceanic Drilling Services Limited", course: "Marine Emergency Duties, basic survival training",
    courseDate: "2026-03-02", completionDate: "2026-03-06", expiryDate: "2029-03-06",
    instructor: "Gordon Pike", location: "St. John's, Newfoundland and Labrador", instituteId: "atlantic" },

  { certificateNumber: "CERT-NS-2023-0418", holderName: "Daniel Okonkwo",
    organization: "Fundy Marine Contractors Incorporated", course: "Confined space entry and rescue",
    courseDate: "2023-08-28", completionDate: "2023-08-31", expiryDate: "2026-08-31",
    instructor: "Rachel Comeau", location: "Dartmouth, Nova Scotia", instituteId: "fundy" },

  { certificateNumber: "CERT-AB-2026-0419", holderName: "Priya Raghunathan",
    organization: "Northgate Energy Partners", course: "Hydrogen sulphide awareness and self-rescue",
    courseDate: "2026-04-14", completionDate: "2026-04-14", expiryDate: "2029-04-14",
    instructor: "Terrence Whitecalf", location: "Calgary, Alberta", instituteId: "bowvalley" },

  { certificateNumber: "CERT-ON-2026-0420", holderName: "Marc Lévesque",
    organization: "Huron Steel Fabricators", course: "Fall protection for work at heights",
    courseDate: "2026-05-11", completionDate: "2026-05-12", expiryDate: "2029-05-12",
    instructor: "Gordon Pike", location: "Hamilton, Ontario", instituteId: "atlantic" },

  { certificateNumber: "CERT-BC-2023-0421", holderName: "Amanda Chiu",
    organization: "Coastal Forest Products Limited", course: "Workplace Hazardous Materials Information System 2015",
    courseDate: "2023-10-19", completionDate: "2023-10-19", expiryDate: "2026-10-20",
    instructor: "Nadia Bergeron", location: "Prince George, British Columbia", instituteId: "bowvalley" },

  { certificateNumber: "CERT-QC-2026-0422", holderName: "Isabelle Tremblay",
    organization: "Groupe Transbec", course: "Transportation of dangerous goods, class 3 and class 8",
    courseDate: "2026-06-02", completionDate: "2026-06-03", expiryDate: "2029-06-03",
    instructor: "Nadia Bergeron", location: "Trois-Rivières, Quebec", instituteId: "fundy" },

  { certificateNumber: "CERT-NL-2026-0423", holderName: "Joseph Kinsella",
    organization: "Avalon Utility Services", course: "Cardiopulmonary resuscitation level C with automated external defibrillator",
    courseDate: "2026-07-21", completionDate: "2026-07-21", expiryDate: "2029-07-21",
    instructor: "Colleen Hefferton", location: "Mount Pearl, Newfoundland and Labrador", instituteId: "atlantic" }
];

export async function migrate({ seed = true } = {}) {
  await pool.query(SCHEMA);

  for (const inst of INSTITUTES) {
    await pool.query(
      `INSERT INTO institutes (id, name, location, api_key) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, location = EXCLUDED.location, api_key = EXCLUDED.api_key`,
      [inst.id, inst.name, inst.location, inst.key]
    );
  }

  const { rows } = await pool.query("SELECT count(*)::int AS n FROM blocks");
  if (rows[0].n > 0) return { seeded: false, height: rows[0].n };
  if (!seed) return { seeded: false, height: 0 };

  await withTransaction(async client => {
    await appendBlock(client, {
      eventType: EVENTS.GENESIS,
      payload: {
        registry: "FlashPoint Safety Incorporated certificate registry",
        note: "Registry opened. Every block after this one records one certificate event.",
        openedBy: "FlashPoint Safety Incorporated"
      }
    });

    for (const cert of SEED_CERTIFICATES) {
      const institute = INSTITUTES.find(i => i.id === cert.instituteId);
      await appendBlock(client, {
        eventType: EVENTS.ISSUED,
        certificateNumber: cert.certificateNumber,
        instituteId: cert.instituteId,
        payload: { ...cert, instituteName: institute.name }
      });
    }

    // One revoked record so the tracking screen has every state in it.
    await appendBlock(client, {
      eventType: EVENTS.REVOKED,
      certificateNumber: "CERT-QC-2026-0422",
      instituteId: "fundy",
      payload: {
        certificateNumber: "CERT-QC-2026-0422",
        reason: "Issued against the wrong dangerous goods classes. Replacement certificate to follow.",
        instituteId: "fundy",
        instituteName: "Fundy Coast Training Group"
      }
    });
  });

  await rebuildProjection();
  const head = await pool.query("SELECT count(*)::int AS n FROM blocks");
  return { seeded: true, height: head.rows[0].n };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(r => { console.log("Migration finished:", r); return pool.end(); })
    .then(() => process.exit(0))
    .catch(err => { console.error("Migration failed:", err); process.exit(1); });
}
