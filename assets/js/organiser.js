// Organiser app: sign in, events, registrations → passes, links, gate code, live counter.
import {
  cfg, configured, ART, artUrl, passUrl, gateUrl, fmtCode, fmtWhen, fmtTime, fmtDay, fmtAgo, esc, plural,
  store, copyText, toast, download, qrSvg, I, paintIcons, PAUSED_MSG, escT, typo,
} from "./core.js";
import { parseTable, analyse, toPasses, toCsv, isEmail, isPhone } from "./csv.js";
import { getSupabaseClient } from "./supabase-client.js";

const view = document.getElementById("view");
const roleEl = document.getElementById("role");
let sb = null;
let session = null;
let live = null;          // realtime channel for the open event
let pollTimer = null;

const MAX_ROWS = 5000;

// ─────────────────────────────────────────────── boot

function notConfigured() {
  view.innerHTML = `
    <section class="stack narrow">
      <div class="poster hero-poster" id="art"><h1 class="poster-title ink">Almost there</h1><p class="poster-club">Connect your Supabase project</p></div>
      <ol class="sub" style="padding-left:20px;margin:6px 0 0;display:grid;gap:6px">
        <li>Create a free project at supabase.com.</li>
        <li>Run <b>schema.sql</b> in its SQL editor.</li>
        <li>Put the project URL and anon key in <b>config.js</b>.</li>
      </ol>
      <a class="btn" href="../README.md#host-your-own-copy-free-5-steps">Read the 5-step guide ${I.open}</a>
    </section>`;
  view.querySelector("#art").style.backgroundImage = `url("${artUrl(0)}")`;
}

async function boot() {
  if (!configured || !window.supabase) return notConfigured();
  sb = getSupabaseClient();
  const hashErr = new URLSearchParams((location.hash || "").replace(/^#/, "")).get("error_description");
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((evt, s) => {
    const was = !!session;
    session = s;
    if (evt === "SIGNED_OUT" || (!was && s)) route();
  });
  window.addEventListener("hashchange", route);
  if (hashErr && !session) {
    history.replaceState(null, "", location.pathname);
    return signInView(/expired|invalid/i.test(hashErr) ? "That sign-in link expired or was already used. Send a new one." : hashErr);
  }
  route();
}

function route() {
  stopLive();
  const h = location.hash || "";
  if (/access_token|error_description|refresh_token/.test(h)) return; // the SDK is still reading a sign-in link
  if (route.last !== undefined && route.last !== h) window.scrollTo(0, 0);
  route.last = h;
  if (!session) return signInView();
  roleEl.innerHTML = `Organiser <button class="icon-btn" type="button" id="signout" title="Sign out (${esc(session.user.email || "")})" aria-label="Sign out" style="width:36px;height:36px;margin-left:4px">${I.out}</button>`;
  roleEl.querySelector("#signout").addEventListener("click", async () => { await sb.auth.signOut(); location.hash = ""; });
  const m = h.match(/^#\/e\/([0-9a-f-]{36})(\/edit)?$/);
  if (h === "#/new") return eventForm();
  if (m) return m[2] ? eventForm(m[1]) : eventView(m[1]);
  return listView();
}

function fail(e) {
  const msg = e?.message || String(e);
  const paused = /fetch|network|Failed to fetch|5\d\d/.test(msg) ? PAUSED_MSG + " Or check your connection." : msg;
  view.innerHTML = `<section class="empty"><h3>Something broke</h3><p class="sub">${esc(paused)}</p><p style="margin-top:14px"><button class="btn small" type="button" onclick="location.reload()">${I.refresh}Try again</button></p></section>`;
}

// ─────────────────────────────────────────────── sign in

function signInView(errMsg = "") {
  roleEl.textContent = "Organiser";
  document.title = "GatePass · free QR entry passes for club events";
  view.innerHTML = `
    <section class="signin">
      <div class="poster hero-poster" id="art">
        <span class="hero-art-backdrop" aria-hidden="true">
          <img class="hero-art-image hero-art-light" src="../images/creator-light.png" alt="">
          <img class="hero-art-image hero-art-dark" src="../images/creator-dark.png" alt="">
        </span>
        <span class="hero-copy-scrim" aria-hidden="true"></span>
        <span class="hero-ticket-glint" aria-hidden="true"></span>
        <h1 class="poster-title ink">Free entry passes</h1>
        <p class="poster-club">For your club's next event</p>
        <span class="poster-when">Open source · ₹0</span>
      </div>
      <div class="stack" style="margin-top:14px">
      <p class="sub" style="font-size:17px;color:var(--blue)">Upload your registrations sheet and everyone gets their own QR pass. At the gate, any phone becomes the scanner. A screenshot of a pass works once.</p>

      ${cfg.emailSignIn === false ? `
      <p class="err" id="sErr" role="alert" ${errMsg ? "" : "hidden"}>${esc(errMsg)}</p>
      <button class="btn-primary compact" type="button" id="google"><span class="gdisc">${I.google}</span><span class="label">Continue with Google</span><span class="arrow">${I.arrow}</span></button>
      <p class="fine" style="margin:0">Organisers sign in with Google. Gate staff and attendees never need an account.</p>` : `
      <form id="signin" class="stack" novalidate style="margin-top:6px">
        <label class="field"><span>Organiser email</span>
          <input class="input" type="email" id="email" autocomplete="email" inputmode="email" placeholder="you@college.edu" required value="${esc(store.get("gp.email", ""))}">
        </label>
        <p class="err" id="sErr" role="alert" ${errMsg ? "" : "hidden"}>${esc(errMsg)}</p>
        <button class="btn-primary compact" type="submit" id="sendBtn"><span class="label">Send me a sign-in link</span><span class="arrow">${I.arrow}</span></button>
      </form>
      ${cfg.googleSignIn ? `<div class="or">or</div>
      <button class="row" type="button" id="google" style="min-height:62px;justify-content:center">${I.google}<span>Continue with Google</span></button>` : ""}`}
      <div class="links" style="margin-top:8px">
        <a href="../gate/">${I.qr} Gate staff? Join with a code</a>
        <a href="../README.md#host-your-own-copy-free-5-steps">${I.open} Host your own copy</a>
      </div>
      </div>
    </section>`;
  view.querySelectorAll(".links svg").forEach((s) => { s.style.width = "18px"; s.style.height = "18px"; });
  const form = view.querySelector("#signin"), err = view.querySelector("#sErr"), btn = view.querySelector("#sendBtn");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = view.querySelector("#email").value.trim();
    if (!isEmail(email)) { err.textContent = "That email doesn't look right."; err.hidden = false; return; }
    store.set("gp.email", email);
    btn.disabled = true; btn.querySelector(".label").textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: new URL("./", location.href).href, shouldCreateUser: true } });
    btn.disabled = false; btn.querySelector(".label").textContent = "Send me a sign-in link";
    if (error) {
      err.textContent = /rate|too many|seconds/i.test(error.message)
        ? `Too many sign-in emails right now. ${cfg.googleSignIn ? "Use Google, or wait" : "Wait"} a few minutes and try again.`
        : error.message;
      err.hidden = false;
      return;
    }
    checkInbox(email);
  });
  view.querySelector("#google")?.addEventListener("click", async (event) => {
    const googleButton = event.currentTarget;
    const errorMessage = view.querySelector("#sErr");
    googleButton.disabled = true;
    if (errorMessage) errorMessage.hidden = true;
    try {
      const { data, error } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: new URL("./", location.href).href,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
      if (!data?.url) throw new Error("Google sign-in did not return a redirect URL.");
    } catch (error) {
      if (!googleButton.isConnected) return;
      googleButton.disabled = false;
      if (errorMessage) {
        errorMessage.textContent = error?.message || String(error);
        errorMessage.hidden = false;
      }
    }
  });
}

