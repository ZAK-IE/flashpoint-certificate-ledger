import { verifyLocally, hashBlock } from "./ledger-core.js";



const FIELDS = [
  ["certificateNumber", "Certificate number", "text"],
  ["holderName", "Name of holder", "text"],
  ["organization", "Organization", "text"],
  ["course", "Course", "text"],
  ["courseDate", "Date of course", "date"],
  ["completionDate", "Date of completion", "date"],
  ["expiryDate", "Expiration date", "date"],
  ["instructor", "Name of instructor", "text"],
  ["location", "Location", "text"]
];

const EVENT_LABEL = {
  GENESIS: "registry opened",
  CERTIFICATE_ISSUED: "issued",
  CERTIFICATE_RENEWED: "renewed",
  CERTIFICATE_REVOKED: "revoked"
};

function blankDraft() {
  const d = {};
  FIELDS.forEach(f => (d[f[0]] = ""));
  return d;
}

/* ------------------------------------------------------------------ state */

const state = {
  view: "register",
  institutes: [],
  instituteId: "",
  apiKey: "",
  session: null,
  blocks: [],
  audit: null,
  certificates: [],
  counts: null,
  filter: "",
  mineOnly: false,
  expanded: null,      // block height open on the chain screen
  detail: undefined,   // certificate detail on the verify screen
  verifyQuery: "",
  formErrors: {},
  draft: blankDraft(),
  justArrived: null,
  busy: false
};

/* -------------------------------------------------------------- transport */

async function api(pathname, options = {}) {
  const headers = { "content-type": "application/json" };
  if (state.apiKey) headers["x-institute-key"] = state.apiKey;
  const res = await fetch("/api" + pathname, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || res.statusText), { status: res.status, body });
  return body;
}

/* --------------------------------------------------------------- helpers */

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = h => (h ? h.slice(0, 6) + "…" + h.slice(-4) : "");
const pad = n => String(n).padStart(3, "0");

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-CA", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
  });
}
function fmtSeal(iso) {
  return iso ? iso.slice(0, 19).replace("T", " ") + " UTC" : "";
}

function toast(message, bad = false) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function nextCertificateNumber() {
  const nums = state.certificates
    .map(c => parseInt(String(c.certificateNumber).slice(-4), 10))
    .filter(n => !Number.isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 416) + 1;
  const year = new Date().getFullYear();
  return `CERT-NL-${year}-${String(next).padStart(4, "0")}`;
}

/* ------------------------------------------------------------------ loads */

async function loadEverything() {
  const [{ institutes }, chain, tracking, certs] = await Promise.all([
    api("/institutes"),
    api("/chain"),
    api("/tracking"),
    api("/certificates?limit=500")
  ]);
  state.institutes = institutes;
  if (!state.instituteId) state.instituteId = institutes[0]?.id || "";
  state.blocks = chain.blocks;
  state.counts = tracking.counts;
  state.certificates = certs.certificates;
}

async function refreshSession() {
  try {
    const { institute } = await api("/session");
    state.session = institute;
  } catch {
    state.session = null;
  }
}

/* ------------------------------------------------------------------- rail */

function renderRail() {
  const intact = state.audit ? state.audit.intact : null;
  let stateHtml;
  if (intact === null) stateHtml = '<span class="state idle"><i class="beacon"></i>Not checked yet</span>';
  else if (intact) stateHtml = '<span class="state ok"><i class="beacon"></i>Intact</span>';
  else stateHtml = `<span class="state bad"><i class="beacon"></i>Broken at block ${pad(state.audit.firstBreak.height)}</span>`;

  const head = state.blocks[state.blocks.length - 1];
  document.getElementById("railstats").innerHTML =
    `<div class="stat"><dt>Blocks sealed</dt><dd>${state.blocks.length}</dd></div>` +
    `<div class="stat"><dt>Certificates</dt><dd>${state.counts ? state.counts.total : "—"}</dd></div>` +
    `<div class="stat"><dt>Last seal</dt><dd>${head ? head.sealedAt.slice(0, 10) : "—"}</dd></div>` +
    `<div class="stat"><dt>Chain</dt><dd>${stateHtml}</dd></div>`;

  const badge = document.getElementById("signedin");
  if (state.session) {
    badge.className = "pill valid";
    badge.textContent = "Signed in as " + state.session.name;
  } else {
    badge.className = "pill grey";
    badge.textContent = "Not signed in";
  }
}

