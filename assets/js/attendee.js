// Public event listing and attendee registration.
import {
  configured, artUrl, passUrl, fmtWhen, esc, store, qrSvg, PAUSED_MSG, I,
} from "./core.js";
import { getSupabaseClient } from "./supabase-client.js";

const BRANCHES = ["CSE", "ISE", "AIML", "AIDS", "ECE", "EEE", "ME", "CV", "Other"];
const INTENT_KEY = "gp.apply.intent";
const INTENT_TTL = 30 * 60 * 1000;
const view = document.getElementById("view");
const authBar = document.getElementById("authBar");
let sb = null;
let session = null;
let booted = false;
let events = [];
let eventsLoaded = false;
let registrations = new Map();
let currentEvent = null;
let page = "events";
let authMessage = "";
let signingOut = false;

const userName = (user) => user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || "Attendee";

function renderAuthBar() {
  if (!session?.user) {
    authBar.innerHTML = `<button class="btn small" type="button" id="headerSignIn">Sign in with Google</button>`;
    authBar.querySelector("#headerSignIn").addEventListener("click", () => showSignIn());
    return;
  }
  const user = session.user;
  const name = userName(user);
  const avatar = user.user_metadata?.avatar_url || user.user_metadata?.picture;
  authBar.innerHTML = `
    <span class="attendee-user" title="${esc(name)}">
      ${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer">` : `<span class="attendee-avatar" aria-hidden="true">${esc(name.trim().slice(0, 1).toUpperCase())}</span>`}
      <span class="attendee-user-name">${esc(name)}</span>
    </span>
    <button class="btn small" type="button" id="headerSignOut">Sign out</button>`;
  authBar.querySelector("#headerSignOut").addEventListener("click", async () => {
    signingOut = true;
    store.del(INTENT_KEY);
    const { error } = await sb.auth.signOut();
    signingOut = false;
    if (error) showEvents("Couldn't sign out. Please try again.");
  });
}

function setErrorText(node, message) {
  if (!node) return;
  node.textContent = message || "";
  node.hidden = !message;
}

function saveIntent(eventId, draft = null) {
  store.set(INTENT_KEY, { eventId, timestamp: Date.now(), ...(draft ? { draft } : {}) });
}

function takeIntent() {
  const intent = store.get(INTENT_KEY);
  store.del(INTENT_KEY);
  if (!intent || !intent.eventId || !Number.isFinite(Number(intent.timestamp))) return null;
  if (Date.now() - Number(intent.timestamp) > INTENT_TTL || Number(intent.timestamp) > Date.now() + 60_000) return null;
  return intent;
}

function formatEventDate(startsAt) {
  return fmtWhen(startsAt);
}

async function loadEvents() {
  eventsLoaded = false;
  if (page === "events") renderEvents();
  const { data, error } = await sb.rpc("gp_public_events");
  if (error) throw error;
  events = Array.isArray(data) ? data : [];
  eventsLoaded = true;
}

async function loadMyRegistrations() {
  registrations.clear();
  if (!session) return;
  const { data, error } = await sb.rpc("gp_my_registrations");
  if (error) throw error;
  for (const row of data || []) registrations.set(row.event_id, row.pass_token);
}

function orderedEvents() {
  const now = Date.now();
  return [...events].sort((a, b) => {
    const aTime = new Date(a.starts_at).getTime();
    const bTime = new Date(b.starts_at).getTime();
    const aPast = aTime <= now, bPast = bTime <= now;
    if (aPast !== bPast) return aPast ? 1 : -1;
    return aPast ? bTime - aTime : aTime - bTime;
  });
}

function showEvents(message = "") {
  page = "events";
  currentEvent = null;
  renderEvents(message);
}

function renderEvents(message = "") {
  if (!eventsLoaded) {
    view.innerHTML = `<div class="skeleton" style="height:220px" aria-label="Loading events"></div>`;
    return;
  }
  const list = orderedEvents();
  if (!list.length) {
    view.innerHTML = `
      <section class="stack narrow attendee-events">
        <h1 class="head">Apply for a pass</h1>
        ${message ? `<p class="err attendee-notice" role="status">${esc(message)}</p>` : ""}
        <div class="empty"><h3>No events yet</h3><p class="sub">There are no events to apply for right now.</p></div>
      </section>`;
    return;
  }
  view.innerHTML = `
    <section class="stack attendee-events">
      <div class="head-row"><h1 class="head">Apply for a pass</h1></div>
      ${message ? `<p class="err attendee-notice" role="status">${esc(message)}</p>` : ""}
      <div class="attendee-event-grid">
        ${list.map((event) => {
          const ended = new Date(event.starts_at).getTime() <= Date.now();
          const token = registrations.get(event.id);
          const action = token
            ? `<a class="btn small attendee-view-pass" href="${esc(passUrl(token))}">View pass</a>`
            : ended ? `<span class="attendee-ended">Ended</span>` : `<button class="btn small" type="button" data-event="${esc(event.id)}">${session ? "Apply for pass" : "View event"}</button>`;
          return `
            <article class="attendee-event ${ended ? "is-ended" : ""}">
              <img class="attendee-event-art" src="${esc(artUrl(event.art))}" alt="" loading="lazy">
              <div class="attendee-event-copy">
                <h2 class="attendee-event-name">${esc(event.name)}</h2>
                ${event.club ? `<p class="attendee-event-club">${esc(event.club)}</p>` : ""}
                <p class="attendee-event-meta">${esc(formatEventDate(event.starts_at))}</p>
                ${event.venue ? `<p class="attendee-event-meta">${esc(event.venue)}</p>` : ""}
                ${ended ? `<span class="attendee-ended-label">Ended</span>` : ""}
              </div>
              <div class="attendee-event-action">${token ? `<span class="attendee-registered">Registered</span>` : ""}${action}</div>
            </article>`;
        }).join("")}
      </div>
    </section>`;
  view.querySelectorAll("button[data-event]").forEach((button) => button.addEventListener("click", () => {
    const event = events.find((row) => row.id === button.dataset.event);
    if (!event) return;
    if (!session) {
      saveIntent(event.id);
      showSignIn();
      return;
    }
    const token = registrations.get(event.id);
    if (token) return renderSuccess(event, token);
    openForm(event);
  }));
}

function showSignIn(message = "") {
  page = "signin";
  view.innerHTML = `
    <section class="signin">
      <div class="poster hero-poster" id="art">
        <span class="hero-art-backdrop" aria-hidden="true">
          <img class="hero-art-image hero-art-light" src="images/creator-light.png" alt="">
          <img class="hero-art-image hero-art-dark" src="images/creator-dark.png" alt="">
        </span>
        <span class="hero-copy-scrim" aria-hidden="true"></span>
        <span class="hero-ticket-glint" aria-hidden="true"></span>
        <h1 class="poster-title ink">Free entry passes</h1>
        <p class="poster-club">For your club's next event</p>
        <span class="poster-when">Open source · ₹0</span>
      </div>
      <div class="stack attendee-signin-copy">
        <p class="sub attendee-intro">Sign in to apply for an event pass. Your session also works in the host portal.</p>
        <p class="err" id="signinError" role="alert" aria-live="polite" ${message ? "" : "hidden"}>${esc(message)}</p>
        <button class="btn-primary compact" type="button" id="googleSignIn"><span class="gdisc">${I.google}</span><span class="label">Continue with Google</span><span class="arrow">${I.arrow}</span></button>
        <button class="btn small attendee-back" type="button" id="backToEvents">Back to events</button>
      </div>
    </section>`;
  const art = view.querySelector("#art");
  art.style.backgroundImage = `url("${artUrl(0)}")`;
  view.querySelector("#backToEvents").addEventListener("click", () => { store.del(INTENT_KEY); showEvents(); });
  view.querySelector("#googleSignIn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setErrorText(view.querySelector("#signinError"), "");
    try {
      const { error, data } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: new URL("/", location.origin).href, queryParams: { prompt: "select_account" } },
      });
      if (error || !data?.url) throw error || new Error("No sign-in redirect was returned.");
    } catch {
      store.del(INTENT_KEY);
      showEvents("Google sign-in couldn't start. Please try again.");
    }
  });
}

function openForm(event, draft = {}) {
  if (new Date(event.starts_at).getTime() <= Date.now()) return showEvents("Registration for this event has ended.");
  currentEvent = event;
  page = "form";
  const user = session.user;
  const name = draft.name ?? user.user_metadata?.full_name ?? user.user_metadata?.name ?? "";
  const email = draft.email ?? user.email ?? "";
  view.innerHTML = `
    <section class="stack narrow attendee-form-wrap">
      <button class="backlink attendee-backlink" type="button" id="formBack">‹ Back to events</button>
      <div class="attendee-form-heading">
        <h1 class="head">Apply for a pass</h1>
        <p class="sub">${esc(event.name)} · ${esc(formatEventDate(event.starts_at))}${event.venue ? ` · ${esc(event.venue)}` : ""}</p>
      </div>
      <form id="registrationForm" class="stack attendee-form" novalidate>
        <label class="field" for="regName"><span>Full name</span><input class="input" id="regName" name="name" maxlength="80" autocomplete="name" required value="${esc(name)}" aria-describedby="error-name"><span class="field-error" id="error-name" aria-live="polite"></span></label>
        <label class="field" for="regPhone"><span>Phone number</span><input class="input" id="regPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required value="${esc(draft.phone || "")}" aria-describedby="error-phone"><span class="field-error" id="error-phone" aria-live="polite"></span></label>
        <label class="field" for="regEmail"><span>Email (optional)</span><input class="input" id="regEmail" name="email" type="email" inputmode="email" autocomplete="email" value="${esc(email)}" aria-describedby="error-email"><span class="field-error" id="error-email" aria-live="polite"></span></label>
        <label class="field" for="regNo"><span>SAN/USN</span><input class="input" id="regNo" name="reg_no" maxlength="20" autocapitalize="characters" autocomplete="off" required value="${esc(draft.reg_no || "")}" aria-describedby="error-reg_no"><span class="field-error" id="error-reg_no" aria-live="polite"></span></label>
        <div class="two">
          <label class="field" for="regSemester"><span>Semester</span><select class="select" id="regSemester" name="semester" required aria-describedby="error-semester"><option value="">Choose</option>${Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}" ${String(draft.semester || "") === String(i + 1) ? "selected" : ""}>${i + 1}</option>`).join("")}</select><span class="field-error" id="error-semester" aria-live="polite"></span></label>
          <label class="field" for="regBranch"><span>Branch</span><select class="select" id="regBranch" name="branch" required aria-describedby="error-branch"><option value="">Choose</option>${BRANCHES.map((branch) => `<option value="${branch}" ${draft.branch === branch ? "selected" : ""}>${branch}</option>`).join("")}</select><span class="field-error" id="error-branch" aria-live="polite"></span></label>
        </div>
        <p class="err" id="formError" role="alert" aria-live="polite" hidden></p>
        <button class="btn-primary compact" id="submitRegistration" type="submit"><span class="label">Submit application</span><span class="arrow">→</span></button>
      </form>
    </section>`;
  view.querySelector("#formBack").addEventListener("click", () => showEvents());
  const form = view.querySelector("#registrationForm");
  form.querySelectorAll("input,select").forEach((input) => input.addEventListener("input", () => {
    const error = view.querySelector(`#error-${input.name}`);
    if (error) { error.textContent = ""; error.classList.remove("visible"); input.removeAttribute("aria-invalid"); }
  }));
  form.addEventListener("submit", submitRegistration);
}