function checkInbox(email) {
  view.innerHTML = `
    <section class="stack narrow">
      <div class="empty">
        <h3>Check your inbox</h3>
        <p class="sub" style="color:var(--blue)">We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device. It works once and expires in an hour.</p>
        <p class="fine" style="margin:10px 0 0">Nothing after a minute? Look in spam, or go back and try again.</p>
      </div>
      <button class="btn" type="button" id="again">${I.back} Use a different email</button>
    </section>`;
  view.querySelector("#again").addEventListener("click", () => signInView());
}

// ─────────────────────────────────────────────── events list

async function listView() {
  document.title = "Your events · GatePass";
  view.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
  const { data, error } = await sb.from("gp_events")
    .select("id,name,club,starts_at,venue,art,gp_passes(count),gp_scans(count)")
    .eq("gp_scans.is_first", true)
    .order("starts_at", { ascending: false });
  if (error) return fail(error);
  const now = Date.now();
  const stubs = data.map((e) => {
    const total = e.gp_passes?.[0]?.count ?? 0, checked = e.gp_scans?.[0]?.count ?? 0;
    const past = new Date(e.starts_at).getTime() < now - 12 * 3600e3;
    return `
      <a class="stub" href="#/e/${e.id}" style="${past ? "opacity:.72" : ""}">
        <span class="stub-art" style="background-image:url('${artUrl(e.art, true)}')"></span>
        <span class="stub-body">
          <span class="stub-name ink">${escT(e.name)}</span>
          <span class="stub-meta">${esc(fmtWhen(e.starts_at))}${e.venue ? ` · ${esc(e.venue)}` : ""}</span>
        </span>
        <span class="stub-count">${checked} / ${total}<small>${total ? "checked in" : "no passes yet"}</small></span>
      </a>`;
  }).join("");
  view.innerHTML = `
    <section class="stack narrow">
      <div class="head-row"><h1 class="head">Your events</h1></div>
      ${data.length ? stubs : `
        <div class="empty">
          <h3>No events yet</h3>
          <p class="sub" style="color:var(--blue)">Make one, drop in your registrations sheet, and every row gets a pass.</p>
        </div>`}
      <a class="btn-primary compact" href="#/new" style="margin-top:6px"><span class="tix">${I.ticket}</span><span class="label">New event</span><span class="arrow">${I.arrow}</span></a>
    </section>`;
}

// ─────────────────────────────────────────────── create / edit event

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

async function eventForm(id = null) {
  let ev = { name: "", club: "", venue: "", art: 0, starts_at: null };
  if (id) {
    const { data, error } = await sb.from("gp_events").select("*").eq("id", id).maybeSingle();
    if (error) return fail(error);
    if (!data) { location.hash = ""; return; }
    ev = data;
  }
  const when = ev.starts_at ? new Date(ev.starts_at) : (() => { const d = nextSaturday(); d.setHours(18, 0, 0, 0); return d; })();
  document.title = `${id ? "Edit" : "New"} event · GatePass`;
  view.innerHTML = `
    <div class="narrow">
    <a class="backlink" href="${id ? `#/e/${id}` : "#"}">${I.back}${id ? "Back to the event" : "Your events"}</a>
    <form id="evForm" class="stack" novalidate>
      <h1 class="head">${id ? "Edit event" : "New event"}</h1>
      <label class="field"><span>Event name</span><input class="input" name="name" maxlength="80" required placeholder="e.g. Freshers’ Night 2026" value="${esc(ev.name)}"></label>
      <label class="field"><span>Club</span><input class="input" name="club" maxlength="80" placeholder="e.g. Photography Club" value="${esc(ev.club)}"></label>
      <div class="two">
        <label class="field"><span>Date</span><input class="input" type="date" name="date" required value="${ymd(when)}"></label>
        <label class="field"><span>Time</span><input class="input" type="time" name="time" required value="${hm(when)}"></label>
      </div>
      <label class="field"><span>Venue</span><input class="input" name="venue" maxlength="120" placeholder="e.g. Main Auditorium" value="${esc(ev.venue)}"></label>
      <fieldset class="field" style="border:0;margin:0;padding:0"><span>Poster art</span>
        <div class="art-pick">
          ${ART.map((a, i) => `<label><input type="radio" name="art" value="${i}" ${i === ev.art ? "checked" : ""} aria-label="${a.name}"><img src="${artUrl(i, true)}" alt="" loading="lazy" width="240" height="240"><span class="art-name">${a.name}</span></label>`).join("")}
        </div>
      </fieldset>
      <p class="err" id="fErr" role="alert" hidden></p>
      <button class="btn-primary compact" type="submit" id="saveBtn"><span class="label">${id ? "Save changes" : "Create event"}</span><span class="arrow">${I.arrow}</span></button>
    </form>
    </div>`;
  const form = view.querySelector("#evForm"), err = view.querySelector("#fErr");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const name = String(f.get("name")).trim();
    const starts = new Date(`${f.get("date")}T${f.get("time") || "18:00"}`);
    if (!name) { err.textContent = "Give the event a name."; err.hidden = false; return form.name.focus(); }
    if (isNaN(starts)) { err.textContent = "Pick a date and time."; err.hidden = false; return; }
    const row = { name, club: String(f.get("club")).trim(), venue: String(f.get("venue")).trim(), art: Number(f.get("art") || 0), starts_at: starts.toISOString() };
    const btn = view.querySelector("#saveBtn"); btn.disabled = true;
    const q = id ? sb.from("gp_events").update(row).eq("id", id).select("id").single() : sb.from("gp_events").insert(row).select("id").single();
    const { data, error } = await q;
    btn.disabled = false;
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    location.hash = `#/e/${data.id}`;
  });
}