function renderAudit(reveal) {
  const box = document.getElementById("auditbox");
  if (!state.audit) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = "<ul>" + state.audit.results.map(r => {
    const good = r.contentsOk && r.linkOk;
    const note = good ? "sealed" : (!r.contentsOk ? "contents altered" : "link broken");
    return `<li class="${good ? "g" : "r"}"><span>${good ? "✓" : "✕"}</span><span>block ${pad(r.height)}</span><span>${note}</span></li>`;
  }).join("") + "</ul>";

  const items = box.querySelectorAll("li");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reveal || reduced) { items.forEach(li => li.classList.add("shown")); return; }
  items.forEach((li, i) => setTimeout(() => {
    li.classList.add("shown");
    const node = document.querySelector(`.block[data-height="${i}"]`);
    if (node) { node.classList.add("pulse"); setTimeout(() => node.classList.remove("pulse"), 520); }
  }, i * 70));
}

/* --------------------------------------------------------- register view */

function registerHtml() {
  const c = state.counts || {};
  const buckets = [
    ["", "All certificates", c.total],
    ["valid", "Valid", c.valid],
    ["expiring", "Expires within 90 days", c.expiring],
    ["expired", "Expired", c.expired],
    ["revoked", "Revoked", c.revoked],
    ["superseded", "Superseded by a renewal", c.superseded]
  ];

  const rows = visibleCertificates();
  const body = rows.length ? rows.map(cert => `
    <tr>
      <td class="num">${esc(cert.certificateNumber)}</td>
      <td>${esc(cert.holderName)}<br><span style="color:var(--fog);font-size:12.5px">${esc(cert.organization)}</span></td>
      <td>${esc(cert.course)}</td>
      <td class="num">${esc(cert.expiryDate)}</td>
      <td><span class="pill ${cert.validity.key}">${esc(cert.validity.label)}</span></td>
      <td><button data-open="${esc(cert.certificateNumber)}">Open</button></td>
    </tr>`).join("")
    : `<tr><td colspan="6"><div class="empty"><b>Nothing in this view</b>No certificate matches the filter you have selected.</div></td></tr>`;

  return `<h2 class="view">Certificate register</h2>
    <p class="view">Every certificate the registry has ever sealed, with its current standing worked out from the chain. Renewing or revoking never edits a record — it appends a new block, and the register reflects the result.</p>
    <div class="counts">${buckets.map(([key, label, n]) => `
      <button class="count ${key || "all"}" data-filter="${key}" aria-pressed="${state.filter === key}">
        <b>${n ?? "—"}</b><span>${label}</span>
      </button>`).join("")}</div>
    <div class="filterbar">
      <label><input type="checkbox" id="mineonly" ${state.mineOnly ? "checked" : ""}> Only certificates issued by ${esc(instituteName(state.instituteId))}</label>
    </div>
    <table class="register">
      <thead><tr><th>Number</th><th>Holder</th><th>Course</th><th>Expires</th><th>Standing</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function visibleCertificates() {
  return state.certificates.filter(c =>
    (!state.filter || c.validity.key === state.filter) &&
    (!state.mineOnly || c.instituteId === state.instituteId));
}

function instituteName(id) {
  return state.institutes.find(i => i.id === id)?.name || "your institute";
}

/* ------------------------------------------------------------ chain view */

function ledgerHtml() {
  const breakAt = state.audit?.firstBreak ? state.audit.firstBreak.height : null;

  const rows = state.blocks.slice().reverse().map(b => {
    const broken = breakAt !== null && b.height >= breakAt;
    const classes = ["block", b.eventType === "GENESIS" ? "genesis" : "sealed"];
    if (broken) classes.push("broken");
    if (state.justArrived === b.height) classes.push("arrived");

    if (b.eventType === "GENESIS") {
      return `<li class="${classes.join(" ")}" data-height="${b.height}">
        <span class="node"></span>
        <div class="row"><span class="height">${pad(b.height)}</span>
          <div class="rowmain"><span class="rowsub">${esc(b.payload.note)}</span>
          <span class="rowhash">seal ${short(b.hash)}</span></div></div></li>`;
    }

    const kind = b.eventType === "CERTIFICATE_REVOKED" ? "revoke"
               : b.eventType === "CERTIFICATE_RENEWED" ? "renew" : "";
    const open = state.expanded === b.height;
    const who = b.payload.holderName || b.payload.certificateNumber;

    return `<li class="${classes.join(" ")}" data-height="${b.height}">
      <span class="node"></span>
      <button class="row" data-block="${b.height}" aria-expanded="${open}">
        <span class="height">${pad(b.height)}</span>
        <span class="rowmain">
          <span class="certno">${esc(b.certificateNumber)}</span>
          <span class="rowsub"><span class="evt ${kind}">${EVENT_LABEL[b.eventType]}</span>${esc(who)} — ${esc(b.payload.instituteName || "")}</span>
          <span class="rowhash">seal ${short(b.hash)}  links to ${short(b.previousHash)}</span>
        </span>
        <span class="pill grey">${esc(b.sealedAt.slice(0, 10))}</span>
      </button>
      ${open ? blockDetailHtml(b) : ""}
    </li>`;
  }).join("");

  return `<h2 class="view">The chain</h2>
    <p class="view">Newest block first. Each block seals one event and carries the digest of the block before it, so the whole history has to be rewritten to change any part of it. Open a block to read exactly what was sealed.</p>
    <ul class="spine">${rows}</ul>`;
}

function blockDetailHtml(b) {
  const entries = Object.entries(b.payload).filter(([k]) => k !== "instituteId");
  return `<div class="face">
    <div class="facehead">
      <div><h3>${EVENT_LABEL[b.eventType]} — ${esc(b.certificateNumber)}</h3>
      <p>Sealed ${fmtSeal(b.sealedAt)} by ${esc(b.payload.instituteName || "the registry")}</p></div>
      <span class="pill grey">block ${pad(b.height)}</span>
    </div>
    <dl class="fields">${entries.map(([k, v]) => `
      <div class="field"><dt>${esc(labelFor(k))}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <div class="seal"><h4>Sealed payload digest</h4>
      <div class="sealrow"><b>This block</b><span>${esc(b.hash)}</span></div>
      <div class="sealrow"><b>Previous</b><span>${esc(b.previousHash)}</span></div>
      <div class="sealrow"><b>Recomputed</b><span id="recomp-${b.height}">checking…</span></div>
    </div>
    <div class="faceactions">
      <button data-open="${esc(b.certificateNumber)}">Open the certificate</button>
    </div>
  </div>`;
}

const LABELS = {
  certificateNumber: "Certificate number", holderName: "Name of holder", organization: "Organization",
  course: "Course", courseDate: "Date of course", completionDate: "Date of completion",
  expiryDate: "Expiration date", instructor: "Name of instructor", location: "Location",
  instituteName: "Issued by", supersedes: "Replaces", reason: "Reason", registry: "Registry",
  note: "Note", openedBy: "Opened by"
};
const labelFor = k => LABELS[k] || k;

/* ------------------------------------------------------------ issue view */

function issueHtml() {
  const inputs = FIELDS.map(([key, label, type]) => {
    const hint = key === "certificateNumber"
      ? '<div class="hint">Suggested from the highest number on the ledger. Edit it if your institute numbers differently.</div>' : "";
    const err = state.formErrors[key] ? `<div class="err">${esc(state.formErrors[key])}</div>` : "";
    return `<div class="f"><label for="in-${key}">${label}</label>
      <input id="in-${key}" class="${key === "certificateNumber" ? "mono" : ""}" type="${type}" value="${esc(state.draft[key])}">${hint}${err}</div>`;
  }).join("");

  return `<h2 class="view">Issue a certificate</h2>
    <p class="view">Your instructor has already adjudicated the candidate. Sealing appends a block that cannot be edited afterwards, so check the dates and the spelling of the name first. A mistake is corrected by revoking and reissuing, and both steps stay visible on the chain.</p>
    <div class="form"><div class="grid2">${inputs}</div>
      <div class="f" style="margin-top:14px"><label>Issued by</label>
        <input value="${esc(state.session ? state.session.name : "sign in with an institute key to seal")}" disabled></div>
      <div class="formfoot">
        <button class="btn primary auto" id="seal" ${state.session ? "" : "disabled"}>Seal certificate</button>
        <button class="btn quiet auto" id="sample">Fill with a sample record</button>
        <button class="btn quiet auto" id="clear">Clear the form</button>
      </div>
    </div>`;
}

/* ----------------------------------------------------------- verify view */

function verifyHtml() {
  let body;
  if (state.detail === undefined) {
    body = `<div class="empty"><b>Nothing checked yet</b>Enter a certificate number to see who issued it, where it stands today, and whether its sealed contents still match the chain.</div>`;
  } else if (state.detail === null) {
    body = `<div class="empty"><b>No match on this ledger</b>No certificate carries the number ${esc(state.verifyQuery)}. Check the number with the holder and try again.</div>`;
  } else {
    body = certificateHtml(state.detail);
  }
  return `<h2 class="view">Verify a certificate</h2>
    <p class="view">Open to anyone — employers, auditors and other institutes can check a certificate without an account. Reading the ledger never needs a key.</p>
    <div class="verifybar">
      <input id="q" placeholder="CERT-NL-2026-0417" value="${esc(state.verifyQuery)}">
      <button class="btn primary auto" id="dolookup">Look up</button>
    </div>${body}`;
}

function certificateHtml(detail) {
  const c = detail.certificate;
  const mine = state.session && state.session.id === c.instituteId;

  const fields = [
    ["certificateNumber", c.certificateNumber, true],
    ["holderName", c.holderName], ["organization", c.organization], ["course", c.course],
    ["courseDate", fmtDate(c.courseDate)], ["completionDate", fmtDate(c.completionDate)],
    ["expiryDate", fmtDate(c.expiryDate)], ["instructor", c.instructor],
    ["location", c.location], ["instituteName", c.instituteName]
  ].map(([k, v, mono]) => `<div class="field"><dt>${labelFor(k)}</dt><dd class="${mono ? "mono" : ""}">${esc(v)}</dd></div>`).join("");

  let notice = "";
  if (c.status === "REVOKED") {
    notice = `<div class="notice">Revoked by ${esc(c.instituteName)}. Reason sealed into the chain: ${esc(c.revokedReason)}</div>`;
  } else if (c.status === "SUPERSEDED") {
    notice = `<div class="notice grey">Renewed. The current certificate for this holder is ${esc(c.supersededBy)}.</div>`;
  } else if (c.validity.key === "expired") {
    notice = `<div class="notice">Expired ${Math.abs(c.validity.days)} days ago. The holder needs to requalify before this counts as current.</div>`;
  } else if (c.validity.key === "expiring") {
    notice = `<div class="notice grey">Expires in ${c.validity.days} days. Time to schedule the refresher.</div>`;
  }

  const trail = detail.history.map(b => `<li>
      <b>${EVENT_LABEL[b.eventType]}</b> — block ${pad(b.height)} ${b.contentsOk ? "" : "(contents no longer match the seal)"}
      <br><span class="when">${fmtSeal(b.sealedAt)} · ${short(b.hash)}</span>
      ${b.payload.reason ? "<br>" + esc(b.payload.reason) : ""}
    </li>`).join("");

  const actions = mine && c.status === "ACTIVE"
    ? `<button data-renew="${esc(c.certificateNumber)}">Renew this certificate</button>
       <button class="warn" data-revoke="${esc(c.certificateNumber)}">Revoke this certificate</button>`
    : "";

  return `<div class="face">
    <div class="facehead">
      <div><h3>${esc(c.course)}</h3><p>${esc(c.holderName)} · ${esc(c.organization)}</p></div>
      <span class="pill ${c.validity.key}">${esc(c.validity.label)}</span>
    </div>
    <dl class="fields">${fields}</dl>
    ${notice}
    <div class="seal"><h4>Seal check</h4>
      <div class="sealrow"><b>Contents</b><span>${detail.sealIntact ? "match the chain" : "no longer match the chain"}</span></div>
      <div class="sealrow"><b>Issued at</b><span>block ${pad(c.issuedHeight)}</span></div>
      <div class="sealrow"><b>Last event</b><span>block ${pad(c.lastHeight)}</span></div>
    </div>
    <div class="trail"><h4>Everything the chain records about this certificate</h4><ol>${trail}</ol></div>
    ${actions ? `<div class="faceactions">${actions}</div>` : ""}
  </div>`;
}

/* ----------------------------------------------------------------- render */

function render() {
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === state.view)));
  const host = document.getElementById("view");
  host.innerHTML =
    state.view === "register" ? registerHtml() :
    state.view === "ledger" ? ledgerHtml() :
    state.view === "issue" ? issueHtml() : verifyHtml();
  renderRail();
  if (state.view === "ledger" && state.expanded !== null) showRecomputedHash(state.expanded);
  if (state.justArrived !== null) setTimeout(() => { state.justArrived = null; }, 700);
}