function formValues() {
  const form = view.querySelector("#registrationForm");
  if (!form) return {};
  const fields = new FormData(form);
  return Object.fromEntries(["name", "phone", "email", "reg_no", "semester", "branch"].map((key) => [key, String(fields.get(key) || "")]));
}

function validate(values) {
  const errors = {};
  const name = values.name.trim();
  const phoneText = values.phone.replace(/[\s-]/g, "");
  const withoutCountry = phoneText.startsWith("+91") ? phoneText.slice(3) : phoneText;
  const phone = withoutCountry.startsWith("0") ? withoutCountry.slice(1) : withoutCountry;
  const email = values.email.trim();
  const regNo = values.reg_no.trim().toUpperCase();
  if (name.length < 2 || name.length > 80) errors.name = "Enter a name between 2 and 80 characters.";
  if (!/^\d{10}$/.test(phone)) errors.phone = "Enter a valid 10-digit phone number.";
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.email = "Enter a valid email address or leave it blank.";
  if (!/^[A-Z0-9]{5,20}$/.test(regNo)) errors.reg_no = "Enter a SAN/USN with 5 to 20 letters or numbers.";
  if (!/^[1-8]$/.test(values.semester)) errors.semester = "Choose a semester from 1 to 8.";
  if (!BRANCHES.includes(values.branch)) errors.branch = "Choose a valid branch.";
  return { errors, data: { name, phone, email: email || null, regNo, semester: Number(values.semester), branch: values.branch } };
}