// ─────────────────────────────────────────────── one event

async function fetchAll(table, cols, eventId, extra = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await extra(sb.from(table).select(cols).eq("event_id", eventId)).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function eventView(id) {
  view.innerHTML = `<div class="dash-skeleton" aria-hidden="true"><div class="skeleton dash-skeleton-poster"></div><div class="dash-skeleton-right"><div class="skeleton dash-skeleton-card"></div><div class="skeleton dash-skeleton-card"></div></div></div>`;
  let ev, passes, scans, registrations;
  try {
    const r = await sb.from("gp_events").select("*").eq("id", id).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) { toast("That event isn't yours or was deleted", "x"); location.hash = ""; return; }
    ev = r.data;
    [passes, scans, registrations] = await Promise.all([
      fetchAll("gp_passes", "id,name,contact,token,created_at", id),
      fetchAll("gp_scans", "id,pass_id,is_first,gate,scanned_at", id),
      fetchAll("gp_registrations", "id,event_id,user_id,name,phone,email,reg_no,semester,branch,pass_id,created_at", id),
    ]);
  } catch (e) { return fail(e); }

  passes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name));
  const state = {
    ev, passes, registrations, first: new Map(), bounced: 0, upload: null, filter: "", shown: 120,
    regSearch: "", regBranch: "", regSemester: "", regSelected: new Set(), regPage: 1,
  };
  for (const s of scans) s.is_first ? state.first.set(s.pass_id, s) : state.bounced++;

  document.title = `${typo(ev.name)} · GatePass`;
  view.innerHTML = `
    <a class="backlink" href="#">${I.back}Your events</a>
    <div class="dash">
      <div class="left stack">
        <div class="poster" id="poster">
          <h1 class="poster-title ink">${escT(ev.name)}</h1>
          ${ev.club ? `<p class="poster-club">${esc(ev.club)}</p>` : ""}
          <span class="poster-when">${esc(fmtWhen(ev.starts_at))}${ev.venue ? ` · ${esc(ev.venue)}` : ""}</span>
        </div>
        <div id="regSlot" class="stack"></div>
        <div class="stat grain" id="stat"></div>
        <div class="gatebox" id="gatebox"></div>
      </div>
      <div class="right stack">
        <section class="registration-admin stack" aria-labelledby="registrationAdminHeading">
          <div class="head-row"><h2 class="head" id="registrationAdminHeading">Registrations</h2><span class="fine" id="registrationCount"></span></div>
          <div id="registrationsSlot"></div>
        </section>
        <section class="pass-admin stack" aria-labelledby="passesHeading">
          <div class="head-row"><h2 class="head" id="passesHeading">Passes</h2><span class="fine" id="pcount"></span></div>
          <div id="passTools" class="stack"></div>
          <ul class="passlist" id="plist"></ul>
          <div class="more-row" id="more"></div>
        </section>
        <div class="danger-zone">
          <a class="btn small" href="#/e/${id}/edit">Edit details</a>
          <button class="btn small danger" type="button" id="del">${I.trash}Delete event</button>
        </div>
      </div>
    </div>
    <dialog class="registration-confirm" id="registrationConfirm" aria-labelledby="registrationConfirmTitle" aria-describedby="registrationConfirmDescription"></dialog>`;
  view.querySelector("#poster").style.backgroundImage = `url("${artUrl(ev.art)}")`;

  renderReg(state);
  renderStat(state);
  renderGate(state);
  renderRegistrations(state);
  renderPassTools(state);
  renderList(state);

  const del = view.querySelector("#del");
  let armed = 0;
  del.addEventListener("click", async () => {
    if (Date.now() - armed > 4000) { armed = Date.now(); del.innerHTML = `${I.trash}Tap again to delete ${plural(state.passes.length, "pass", "passes")}`; setTimeout(() => { if (del.isConnected) del.innerHTML = `${I.trash}Delete event`; }, 4000); return; }
    del.disabled = true;
    const { error } = await sb.from("gp_events").delete().eq("id", id);
    if (error) { del.disabled = false; return toast(error.message, "x"); }
    toast("Event deleted");
    location.hash = "";
  });

  startLive(state);
}