async function showRecomputedHash(height) {
  const block = state.blocks.find(b => b.height === height);
  const slot = document.getElementById("recomp-" + height);
  if (!block || !slot) return;
  const recomputed = await hashBlock(block);
  slot.textContent = recomputed;
  slot.style.color = recomputed === block.hash ? "#2E6B47" : "#9A3C2C";
}

/* ----------------------------------------------------------------- modals */

function openModal(html) {
  const dialog = document.getElementById("modal");
  dialog.innerHTML = html;
  dialog.showModal();
}
function closeModal() { document.getElementById("modal").close(); }

function renewModal(number) {
  const cert = state.certificates.find(c => c.certificateNumber === number);
  const today = new Date().toISOString().slice(0, 10);
  const threeYears = new Date();
  threeYears.setFullYear(threeYears.getFullYear() + 3);
  openModal(`<h3>Renew ${esc(number)}</h3>
    <p>A renewal seals a new certificate and marks this one superseded. Both stay on the chain.</p>
    <div class="f"><label for="r-number">New certificate number</label><input id="r-number" class="mono" value="${esc(nextCertificateNumber())}"></div>
    <div class="grid2" style="margin-top:12px">
      <div class="f"><label for="r-course">Date of course</label><input id="r-course" type="date" value="${today}"></div>
      <div class="f"><label for="r-complete">Date of completion</label><input id="r-complete" type="date" value="${today}"></div>
      <div class="f"><label for="r-expiry">Expiration date</label><input id="r-expiry" type="date" value="${threeYears.toISOString().slice(0, 10)}"></div>
      <div class="f"><label for="r-instructor">Name of instructor</label><input id="r-instructor" value="${esc(cert?.instructor || "")}"></div>
    </div>
    <div class="formfoot">
      <button class="btn primary auto" data-confirm-renew="${esc(number)}">Seal the renewal</button>
      <button class="btn quiet auto" data-close>Cancel</button>
    </div>`);
}

