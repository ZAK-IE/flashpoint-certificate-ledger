# Deploying the demonstration

Two free accounts, no payment card, about twenty minutes. Nothing here expires
on a clock.

- **Neon** holds the database. Its free plan is permanent. Render's own free
  Postgres expires after thirty days, which is why the database lives elsewhere.
- **Render** runs the Node service, which serves both the application
  programming interface and the front end from one address, so there is no
  cross-origin configuration to get wrong.

You will need a GitHub account as well, since Render deploys from a repository.

---

## Step 1 — Put the code on GitHub

If you have `git` installed:

```bash
cd flashpoint-ledger
git init
git add .
git commit -m "FlashPoint certificate ledger"
```

Then create an empty repository at <https://github.com/new>. Name it
`flashpoint-certificate-ledger`, leave every checkbox unticked, and press
**Create repository**. GitHub shows you two lines to run; they look like this:

```bash
git remote add origin https://github.com/YOUR-NAME/flashpoint-certificate-ledger.git
git branch -M main
git push -u origin main
```

No `git` installed? On the empty repository page choose **uploading an existing
file**, drag in the contents of the `flashpoint-ledger` folder, and commit. Do
not upload `node_modules` if one exists.

---

## Step 2 — Create the database on Neon

1. Go to <https://neon.com/signup> and sign in with GitHub. No card is asked
   for.
2. Press **Create project**. Name it `flashpoint-ledger`. Pick the region
   closest to your audience — `AWS US East (Ohio)` is a reasonable default for
   Atlantic Canada.
3. Neon shows a connection string as soon as the project exists. It looks like:

   ```
   postgresql://neondb_owner:SOMEPASSWORD@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

4. Copy it somewhere safe. If the panel closes, it is under **Dashboard →
   Connect**, with **Connection string** and **Pooled connection** selected.

Keep `?sslmode=require` on the end. The server will not connect without it.

---

## Step 3 — Create the service on Render

1. Go to <https://render.com> and sign in with GitHub. No card is asked for.
2. **New → Web Service**.
3. Connect your GitHub account when prompted, then pick the
   `flashpoint-certificate-ledger` repository.
4. Fill the form:

   | Field | Value |
   | --- | --- |
   | Name | `flashpoint-certificate-ledger` |
   | Region | the one nearest your Neon region |
   | Branch | `main` |
   | Root directory | leave empty |
   | Runtime | Node |
   | Build command | `npm install` |
   | Start command | `npm start` |
   | Instance type | **Free** |

5. Open **Advanced** and add the environment variables:

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | the Neon connection string from step 2 |
   | `KEY_ATLANTIC` | a long random string you invent |
   | `KEY_FUNDY` | another one |
   | `KEY_BOWVALLEY` | another one |
   | `RUN_MIGRATIONS` | `true` |

   Do not leave the demonstration keys in place for anything you show publicly.
   Anyone holding a key can write to your ledger. A quick way to make one:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

6. Set **Health check path** to `/api/health` if the field is offered.
7. Press **Create Web Service**.

Render installs, starts the service, and runs the migration on first boot. Watch
the log; you are looking for two lines:

```
Schema ready: { seeded: true, height: 9 }
Certificate ledger listening on port 10000
```

Your address appears at the top of the page, in the form
`https://flashpoint-certificate-ledger.onrender.com`.

**Alternative:** the repository contains `render.yaml`. Instead of steps 2
through 7 you can choose **New → Blueprint**, point Render at the repository,
and it fills the form itself. You still paste `DATABASE_URL` by hand.

---

## Step 4 — Check it works

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
```

Expect `{"status":"ok","height":9,...}`.

Then open the address in a browser. You should see nine blocks, seven
certificates, and a register showing one expired, one expiring soon and one
revoked. Press **Verify the chain in this browser** in the left column; the
blocks should tick through one at a time and report intact.

To sign in as an institute, pick it from the selector at the top right and paste
its key into the key box. The badge changes to "Signed in as …" and the issue,
renew and revoke controls become available.

---

## Step 5 — Things to know before you demonstrate it

**The free service falls asleep.** After fifteen minutes without traffic Render
spins the service down, and the next request takes thirty to sixty seconds while
it wakes. Load the page a minute before anyone walks into the room. If you are
demonstrating repeatedly, a free UptimeRobot check hitting `/api/health` every
ten minutes keeps it awake; seven dollars a month on Render removes the
behaviour entirely.

**Neon sleeps too**, after five minutes idle, but wakes in under a second.

**Free tier limits.** Render gives 750 instance hours a month and 100 GB of
bandwidth. Neon gives 0.5 GB of storage and 100 compute hours per project per
month. This ledger will not come close to any of them.

**Pushing to `main` redeploys.** Render rebuilds automatically on every push.

---

## A demonstration that lands

1. Open **Register**. Point at the counts: one certificate expiring within
   ninety days, one already expired, one revoked. This is the part a training
   institute actually needs day to day.
2. Click the expiring one, then **Renew this certificate**. Seal it. The old
   number turns superseded, the new one appears, and both remain on the chain.
3. Go to **Chain**. The renewal is a new block at the head, linked to the one
   before it.
4. Open a block and look at **Recomputed**. That digest was calculated in the
   browser, not sent by the server.
5. Press **Verify the chain in this browser**.
6. Finally, show that the database itself refuses to cooperate with tampering.
   In the Neon console, run:

   ```sql
   UPDATE blocks SET payload = jsonb_set(payload, '{expiryDate}', '"2035-01-01"')
   WHERE height = 1;
   ```

   Postgres answers:

   ```
   ERROR: The ledger is append only: UPDATE on block 1 was refused
   ```

   That is the trigger in `src/migrate.js`, not application code. Even someone
   with the database password has to work at it.

7. **Optional, and the one people remember.** If you want to show what a broken
   chain looks like rather than only a refused edit, switch the trigger off,
   tamper, and let the browser catch it:

   ```sql
   ALTER TABLE blocks DISABLE TRIGGER blocks_are_immutable;
   UPDATE blocks SET payload = jsonb_set(payload, '{expiryDate}', '"2035-01-01"')
   WHERE height = 1;
   ALTER TABLE blocks ENABLE TRIGGER blocks_are_immutable;
   ```

   Reload the page and press **Verify the chain in this browser**. Block 1
   reports altered contents and every block after it reports a broken link. The
   forged expiry date is sitting right there in the database and the chain still
   gives it away. Put it back with the original value, or redeploy from scratch
   against a fresh Neon project.

---

## Pulling the demonstration down

Delete the Render service and the Neon project. Both are one button in their
dashboards, and neither leaves anything to be billed for.