// ── registrations: file / paste → preview → generate ──
function renderReg(state) {
  const slot = view.querySelector("#regSlot");
  const has = state.passes.length;
  const up = state.upload;
  if (!up) {
    slot.innerHTML = `
      <label class="row" id="pick">
        <input type="file" id="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" class="sr">
        <span style="width:30px;height:36px;display:block">${I.doc}</span>
        <span class="grow">${has ? "Add more registrations" : "Upload registrations.csv"}<small>Google Form export, or any sheet with a name column</small></span>
        <span class="chev">${I.chev}</span>
      </label>
      <button class="btn small" type="button" id="pasteBtn" style="align-self:flex-start">${I.copy}Or paste rows from your sheet</button>
      <div id="pasteBox" class="stack" hidden>
        <textarea class="textarea" id="pasteTa" placeholder="Copy the cells in Google Sheets (with the header row) and paste here.&#10;Name, Email or Phone, …"></textarea>
        <button class="btn" type="button" id="pasteUse">Use these rows</button>
      </div>`;
    slot.querySelector("#file").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > 4e6) return toast("That file is over 4 MB. Export just the responses sheet.", "x");
      loadRows(state, await f.text(), f.name);
    });
    slot.querySelector("#pasteBtn").addEventListener("click", () => {
      const box = slot.querySelector("#pasteBox");
      box.hidden = !box.hidden;
      if (!box.hidden) slot.querySelector("#pasteTa").focus();
    });
    slot.querySelector("#pasteUse").addEventListener("click", () => loadRows(state, slot.querySelector("#pasteTa").value, "pasted rows"));
    return;
  }

  const { a, fileName, nameCol, contactCol, open } = up;
  const res = toPasses(a, nameCol, contactCol, state.passes);
  up.res = res;
  const n = res.passes.length;
  const skipped = [res.blank && `${plural(res.blank, "row")} without a name`, res.dup && `${plural(res.dup, "duplicate")}`].filter(Boolean).join(", ");
  const opt = (sel, none) => `${none ? `<option value="-1" ${sel === -1 ? "selected" : ""}>None</option>` : ""}${a.cols.map((c) => `<option value="${c.i}" ${c.i === sel ? "selected" : ""}>${esc(c.label)}</option>`).join("")}`;
  slot.innerHTML = `
    <button class="row" type="button" id="toggle" aria-expanded="${open ? "true" : "false"}">
      <span style="width:30px;height:36px;display:block">${I.doc}</span>
      <span class="grow"><span class="fname">${esc(fileName)} · ${plural(a.body.length, "row")}</span>${skipped ? `<small>${n} new · skipping ${skipped}</small>` : ""}</span>
      <span class="chev" style="transition:rotate .2s;${open ? "rotate:90deg" : ""}">${I.chev}</span>
    </button>
    <div class="upload-preview" ${open ? "" : "hidden"}>
      <div class="two">
        <label class="field"><span>Name column</span><select class="select" id="nameCol">${opt(nameCol)}</select></label>
        <label class="field"><span>Contact column</span><select class="select" id="contactCol">${opt(contactCol, true)}</select></label>
      </div>
      <table class="preview-table">
        <thead><tr><th>Name</th><th>Contact</th></tr></thead>
        <tbody>${res.passes.slice(0, 5).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.contact || "—")}</td></tr>`).join("") || `<tr><td colspan="2">No usable rows. Pick the column that has names.</td></tr>`}</tbody>
      </table>
      ${n > 5 ? `<p class="fine" style="margin:0">…and ${n - 5} more.</p>` : ""}
      <button class="btn small pinkline" type="button" id="cancelUp" style="align-self:flex-start">${I.x}Cancel</button>
    </div>
    <button class="btn-primary" type="button" id="gen" ${n ? "" : "disabled"}>
      <span class="tix">${I.ticket}</span>
      <span class="label">Generate ${n} ${n === 1 ? "pass" : "passes"}</span>
      <span class="arrow">${I.arrow}</span>
    </button>`;
  slot.querySelector("#toggle").addEventListener("click", () => { up.open = !up.open; renderReg(state); });
  slot.querySelector("#nameCol")?.addEventListener("change", (e) => { up.nameCol = +e.target.value; renderReg(state); });
  slot.querySelector("#contactCol")?.addEventListener("change", (e) => { up.contactCol = +e.target.value; renderReg(state); });
  slot.querySelector("#cancelUp")?.addEventListener("click", () => { state.upload = null; renderReg(state); });
  slot.querySelector("#gen").addEventListener("click", () => generate(state));
}

function loadRows(state, text, fileName) {
  const rows = parseTable(text);
  if (!rows.length) return toast("That sheet is empty", "x");
  const a = analyse(rows);
  if (a.body.length > MAX_ROWS) return toast(`That's ${a.body.length} rows. GatePass takes up to ${MAX_ROWS} at a time.`, "x");
  state.upload = { a, fileName, nameCol: a.name, contactCol: a.contact, open: !a.hasHeader };
  renderReg(state);
}