function revokeModal(number) {
  openModal(`<h3>Revoke ${esc(number)}</h3>
    <p>Revocation appends a block. The certificate stays readable on the chain with the reason attached, which is what makes the record auditable rather than deniable.</p>
    <div class="f"><label for="v-reason">Reason</label><input id="v-reason" placeholder="Why is this certificate being withdrawn?"></div>
    <div class="formfoot">
      <button class="btn danger auto" data-confirm-revoke="${esc(number)}">Seal the revocation</button>
      <button class="btn quiet auto" data-close>Cancel</button>
    </div>`);
}

/* ----------------------------------------------------------------- events */

document.addEventListener("click", async e => {
  const t = e.target.closest("button, input#mineonly");
  if (!t) return;

  if (t.classList.contains("tab")) { state.view = t.dataset.view; state.expanded = null; render(); return; }
  if (t.hasAttribute("data-close")) { closeModal(); return; }

  if (t.id === "go-issue") {
    state.view = "issue";
    if (!state.draft.certificateNumber) state.draft.certificateNumber = nextCertificateNumber();
    render(); return;
  }

  if (t.id === "go-check") {
    const { blocks } = await api("/chain");
    state.blocks = blocks;
    state.audit = await verifyLocally(blocks);
    render(); renderAudit(true);
    toast(state.audit.intact
      ? `Chain verified in your browser — all ${blocks.length} blocks match their seals.`
      : `Chain broken at block ${pad(state.audit.firstBreak.height)}.`, !state.audit.intact);
    return;
  }

  if (t.id === "mineonly") { state.mineOnly = t.checked; render(); return; }
  if (t.dataset.filter !== undefined) { state.filter = t.dataset.filter; render(); return; }

  if (t.dataset.block !== undefined) {
    const h = Number(t.dataset.block);
    state.expanded = state.expanded === h ? null : h;
    render(); return;
  }

  if (t.dataset.open !== undefined) { await lookup(t.dataset.open); return; }
  if (t.id === "dolookup") { await lookup(document.getElementById("q").value.trim()); return; }

  if (t.id === "clear") { state.draft = blankDraft(); state.formErrors = {}; render(); return; }

  if (t.id === "sample") {
    const today = new Date();
    const plus3 = new Date(); plus3.setFullYear(plus3.getFullYear() + 3);
    state.draft = {
      certificateNumber: nextCertificateNumber(),
      holderName: "Erin Kavanagh",
      organization: "Terra Nova Marine Services",
      course: "Confined space entry and rescue",
      courseDate: today.toISOString().slice(0, 10),
      completionDate: today.toISOString().slice(0, 10),
      expiryDate: plus3.toISOString().slice(0, 10),
      instructor: "Colleen Hefferton",
      location: "St. John's, Newfoundland and Labrador"
    };
    state.formErrors = {};
    render(); return;
  }

  if (t.id === "seal") { await seal(); return; }
  if (t.dataset.renew !== undefined) { renewModal(t.dataset.renew); return; }
  if (t.dataset.revoke !== undefined) { revokeModal(t.dataset.revoke); return; }
  if (t.dataset.confirmRenew !== undefined) { await confirmRenew(t.dataset.confirmRenew); return; }
  if (t.dataset.confirmRevoke !== undefined) { await confirmRevoke(t.dataset.confirmRevoke); return; }
});