function displayFieldErrors(errors) {
  for (const key of ["name", "phone", "email", "reg_no", "semester", "branch"]) {
    const node = view.querySelector(`#error-${key}`);
    const input = view.querySelector(`[name="${key}"]`);
    if (!node || !input) continue;
    node.textContent = errors[key] || "";
    node.classList.toggle("visible", !!errors[key]);
    if (errors[key]) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
}

async function submitRegistration(event) {
  event.preventDefault();
  const values = formValues();
  const { errors, data } = validate(values);
  displayFieldErrors(errors);
  if (Object.keys(errors).length) {
    view.querySelector(`[name="${Object.keys(errors)[0]}"]`)?.focus();
    return;
  }
  const button = view.querySelector("#submitRegistration");
  const label = button.querySelector(".label");
  button.disabled = true;
  label.textContent = "Submitting…";
  setErrorText(view.querySelector("#formError"), "");
  let response;
  try {
    response = await sb.rpc("gp_register", {
      p_event_id: currentEvent.id,
      p_name: data.name,
      p_phone: data.phone,
      p_email: data.email,
      p_reg_no: data.regNo,
      p_semester: data.semester,
      p_branch: data.branch,
    });
  } catch {
    button.disabled = false;
    label.textContent = "Submit application";
    setErrorText(view.querySelector("#formError"), "Couldn't reach the server. Check your connection and try again.");
    return;
  }
  const { data: token, error } = response;
  if (error) {
    const { data: authData } = await sb.auth.getSession();
    if (!authData.session || /jwt expired|not authenticated|invalid jwt|401/i.test(error.message || "")) {
      session = null;
      saveIntent(currentEvent.id, values);
      renderAuthBar();
      showSignIn("Your sign-in expired. Continue with Google to finish your application.");
      return;
    }
    button.disabled = false;
    label.textContent = "Submit application";
    const message = /already registered/i.test(error.message) ? "This SAN/USN is already registered for this event."
      : /event is no longer available/i.test(error.message) ? "This event is no longer available."
        : /registration.*ended/i.test(error.message) ? "Registration for this event has ended."
        : /fetch|network|timeout/i.test(error.message) ? "Couldn't reach the server. Check your connection and try again."
          : error.message || "Couldn't submit your application. Please try again.";
    setErrorText(view.querySelector("#formError"), message);
    return;
  }
  if (!token || typeof token !== "string") {
    button.disabled = false;
    label.textContent = "Submit application";
    setErrorText(view.querySelector("#formError"), "Couldn't create your pass. Please try again.");
    return;
  }
  registrations.set(currentEvent.id, token);
  renderSuccess(currentEvent, token);
}

function renderSuccess(event, token) {
  page = "success";
  currentEvent = event;
  const link = passUrl(token);
  view.innerHTML = `
    <section class="stack narrow attendee-success">
      <h1 class="head">Registration complete</h1>
      <p class="sub">${esc(event.name)} · ${esc(formatEventDate(event.starts_at))}</p>
      <div class="attendee-success-qr">${qrSvg(link, { label: "Your GatePass QR code" })}</div>
      <p class="fine attendee-success-note">Show this QR at the gate. Your pass can be used once.</p>
      <a class="btn-primary compact attendee-open-pass" href="${esc(link)}"><span class="label">Open pass</span><span class="arrow">→</span></a>
      <button class="btn small attendee-back" type="button" id="successBack">Back to events</button>
    </section>`;
  view.querySelector("#successBack").addEventListener("click", () => showEvents());
}

async function finishSignIn() {
  try { await loadMyRegistrations(); }
  catch { authMessage = "Couldn't check your existing registrations. You can still browse events."; }
  const intent = takeIntent();
  if (intent) {
    const event = events.find((row) => row.id === intent.eventId);
    if (event) {
      const token = registrations.get(event.id);
      if (token) return renderSuccess(event, token);
      return openForm(event, intent.draft || {});
    }
  }
  if (page === "events" || page === "signin") renderEvents(authMessage);
}

function renderLoadError() {
  page = "events";
  view.innerHTML = `
    <section class="stack narrow attendee-events">
      <h1 class="head">Apply for a pass</h1>
      <div class="empty"><h3>Couldn't load events</h3><p class="sub">${esc(PAUSED_MSG)} Check your connection and try again.</p><button class="btn small" type="button" id="retryEvents">Try again</button></div>
    </section>`;
  view.querySelector("#retryEvents").addEventListener("click", async () => {
    try {
      await loadEvents();
      if (session) {
        try { await loadMyRegistrations(); } catch { authMessage = "Couldn't check your existing registrations. You can still browse events."; }
      }
      showEvents(authMessage);
    } catch { renderLoadError(); }
  });
}

async function boot() {
  if (!configured || !window.supabase) {
    view.innerHTML = `<section class="empty"><h3>Pass applications are unavailable</h3><p class="sub">This site isn't connected to its Supabase project.</p></section>`;
    return;
  }
  sb = getSupabaseClient();
  const hash = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  const oauthError = hash.get("error_description") || hash.get("error");
  if (oauthError) {
    history.replaceState(null, "", location.pathname + location.search);
    store.del(INTENT_KEY);
    authMessage = "Google sign-in was cancelled or couldn't be completed. You can still browse events.";
  }
  sb.auth.onAuthStateChange((event, nextSession) => {
    const previous = session;
    const wasExplicitSignOut = signingOut;
    session = nextSession;
    renderAuthBar();
    if (!booted) return;
    setTimeout(async () => {
      if (!session && previous) {
        const formWasInterrupted = page === "form" && currentEvent && !wasExplicitSignOut;
        if (formWasInterrupted) saveIntent(currentEvent.id, formValues());
        registrations.clear();
        if (wasExplicitSignOut) store.del(INTENT_KEY);
        if (formWasInterrupted) showSignIn("Your sign-in expired. Continue with Google to finish your application.");
        else showEvents();
      } else if (session && !previous) {
        await finishSignIn();
      } else if (session && event === "TOKEN_REFRESHED") {
        // The persisted session remains active; no page transition is needed.
      }
    }, 0);
  });
  const { data, error } = await sb.auth.getSession();
  if (error) authMessage = "Couldn't check your sign-in. You can still browse events.";
  session = data?.session || null;
  renderAuthBar();
  try {
    await loadEvents();
  } catch (loadError) {
    booted = true;
    renderLoadError(loadError);
    return;
  }
  if (session) {
    try { await loadMyRegistrations(); }
    catch { authMessage = "Couldn't check your existing registrations. You can still browse events."; }
  }
  booted = true;
  if (session && !oauthError) await finishSignIn();
  else showEvents(authMessage);
}

boot().catch(() => renderLoadError());