async function generate(state) {
  const up = state.upload;
  const list = up.res.passes;
  const slot = view.querySelector("#regSlot");
  const total = list.length;
  slot.innerHTML = `
    <div class="row" style="min-height:60px"><span style="width:30px;height:36px;display:block">${I.doc}</span><span class="grow">${esc(up.fileName)} · ${plural(total, "pass", "passes")}</span></div>
    <div class="btn-primary" aria-live="polite" style="cursor:progress">
      <span class="tix">${I.ticket}</span>
      <span class="label"><span class="gen-count" id="gc" style="color:#fff;font-size:inherit">0</span> / ${total} passes<small>Making unguessable links…</small></span>
      <span class="spinner"></span>
    </div>`;
  const gc = slot.querySelector("#gc");
  let done = 0, shown = 0, failed = null;
  const tick = () => {
    if (shown < done) { shown += Math.max(1, Math.ceil((done - shown) / 6)); gc.textContent = Math.min(shown, done); }
    if (shown < total && !failed) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  for (let i = 0; i < total; i += 100) {
    const batch = list.slice(i, i + 100).map((p) => ({ event_id: state.ev.id, name: p.name, contact: p.contact }));
    const { data, error } = await sb.from("gp_passes").insert(batch).select("id,name,contact,token,created_at");
    if (error) { failed = error; break; }
    state.passes.push(...data);
    done += data.length;
  }
  await new Promise((r) => setTimeout(r, 450));
  gc.textContent = done;
  state.upload = null;
  if (failed) toast(`Stopped after ${done}: ${failed.message}`, "x");
  else toast(`${plural(done, "pass", "passes")} ready`);
  renderReg(state); renderStat(state); renderPassTools(state); renderList(state);
}

// ── attendee registrations (separate from imported pass rows) ──
function registrationCheckedIn(state, registration) {
  return registration.pass_id ? state.first.get(registration.pass_id) || null : null;
}

function registrationRow(state, registration, mobile = false) {
  const scan = registrationCheckedIn(state, registration);
  const checkbox = `<input type="checkbox" data-reg-select="${esc(registration.id)}" aria-label="Select ${esc(registration.name)}">`;
  const remove = `<button class="btn small danger registration-delete" type="button" data-reg-delete="${esc(registration.id)}" aria-label="Delete registration for ${esc(registration.name)}" title="Delete registration">${I.trash}<span class="sr">Delete</span></button>`;
  const registered = fmtAgo(registration.created_at);
  const registeredFull = fmtWhen(registration.created_at);
  if (mobile) return `
    <article class="registration-card">
      <div class="registration-card-top">${checkbox}<strong title="${esc(registration.name)}">${esc(registration.name)}</strong>${scan ? `<span class="registration-checked">Checked in</span>` : ""}${remove}</div>
      <dl>
        <div><dt>Phone</dt><dd>${esc(registration.phone)}</dd></div>
        <div><dt>Email</dt><dd>${esc(registration.email || "—")}</dd></div>
        <div><dt>SAN/USN</dt><dd>${esc(registration.reg_no)}</dd></div>
        <div><dt>Semester · Branch</dt><dd>${esc(registration.semester)} · ${esc(registration.branch)}</dd></div>
        <div><dt>Registered</dt><dd title="${esc(registeredFull)}">${esc(registered)}</dd></div>
        ${scan ? `<div><dt>Checked in at</dt><dd>${esc(fmtTime(scan.scanned_at))}</dd></div>` : `<div><dt>Status</dt><dd><span class="registration-not-checked">Not checked in</span></dd></div>`}
      </dl>
    </article>`;
  return `<tr>
    <td>${checkbox}</td><td><div class="registration-attendee"><strong title="${esc(registration.name)}">${esc(registration.name)}</strong><small title="${esc(registration.email || "—")}">${esc(registration.email || "—")}</small></div></td>
    <td title="${esc(registration.reg_no)}">${esc(registration.reg_no)}</td><td title="${esc(registration.phone)}">${esc(registration.phone)}</td>
    <td title="${esc(`${registration.semester} · ${registration.branch}`)}">${esc(registration.semester)} · ${esc(registration.branch)}</td>
    <td title="${esc(registeredFull)}">${esc(registered)}</td><td>${scan ? `<span class="registration-checked">Checked in</span>` : `<span class="registration-not-checked">Not checked in</span>`}</td><td>${remove}</td>
  </tr>`;
}

function renderRegistrations(state) {
  const slot = view.querySelector("#registrationsSlot");
  if (!slot) return;
  view.querySelector("#registrationCount").textContent = plural(state.registrations.length, "registration");
  view.querySelector("#registrationCount").setAttribute("aria-live", "polite");
  const branches = [...new Set(state.registrations.map((row) => row.branch))].sort();
  const semesters = [...new Set(state.registrations.map((row) => Number(row.semester)))].sort((a, b) => a - b);
  const query = state.regSearch.trim().toLowerCase();
  const matches = state.registrations.filter((row) => {
    const searchMatch = !query || [row.name, row.reg_no, row.phone].some((value) => String(value || "").toLowerCase().includes(query));
    return searchMatch && (!state.regBranch || row.branch === state.regBranch) && (!state.regSemester || String(row.semester) === state.regSemester);
  }).sort((a, b) => a.name.localeCompare(b.name));
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  state.regPage = Math.min(Math.max(1, state.regPage), pageCount);
  const visibleRows = matches.slice((state.regPage - 1) * pageSize, state.regPage * pageSize);
  if (!state.registrations.length) {
    slot.innerHTML = `<p class="sub registration-empty">No attendee registrations yet.</p>`;
    return;
  }
  const selectedVisible = visibleRows.filter((row) => state.regSelected.has(row.id));
  const selectedRows = state.registrations.filter((row) => state.regSelected.has(row.id));
  const noMatches = `<div class="registration-no-matches"><p class="sub">No registrations match these filters.</p><button class="btn small registration-clear-filters" type="button" data-clear-reg-filters>Clear filters</button></div>`;
  slot.innerHTML = `
    <div class="registration-tools">
      <label class="search registration-search"><span>${I.search}</span><input class="input" id="regSearch" type="search" aria-label="Search registrations by name, SAN/USN or phone" placeholder="Search name, SAN/USN or phone" value="${esc(state.regSearch)}"></label>
      <div class="registration-filters">
        <label class="field"><span>Branch</span><select class="select" id="regBranchFilter"><option value="">All branches</option>${branches.map((branch) => `<option value="${esc(branch)}" ${state.regBranch === branch ? "selected" : ""}>${esc(branch)}</option>`).join("")}</select></label>
        <label class="field"><span>Semester</span><select class="select" id="regSemesterFilter"><option value="">All semesters</option>${semesters.map((semester) => `<option value="${semester}" ${state.regSemester === String(semester) ? "selected" : ""}>${semester}</option>`).join("")}</select></label>
      </div>
      <div class="registration-actions">
        <button class="btn small" type="button" id="exportRegistrations" aria-label="Export registrations as CSV">Export CSV</button>
      </div>
    </div>
    <div class="registration-table-wrap">
      <table class="registration-table">
        <thead><tr><th><input type="checkbox" id="selectVisible" aria-label="Select visible registrations" ${visibleRows.length && visibleRows.every((row) => state.regSelected.has(row.id)) ? "checked" : ""}></th><th>Attendee</th><th>SAN/USN</th><th>Phone</th><th>Sem · Branch</th><th>Registered</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${visibleRows.map((row) => registrationRow(state, row)).join("") || `<tr><td colspan="8">${noMatches}</td></tr>`}</tbody>
      </table>
    </div>
    <div class="registration-cards">${visibleRows.map((row) => registrationRow(state, row, true)).join("") || noMatches}</div>
    <div class="registration-pagination"><span>Showing ${matches.length ? (state.regPage - 1) * pageSize + 1 : 0}–${Math.min(state.regPage * pageSize, matches.length)} of ${matches.length}</span><div class="registration-pages"><button class="btn small" type="button" id="previousRegistrationPage" ${state.regPage <= 1 ? "disabled" : ""}>Previous</button><button class="btn small registration-more" type="button" id="showMoreRegistrations" ${state.regPage >= pageCount ? "disabled" : ""}>Next</button></div></div>
    <div class="registration-bulk" id="registrationBulk" ${selectedRows.length ? "" : "hidden"}><span class="registration-bulk-count">${selectedRows.length} selected</span><button class="btn small danger" type="button" id="deleteSelected">Delete selected</button><button class="btn small" type="button" id="clearRegSelection">Clear</button></div>`;

  const search = slot.querySelector("#regSearch");
  search.addEventListener("input", () => {
    const position = search.selectionStart;
    state.regSearch = search.value;
    state.regPage = 1;
    renderRegistrations(state);
    const replacement = slot.querySelector("#regSearch");
    replacement.focus();
    replacement.setSelectionRange(position, position);
  });
  slot.querySelector("#regBranchFilter").addEventListener("change", (event) => { state.regBranch = event.target.value; state.regPage = 1; renderRegistrations(state); });
  slot.querySelector("#regSemesterFilter").addEventListener("change", (event) => { state.regSemester = event.target.value; state.regPage = 1; renderRegistrations(state); });
  slot.querySelector("#selectVisible").addEventListener("change", (event) => {
    for (const row of visibleRows) event.target.checked ? state.regSelected.add(row.id) : state.regSelected.delete(row.id);
    renderRegistrations(state);
  });
  const visibleSelectedCount = selectedVisible.length;
  const selectAll = slot.querySelector("#selectVisible");
  selectAll.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleRows.length;
  slot.querySelectorAll("[data-reg-select]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    checkbox.checked ? state.regSelected.add(checkbox.dataset.regSelect) : state.regSelected.delete(checkbox.dataset.regSelect);
    renderRegistrations(state);
  }));
  slot.querySelectorAll("[data-reg-delete]").forEach((button) => button.addEventListener("click", () => deleteRegistration(state, button.dataset.regDelete, button)));
  slot.querySelector("#deleteSelected")?.addEventListener("click", () => deleteSelectedRegistrations(state, selectedRows));
  slot.querySelector("#clearRegSelection")?.addEventListener("click", () => { state.regSelected.clear(); renderRegistrations(state); });
  slot.querySelectorAll("[data-clear-reg-filters]").forEach((button) => button.addEventListener("click", () => { state.regSearch = ""; state.regBranch = ""; state.regSemester = ""; state.regPage = 1; renderRegistrations(state); }));
  slot.querySelector("#previousRegistrationPage").addEventListener("click", () => { state.regPage--; renderRegistrations(state); });
  slot.querySelector("#showMoreRegistrations").addEventListener("click", () => { state.regPage++; renderRegistrations(state); });
  slot.querySelector("#exportRegistrations").addEventListener("click", () => {
    const fields = ["id", "event_id", "user_id", "name", "phone", "email", "reg_no", "semester", "branch", "pass_id", "created_at", "pass_token", "checked_in_at", "gate"];
    const rows = [fields, ...state.registrations.map((row) => {
      const scan = registrationCheckedIn(state, row);
      const pass = state.passes.find((item) => item.id === row.pass_id);
      return [row.id, row.event_id, row.user_id, row.name, row.phone, row.email || "", row.reg_no, row.semester, row.branch, row.pass_id || "", row.created_at, pass?.token || "", scan?.scanned_at || "", scan?.gate || ""];
    })];
    const slug = state.ev.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
    download(`${slug}-registrations.csv`, toCsv(rows));
  });
}