document.addEventListener("input", e => {
  const id = e.target.id || "";
  if (id.startsWith("in-")) state.draft[id.slice(3)] = e.target.value;
});

document.addEventListener("keydown", async e => {
  if (e.key === "Enter" && e.target.id === "q") await lookup(e.target.value.trim());
});

document.getElementById("institute").addEventListener("change", e => {
  state.instituteId = e.target.value;
  render();
});

document.getElementById("apikey").addEventListener("change", async e => {
  state.apiKey = e.target.value.trim();
  await refreshSession();
  if (state.session) {
    state.instituteId = state.session.id;
    document.getElementById("institute").value = state.session.id;
    toast("Signed in as " + state.session.name + ". You can now seal, renew and revoke.");
  } else if (state.apiKey) {
    toast("That key is not recognised. Reading the ledger still works without one.", true);
  }
  render();
});

/* ----------------------------------------------------------------- writes */

async function lookup(number) {
  state.verifyQuery = number;
  state.view = "verify";
  if (!number) { state.detail = undefined; render(); return; }
  try {
    state.detail = await api("/certificates/" + encodeURIComponent(number));
  } catch (err) {
    state.detail = err.status === 404 ? null : undefined;
    if (err.status !== 404) toast(err.message, true);
  }
  render();
}

async function seal() {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await api("/certificates", { method: "POST", body: JSON.stringify(state.draft) });
    state.formErrors = {};
    state.draft = blankDraft();
    await loadEverything();
    state.audit = await verifyLocally(state.blocks);
    state.justArrived = result.block.height;
    state.expanded = result.block.height;
    state.view = "ledger";
    render(); renderAudit(false);
    toast(`Sealed as block ${pad(result.block.height)} — ${result.certificate.certificateNumber}.`);
  } catch (err) {
    state.formErrors = err.body?.errors || {};
    render();
    toast(Object.keys(state.formErrors).length ? "Fix the highlighted fields, then seal." : err.message, true);
  } finally {
    state.busy = false;
  }
}

