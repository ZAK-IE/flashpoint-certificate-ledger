# FlashPoint Certificate Ledger

A hash-chained certificate registry for training institutes. Institutes issue,
renew and revoke safety certificates; anyone at all can verify one; and the full
history of every record stays readable and provably unedited.

Proof of concept for D.E.A.L. (Digital Education Avatar Lead), FlashPoint Safety
Incorporated.

---

## What makes it a chain

Every event is sealed into a block. A block carries a Secure Hash Algorithm
256-bit (SHA-256) digest of its own contents **and** of the block before it, so
changing anything in block 4 changes its digest, which breaks the link held by
block 5, and so on to the head. You cannot quietly alter one record; you would
have to reissue every block after it.

The canonical form that gets hashed is:

```
height \n sealedAt \n previousHash \n eventType \n canonicalJson(payload)
```

`sealedAt` is always an Internet date and time string in Coordinated Universal
Time (UTC) with millisecond precision. `canonicalJson` sorts object keys at
every level, so the same payload always produces the same bytes.

That form is implemented twice on purpose — once in `src/chain.js` for the
server and once in `public/ledger-core.js` for the browser. The integrity check
in the interface recomputes every digest locally with the browser's own
cryptography. The server is not marking its own homework.

### Four event types

| Event | What it does |
| --- | --- |
| `GENESIS` | Opens the registry. One per ledger. |
| `CERTIFICATE_ISSUED` | A new certificate enters the register. |
| `CERTIFICATE_RENEWED` | Seals a replacement and marks the old number superseded. |
| `CERTIFICATE_REVOKED` | Withdraws a certificate, with the reason sealed in. |

Nothing is ever edited or deleted. A correction is a revocation followed by a
new issue, and both stay on the chain.

---

## Data model

**`blocks`** — the only source of truth. Append only, enforced by a database
trigger that refuses `UPDATE` and `DELETE` even from a database console.

| Column | Notes |
| --- | --- |
| `height` | Position in the chain, starting at 0 |
| `sealed_at` | When the block was sealed |
| `previous_hash` | Digest of the block before it; sixty-four zeros for block 0 |
| `hash` | Digest of this block, unique |
| `event_type` | One of the four above |
| `certificate_number` | Which certificate the event concerns |
| `institute_id` | Which institute sealed it |
| `payload` | The sealed record itself, as JSON |

**`institutes`** — name, location, and the write key each institute uses.

**`certificate_state`** — a cache, not a record. It holds the current standing
of each certificate so the register loads in one query. It is produced by
replaying the chain and can be thrown away and rebuilt at any time with
`POST /api/chain/rebuild`. If the cache and the chain ever disagreed, the chain
would be right.

Current standing is worked out from the chain plus today's date: `valid`,
`expiring` within ninety days, `expired`, `revoked`, or `superseded`.

---

## The interface

| Screen | For |
| --- | --- |
| Register | Track every certificate by standing. Counts across the top double as filters, so "expires within 90 days" is one click. |
| Chain | The blocks themselves, newest first, each showing its digest and the one it links to. Open a block to read exactly what was sealed. |
| Issue | Seal a new certificate. Needs an institute key. |
| Verify | Open to anyone. Shows the certificate, its standing, and every block that touches it. |

Renew and revoke appear on a certificate when you are signed in as the institute
that issued it.

---

## Application programming interface

Reading never needs a key. Writing needs the institute's key in an
`x-institute-key` header.

| Method and path | Key | Purpose |
| --- | --- | --- |
| `GET /api/health` | no | Liveness and chain height |
| `GET /api/institutes` | no | Institutes on the registry |
| `GET /api/session` | key | Confirms which institute a key belongs to |
| `GET /api/chain` | no | Every block, oldest first |
| `GET /api/chain/head` | no | The newest block |
| `GET /api/chain/verify` | no | Server-side recomputation of every digest |
| `POST /api/chain/rebuild` | yes | Rebuild the cache by replaying the chain |
| `GET /api/certificates` | no | Register, filterable by `institute`, `status`, `q` |
| `GET /api/certificates/:number` | no | One certificate, its standing, and its full block trail |
| `POST /api/certificates` | yes | Issue |
| `POST /api/certificates/:number/renew` | yes | Renew; seals a replacement |
| `POST /api/certificates/:number/revoke` | yes | Revoke, with a reason |
| `GET /api/tracking` | no | Counts and lists for expiring, expired and revoked |

Issue a certificate from the command line:

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/api/certificates \
  -H "content-type: application/json" \
  -H "x-institute-key: YOUR_KEY" \
  -d '{
    "certificateNumber":"CERT-NL-2026-0500",
    "holderName":"Erin Kavanagh",
    "organization":"Terra Nova Marine Services",
    "course":"Confined space entry and rescue",
    "courseDate":"2026-09-14",
    "completionDate":"2026-09-15",
    "expiryDate":"2029-09-15",
    "instructor":"Colleen Hefferton",
    "location":"St. John'\''s, Newfoundland and Labrador"
  }'
```

---

## Running it on your own machine

You need Node version 20 or newer and a Postgres connection string. The free
Neon database described in `DEPLOY.md` works for local development too.

```bash
npm install
cp .env.example .env     # then paste your connection string into it
npm run migrate          # creates the schema and seeds eight blocks
npm start                # http://localhost:3000
```

The demonstration keys are `demo-atlantic-key`, `demo-fundy-key` and
`demo-bowvalley-key` unless you set your own in `.env`.

---

## What this is not

- **Not a distributed blockchain.** It is a hash-chained append-only ledger on
  one Postgres database. That gives tamper evidence and a full audit trail. It
  does not give tamper resistance against whoever controls the database, because
  a sufficiently determined operator could reseal the entire chain. Real
  resistance needs multiple independent parties holding copies. The honest way
  to describe this to a customer is "provably unedited, held by us" rather than
  "decentralised".
- **Not authenticated properly.** Institute keys are a stand-in for real
  accounts with roles, sessions and audit logs.
- **Not signed.** Adding one signature per institute over each block would let a
  verifier prove which institute sealed a record, not just that the record has
  not changed. That is the obvious next step.
- **Not production data.** Every seeded record is invented and refers to no real
  person or employer.