async function deleteRegistration(state, id, button) {
  const registration = state.registrations.find((row) => row.id === id);
  if (!registration) return;
  if (!await confirmRegistrationDelete(state, [registration])) return;
  button.disabled = true;
  const { error } = await sb.rpc("gp_delete_registration", { p_registration_id: id });
  if (error) { button.disabled = false; return toast(error.message || "Couldn't delete the registration", "x"); }
  state.regSelected.delete(id);
  try { await refreshEventData(state); } catch { toast("Registration deleted; refresh the event to update its lists.", "x"); return; }
  toast("Registration deleted");
}

async function deleteSelectedRegistrations(state, selected) {
  const ids = selected.map((row) => row.id);
  if (!ids.length) return;
  if (!await confirmRegistrationDelete(state, selected)) return;
  const bulkButton = view.querySelector("#deleteSelected");
  if (bulkButton) bulkButton.disabled = true;
  for (const id of ids) {
    const { error } = await sb.rpc("gp_delete_registration", { p_registration_id: id });
    if (error) {
      try { await refreshEventData(state); } catch {}
      return toast(error.message || "Couldn't delete all selected registrations", "x");
    }
    state.regSelected.delete(id);
  }
  await refreshEventData(state);
  toast(`${plural(ids.length, "registration")} deleted`);
}