async function confirmRenew(number) {
  const payload = {
    certificateNumber: document.getElementById("r-number").value.trim(),
    courseDate: document.getElementById("r-course").value,
    completionDate: document.getElementById("r-complete").value,
    expiryDate: document.getElementById("r-expiry").value,
    instructor: document.getElementById("r-instructor").value.trim()
  };
  try {
    const result = await api(`/certificates/${encodeURIComponent(number)}/renew`, { method: "POST", body: JSON.stringify(payload) });
    closeModal();
    await loadEverything();
    state.audit = await verifyLocally(state.blocks);
    await lookup(result.certificate.certificateNumber);
    renderAudit(false);
    toast(`Renewed at block ${pad(result.block.height)}. ${number} is now superseded.`);
  } catch (err) {
    toast(err.body?.errors ? Object.values(err.body.errors)[0] : err.message, true);
  }
}

async function confirmRevoke(number) {
  const reason = document.getElementById("v-reason").value.trim();
  try {
    const result = await api(`/certificates/${encodeURIComponent(number)}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });
    closeModal();
    await loadEverything();
    state.audit = await verifyLocally(state.blocks);
    await lookup(number);
    renderAudit(false);
    toast(`Revocation sealed at block ${pad(result.block.height)}.`);
  } catch (err) {
    toast(err.body?.errors ? Object.values(err.body.errors)[0] : err.message, true);
  }
}

/* ------------------------------------------------------------------- boot */

(async function start() {
  try {
    await loadEverything();
    document.getElementById("institute").innerHTML =
      state.institutes.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("");
    document.getElementById("institute").value = state.instituteId;
    state.audit = await verifyLocally(state.blocks);
    render();
    renderAudit(false);
  } catch (err) {
    document.getElementById("view").innerHTML =
      `<div class="empty"><b>The ledger did not answer</b>${esc(err.message)}. If this is a free hosting plan the service may be waking up — wait about a minute and reload.</div>`;
  }
})();