function confirmRegistrationDelete(state, registrations) {
  const dialog = view.querySelector("#registrationConfirm");
  if (!dialog) return Promise.resolve(false);
  const checked = registrations.filter((row) => registrationCheckedIn(state, row)).length;
  const names = registrations.slice(0, 3).map((row) => `<li>${esc(row.name)}</li>`).join("");
  const remaining = registrations.length > 3 ? `<li>and ${registrations.length - 3} more</li>` : "";
  dialog.innerHTML = `<div class="registration-confirm-inner"><h2 id="registrationConfirmTitle">Delete ${registrations.length === 1 ? "this registration" : `${registrations.length} registrations`}?</h2><p id="registrationConfirmDescription">${checked ? `${checked} attendee${checked === 1 ? " is" : "s are"} already checked in. Their passes and scan history will be removed.` : "Their passes will stop working."}</p><ul>${names}${remaining}</ul><div class="registration-confirm-actions"><button class="btn small" type="button" data-confirm-cancel>Cancel</button><button class="btn small danger" type="button" data-confirm-delete>${registrations.length === 1 ? "Delete registration" : "Delete registrations"}</button></div></div>`;
  const opener = document.activeElement;
  return new Promise((resolve) => {
    let settled = false;
    const onCancel = (event) => { event.preventDefault(); finish(false); };
    const finish = (approved) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      if (opener?.isConnected) opener.focus();
      resolve(approved);
    };
    const onClose = () => finish(false);
    dialog.addEventListener("close", onClose, { once: true });
    dialog.querySelector("[data-confirm-cancel]").addEventListener("click", () => finish(false));
    dialog.querySelector("[data-confirm-delete]").addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    dialog.querySelector("[data-confirm-cancel]").focus();
  });
}

async function refreshEventData(state) {
  const [passes, scans, registrations] = await Promise.all([
    fetchAll("gp_passes", "id,name,contact,token,created_at", state.ev.id),
    fetchAll("gp_scans", "id,pass_id,is_first,gate,scanned_at", state.ev.id),
    fetchAll("gp_registrations", "id,event_id,user_id,name,phone,email,reg_no,semester,branch,pass_id,created_at", state.ev.id),
  ]);
  state.passes = passes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name));
  state.registrations = registrations;
  state.regSelected = new Set([...state.regSelected].filter((id) => registrations.some((row) => row.id === id)));
  state.first = new Map(); state.bounced = 0;
  for (const scan of scans) scan.is_first ? state.first.set(scan.pass_id, scan) : state.bounced++;
  if (!view.querySelector("#registrationsSlot")) return;
  renderStat(state, true);
  renderPassTools(state);
  renderList(state);
  renderRegistrations(state);
}

// ── checked-in counter ──
function renderStat(state, bump = false) {
  const total = state.passes.length, checked = state.first.size;
  const el = view.querySelector("#stat");
  el.innerHTML = `
    <span class="dot">${I.dotCheck}</span>
    <p class="stat-label">Checked in</p>
    <div class="stat-line"><p class="stat-num ink" id="snum">${checked} / ${total}</p><div class="bar" aria-hidden="true"><i style="--p:${total ? Math.min(1, checked / total) : 0}"></i></div></div>
    ${state.bounced ? `<p class="stat-note">${plural(state.bounced, "repeat scan")} bounced at the gate</p>` : ""}`;
  el.setAttribute("aria-label", `Checked in ${checked} of ${total}`);
  if (bump) { const n = el.querySelector("#snum"); n.animate([{ transform: "scale(1.08)", color: "#FF2FA2" }, { transform: "scale(1)" }], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" }); }
}

// ── gate code ──
function renderGate(state, showQr = false) {
  const ev = state.ev, el = view.querySelector("#gatebox");
  el.innerHTML = `
    <p class="kicker-free">Gate code</p>
    <p class="gate-code ink" aria-label="Gate code ${fmtCode(ev.gate_code).split("").join(" ")}">${fmtCode(ev.gate_code)}</p>
    <p class="fine">Staff open <b>${esc(gateUrl("").replace(/#$/, "").replace(/^https?:\/\//, ""))}</b> and type this. Anyone with the code can scan, so share it only with your team.</p>
    <div class="btns">
      <button class="btn small" type="button" id="cpGate">${I.link}Copy gate link</button>
      <button class="btn small" type="button" id="qrGate" aria-expanded="${showQr}">${I.qr}${showQr ? "Hide QR" : "Show QR"}</button>
      <button class="btn small" type="button" id="rot">${I.refresh}New code</button>
    </div>
    ${showQr ? `<div class="gate-qr">${qrSvg(gateUrl(ev.gate_code), { label: "QR to join the gate" })}<p class="fine" style="color:var(--blue);margin:0">Staff scan this with their phone camera to open the scanner with the code filled in.</p></div>` : ""}`;
  el.querySelector("#cpGate").addEventListener("click", async () => { (await copyText(gateUrl(ev.gate_code))) ? toast("Gate link copied") : toast("Couldn't copy", "x"); });
  el.querySelector("#qrGate").addEventListener("click", () => renderGate(state, !showQr));
  let armed = 0;
  el.querySelector("#rot").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (Date.now() - armed > 4000) { armed = Date.now(); b.innerHTML = `${I.refresh}Tap again: old code stops working`; return; }
    b.disabled = true;
    const { data, error } = await sb.rpc("gp_rotate_code", { p_event: ev.id });
    if (error || !data) { b.disabled = false; return toast(error?.message || "Couldn't change the code", "x"); }
    ev.gate_code = data;
    renderGate(state, showQr);
    toast("New gate code. Staff need to re-join.");
  });
}

// ── passes: tools + list ──
function msgFor(state, p) {
  const ev = state.ev;
  const first = p.name.split(" ")[0];
  return `Hi ${first}! Your pass for ${ev.name} (${fmtWhen(ev.starts_at)}${ev.venue ? `, ${ev.venue}` : ""}):\n${passUrl(p.token)}\nShow the QR at the gate. It works once, so don't share it.`;
}
function sendHref(state, p) {
  const c = p.contact || "";
  if (isEmail(c)) return { href: `mailto:${encodeURIComponent(c)}?subject=${encodeURIComponent(`Your pass for ${state.ev.name}`)}&body=${encodeURIComponent(msgFor(state, p))}`, icon: I.mail, label: "Email" };
  if (isPhone(c)) {
    let d = c.replace(/\D/g, "");
    if (d.length === 10) d = "91" + d;          // assume India for bare 10-digit numbers
    if (d.length === 11 && d.startsWith("0")) d = "91" + d.slice(1);
    return { href: `https://wa.me/${d}?text=${encodeURIComponent(msgFor(state, p))}`, icon: I.chat, label: "WhatsApp" };
  }
  return null;
}

function renderPassTools(state) {
  const el = view.querySelector("#passTools");
  view.querySelector("#pcount").textContent = state.passes.length ? plural(state.passes.length, "pass", "passes") : "";
  if (!state.passes.length) {
    el.innerHTML = `<div class="empty"><h3>No passes yet</h3><p class="sub" style="color:var(--blue)">Upload the registrations sheet and each row becomes a pass with its own link.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="tools">
      <button class="btn small" type="button" id="cpAll">${I.copy}Copy all links</button>
      <button class="btn small" type="button" id="csv" aria-label="Export passes as CSV">${I.download}Export CSV</button>
    </div>
    <p class="fine" style="margin:0">GatePass sends nothing. Send each link yourself on WhatsApp or email; every link opens that person's pass.</p>
    <div class="search"><span>${I.search}</span><input class="input" id="filter" placeholder="Search names" autocomplete="off" value="${esc(state.filter)}"></div>`;
  el.querySelector("#cpAll").addEventListener("click", async () => {
    const text = state.passes.map((p) => `${p.name}: ${passUrl(p.token)}`).join("\n");
    (await copyText(text)) ? toast(`${plural(state.passes.length, "link")} copied`) : toast("Couldn't copy. Use Export CSV.", "x");
  });
  el.querySelector("#csv").addEventListener("click", () => {
    const rows = [["name", "contact", "pass_link", "checked_in_at", "gate"]].concat(state.passes.map((p) => {
      const s = state.first.get(p.id);
      return [p.name, p.contact, passUrl(p.token), s ? new Date(s.scanned_at).toISOString() : "", s ? s.gate : ""];
    }));
    const slug = state.ev.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
    download(`${slug}-passes.csv`, toCsv(rows));
  });
  let t;
  el.querySelector("#filter").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.filter = e.target.value; state.shown = 120; renderList(state); }, 120); });
}

function rowHtml(state, p) {
  const s = state.first.get(p.id);
  const send = sendHref(state, p);
  return `
    <li data-id="${p.id}">
      <p class="pl-name">${esc(p.name)}</p>
      <p class="pl-meta">${s ? `<span class="in">In ${esc(fmtTime(s.scanned_at))} · ${esc(s.gate)}</span> · ` : ""}${esc(p.contact || "no contact")}</p>
      <div class="pl-actions">
        ${send ? `<a class="icon-btn" href="${esc(send.href)}" target="_blank" rel="noopener" aria-label="${send.label} ${esc(p.name)} their pass" title="${send.label}">${send.icon}</a>` : ""}
        <button class="icon-btn" type="button" data-copy="${esc(p.token)}" aria-label="Copy ${esc(p.name)}'s pass link" title="Copy link">${I.copy}</button>
        <a class="icon-btn" href="${esc(passUrl(p.token))}" target="_blank" rel="noopener" aria-label="Open ${esc(p.name)}'s pass" title="Open pass">${I.open}</a>
      </div>
    </li>`;
}

function renderList(state) {
  const ul = view.querySelector("#plist"), more = view.querySelector("#more");
  const f = state.filter.trim().toLowerCase();
  const list = f ? state.passes.filter((p) => p.name.toLowerCase().includes(f) || (p.contact || "").toLowerCase().includes(f)) : state.passes;
  ul.innerHTML = list.slice(0, state.shown).map((p) => rowHtml(state, p)).join("") || (state.passes.length ? `<li><p class="pl-meta">Nobody matches “${esc(state.filter)}”.</p></li>` : "");
  ul.style.borderTop = ul.innerHTML ? "" : "0";
  more.innerHTML = list.length > state.shown ? `<button class="btn small" type="button" id="moreBtn">Show ${Math.min(240, list.length - state.shown)} more of ${list.length - state.shown}</button>` : "";
  more.querySelector("#moreBtn")?.addEventListener("click", () => { state.shown += 240; renderList(state); });
  ul.onclick = async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    (await copyText(passUrl(b.dataset.copy))) ? toast("Pass link copied") : toast("Couldn't copy", "x");
  };
}

// ── live updates ──
function startLive(state) {
  stopLive();
  const id = state.ev.id;
  const apply = (s) => {
    if (s.is_first) {
      if (state.first.has(s.pass_id)) return;
      state.first.set(s.pass_id, s);
      const li = view.querySelector(`#plist li[data-id="${s.pass_id}"]`);
      const p = state.passes.find((x) => x.id === s.pass_id);
      if (li && p) li.outerHTML = rowHtml(state, p);
    } else state.bounced++;
    renderStat(state, true);
  };
  live = sb.channel(`gp-event-${id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "gp_scans", filter: `event_id=eq.${id}` }, (msg) => apply(msg.new))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "gp_registrations", filter: `event_id=eq.${id}` }, () => refreshEventData(state).catch(() => {}))
    // DELETE filters rely on full replica identity; refreshing on any visible deletion is safe.
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "gp_registrations" }, () => refreshEventData(state).catch(() => {}))
    .subscribe();
  // Belt and braces: re-sync every 20 s in case the socket sleeps (phones do that).
  pollTimer = setInterval(async () => {
    if (document.visibilityState !== "visible") return;
    try { await refreshEventData(state); } catch {}
  }, 20000);
}
function stopLive() {
  if (live) { sb.removeChannel(live); live = null; }
  clearInterval(pollTimer);
}

paintIcons();
boot().catch(fail);
