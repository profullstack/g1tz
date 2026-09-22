/**
 * The account page: sign in by email, approve a terminal's code, accept an
 * invitation, and run an organization. Every write is one operation on
 * /api/v1/actions, the same vocabulary the CLI and the Team screen use.
 */
(() => {
  const app = document.getElementById("app");
  const ROLES = ["owner", "admin", "lead", "user", "billing"];
  const state = { user: null, orgs: [], orgId: null, org: null, members: null, teams: null, workspaces: null, plan: null, audit: null, tokens: null, device: null, notice: null, pendingInvite: null, newToken: null };

  // ---------------------------------------------------------------- transport
  async function post(path, body) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const e = new Error(data.error || `HTTP ${response.status}`); e.status = response.status; e.body = data; throw e; }
    return data;
  }
  const auth = (path, body) => post(`/api/auth/${path}`, body);
  const call = (operation, args = {}) => post("/api/v1/actions", { operation, args });

  // ---------------------------------------------------------------- dom
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return el;
  }
  const capital = (s) => s ? s[0].toUpperCase() + s.slice(1) : "";
  const when = (iso) => (iso || "").replace("T", " ").slice(0, 16);

  // A notice is shown by the next render and cleared by it, so it is set just
  // before the one render that follows an action.
  function notice(kind, text) { state.notice = { kind, text }; }
  async function act(fn, done) {
    try { await fn(); if (done) notice("ok", done); await refreshOrg(); }
    catch (error) {
      const hint = error.status === 402 && error.body && error.body.plan ? ` See the ${capital(error.body.plan)} plan.` : "";
      notice("error", error.message + hint);
      render();
    }
  }

  // ---------------------------------------------------------------- loading
  async function boot() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const query = new URLSearchParams(location.search);
    state.device = query.get("device");
    if (hash.get("invite")) { sessionStorage.setItem("g1tz-invite", hash.get("invite")); history.replaceState(null, "", location.pathname + location.search); }
    state.pendingInvite = sessionStorage.getItem("g1tz-invite");
    if (hash.get("verify")) {
      history.replaceState(null, "", location.pathname + location.search);
      try {
        const result = await auth("verify", { token: hash.get("verify") });
        state.user = result.user;
        if (result.joined && result.joined.length) state.notice = { kind: "ok", text: "Signed in. Your email domain put you in an organization." };
      } catch (error) { state.notice = { kind: "error", text: error.message }; }
    }
    if (!state.user) {
      const session = await fetch("/api/auth/session", { credentials: "same-origin" }).then((r) => r.json());
      state.user = session.user;
    }
    if (state.user) {
      if (state.pendingInvite) {
        try {
          const joined = await call("invitations_accept", { token: state.pendingInvite });
          state.notice = { kind: "ok", text: `You joined ${joined.organization} as ${joined.role}.` };
          state.orgId = joined.orgId;
        } catch (error) { state.notice = { kind: "error", text: error.message }; }
        sessionStorage.removeItem("g1tz-invite");
        state.pendingInvite = null;
      }
      await loadOrgs();
    }
    render();
  }
  async function loadOrgs() {
    state.orgs = await call("organizations_list");
    if (!state.orgs.some((o) => o.id === state.orgId)) state.orgId = state.orgs[0] ? state.orgs[0].id : null;
    await refreshOrg();
  }
  async function refreshOrg() {
    if (!state.orgId) { state.org = null; render(); return; }
    const orgId = state.orgId;
    const [org, members, teams, workspaces, plan] = await Promise.all([
      call("organizations_get", { orgId }), call("members_list", { orgId }), call("teams_list", { orgId }), call("workspaces_list", { orgId }), call("plan_get", { orgId }),
    ]);
    if (state.orgId !== orgId) return;
    Object.assign(state, { org, members, teams, workspaces, plan });
    const manages = org.role === "owner" || org.role === "admin";
    state.audit = manages ? await call("audit_list", { orgId, limit: 50 }) : null;
    state.tokens = await call("tokens_list");
    state.orgs = state.orgs.map((o) => (o.id === orgId ? { ...o, name: org.name, plan: org.plan, role: org.role } : o));
    render();
  }

  // ---------------------------------------------------------------- screens
  function render() {
    app.innerHTML = "";
    if (state.notice) {
      const n = state.notice; state.notice = null;
      app.appendChild(h("div", { class: `notice ${n.kind}` }, n.text));
    }
    if (!state.user) { app.appendChild(signInScreen()); return; }
    app.appendChild(accountHeader());
    if (state.device) app.appendChild(deviceCard());
    app.appendChild(invitationsCard());
    app.appendChild(orgPicker());
    if (state.org) app.appendChild(orgScreen());
    app.appendChild(tokensCard());
  }

  function signInScreen() {
    const email = h("input", { type: "email", name: "email", placeholder: "you@company.com", required: true, autocomplete: "email" });
    const form = h("form", { class: "row", onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await auth("email", { email: email.value, next: state.device || undefined });
        notice("ok", r.message);
      } catch (error) { notice("error", error.message); }
      render();
    } }, email, h("button", { type: "submit" }, "Email me a sign-in link"));
    return h("div", {},
      h("h1", {}, "Sign in"),
      h("p", { class: "lead" }, state.device ? `A terminal is waiting for code ${state.device}. Sign in to approve it.` : "Your email is the credential. No password to remember."),
      form,
      h("p", { class: "muted" }, "From the terminal: ", h("code", {}, "g1tz login"), " prints a code you approve here."));
  }

  function accountHeader() {
    const name = h("input", { value: state.user.displayName, name: "displayName", maxlength: 80 });
    return h("div", { class: "card" },
      h("div", { class: "row" },
        h("strong", {}, state.user.email),
        h("form", { class: "row", onsubmit: async (e) => { e.preventDefault(); await act(async () => { const r = await auth("profile", { displayName: name.value }); state.user = r.user; }, "Name saved."); } }, name, h("button", { class: "quiet", type: "submit" }, "Save name")),
        h("button", { class: "quiet", onclick: async () => { await auth("logout", {}); location.reload(); } }, "Sign out"),
        h("button", { class: "quiet", onclick: async () => { if (confirm("Sign out everywhere, including every terminal?")) { await auth("logout-all", {}); location.reload(); } } }, "Sign out everywhere")));
  }

  function deviceCard() {
    const code = state.device;
    const card = h("div", { class: "card" }, h("h2", {}, "A terminal wants to sign in"), h("p", { class: "muted" }, "Checking the code…"));
    auth("device/preview", { code }).then((p) => {
      card.innerHTML = "";
      card.append(
        h("h2", {}, "A terminal wants to sign in"),
        h("p", {}, h("span", { class: "code" }, p.code)),
        h("p", {}, `“${p.label}”, asked at ${when(p.createdAt)}. Only approve a code you just saw in your own terminal.`),
        h("div", { class: "row" },
          h("button", { onclick: () => { state.device = null; act(() => auth("device/approve", { code }), "Approved. The terminal is signed in as you."); } }, "Approve"),
          h("button", { class: "danger", onclick: () => { state.device = null; act(() => auth("device/deny", { code }), "Denied."); } }, "Deny")));
    }).catch((error) => { card.innerHTML = ""; card.append(h("h2", {}, "A terminal wants to sign in"), h("p", { class: "danger" }, error.message)); });
    return card;
  }

  function invitationsCard() {
    const wrap = h("div", {});
    call("account_me").then((me) => {
      if (!me.invitations.length) return;
      wrap.appendChild(h("div", { class: "card" }, h("h2", {}, "Invitations"),
        h("ul", { class: "plain" }, me.invitations.map((i) => h("li", { class: "row" }, `${i.organization} as ${i.role}`,
          h("button", { onclick: () => act(async () => { const j = await call("invitations_accept", { invitationId: i.id }); state.orgId = j.orgId; await loadOrgs(); }, "Joined.") }, "Accept"))))));
    }).catch(() => {});
    return wrap;
  }

  function orgPicker() {
    const select = h("select", { onchange: (e) => { state.orgId = e.target.value; refreshOrg(); } }, state.orgs.map((o) => h("option", { value: o.id, selected: o.id === state.orgId }, `${o.name} · ${capital(o.plan)} · ${o.role}`)));
    const name = h("input", { placeholder: "New organization", name: "name", maxlength: 120 });
    return h("div", { class: "row" }, h("label", {}, "Organization "), select,
      h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(async () => { const o = await call("organizations_create", { name: name.value }); state.orgId = o.id; await loadOrgs(); }, "Created."); } }, name, h("button", { class: "quiet", type: "submit" }, "Create")));
  }

  function orgScreen() {
    const org = state.org;
    const manages = org.role === "owner" || org.role === "admin";
    const leads = manages || org.role === "lead";
    const bills = manages || org.role === "billing";
    return h("div", {},
      overview(org, manages), membersSection(org, manages), teamsSection(org, leads, manages), workspacesSection(org, leads),
      planSection(org, bills), domainsSection(org, manages), auditSection(org, manages), dangerSection(org));
  }

  function overview(org, manages) {
    const s = org.seats;
    const rename = h("input", { value: org.name, name: "name", maxlength: 120 });
    return h("div", { class: "card" },
      h("h1", {}, org.name),
      h("p", {}, `${capital(org.plan)} · ${s.used} in use, ${s.pending} invited, ${s.free} free of ${s.seats} seat${s.seats === 1 ? "" : "s"}${s.cap === null ? "" : ` (plan cap ${s.cap})`} · you are ${org.role === "billing" ? "the Billing Contact" : org.role}`),
      h("p", { class: "muted" }, `${org.counts.members} members, ${org.counts.teams} teams, ${org.counts.workspaces} workspaces. Organization id ${org.id}`),
      manages && h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("organizations_update", { orgId: org.id, name: rename.value }), "Renamed."); } }, rename, h("button", { class: "quiet", type: "submit" }, "Rename")));
  }

  function membersSection(org, manages) {
    const m = state.members;
    const email = h("input", { type: "email", placeholder: "person@company.com", name: "email", required: true });
    const role = h("select", { name: "role" }, ROLES.filter((r) => r !== "owner").map((r) => h("option", { value: r, selected: r === "user" }, capital(r))));
    const team = h("select", { name: "team" }, h("option", { value: "" }, "No team"), state.teams.map((t) => h("option", { value: t.id }, t.name)));
    const rows = m.members.map((member) => h("tr", {},
      h("td", {}, member.email, h("div", { class: "muted" }, member.displayName)),
      h("td", {}, manages && member.role !== "owner"
        ? h("select", { onchange: (e) => act(() => call("members_update", { orgId: org.id, userId: member.userId, role: e.target.value }), "Role changed.") }, ROLES.filter((r) => r !== "owner").map((r) => h("option", { value: r, selected: r === member.role }, capital(r))))
        : capital(member.role)),
      h("td", {}, member.teams.map((t) => t.name).join(", ")),
      h("td", {}, when(member.createdAt).slice(0, 10)),
      h("td", {}, manages && member.role !== "owner" && h("button", { class: "quiet", onclick: () => confirm(`Remove ${member.email}?`) && act(() => call("members_remove", { orgId: org.id, userId: member.userId }), "Removed.") }, "Remove"))));
    const invites = m.invitations.map((i) => h("tr", {}, h("td", {}, i.email), h("td", {}, capital(i.role)), h("td", { class: "muted" }, "invited"), h("td", {}, when(i.expiresAt).slice(0, 10)),
      h("td", {}, h("button", { class: "quiet", onclick: () => act(() => call("invitations_revoke", { orgId: org.id, invitationId: i.id }), "Revoked.") }, "Revoke"))));
    const file = h("input", { type: "file", accept: ".csv,text/csv", name: "csv" });
    return h("div", { class: "card" },
      h("h2", {}, `Members (${m.members.length}${m.invitations.length ? `, ${m.invitations.length} invited` : ""})`),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Email"), h("th", {}, "Role"), h("th", {}, "Teams"), h("th", {}, "Since"), h("th", {}))), h("tbody", {}, rows, invites)),
      manages && h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("members_invite", { orgId: org.id, email: email.value, role: role.value, teamId: team.value || undefined }), `Invited ${email.value}.`); } },
        email, role, team, h("button", { type: "submit" }, "Invite")),
      manages && h("div", { class: "row" },
        h("a", { href: `/api/v1/organizations/${org.id}/members.csv` }, "Export CSV"),
        h("form", { class: "row", onsubmit: async (e) => { e.preventDefault(); const f = file.files[0]; if (!f) return; const csv = await f.text(); act(async () => { const r = await call("members_import", { orgId: org.id, csv }); state.notice = { kind: r.failed ? "error" : "ok", text: `${r.invited} invited, ${r.failed} failed. ${r.results.filter((x) => !x.ok).map((x) => `${x.email}: ${x.message}`).join(" ")}` }; }); } },
          file, h("button", { class: "quiet", type: "submit" }, "Import CSV (email, role, team)"))));
  }

  function teamsSection(org, leads, manages) {
    const lock = state.plan.entitlements.find((e) => e.feature === "teams");
    const name = h("input", { placeholder: "Team name", name: "name", maxlength: 80 });
    const cards = state.teams.map((t) => {
      const card = h("div", { class: "card" });
      const add = h("select", { name: "add" }, h("option", { value: "" }, "Add a member…"), state.members.members.map((mm) => h("option", { value: mm.userId }, mm.email)));
      card.append(h("h3", {}, t.name, " ", h("span", { class: "muted" }, `${t.members} member${t.members === 1 ? "" : "s"}${t.member ? ", you are on it" : ""}`)));
      call("team_members_list", { teamId: t.id }).then((people) => {
        card.append(h("ul", { class: "plain" }, people.map((p) => h("li", { class: "row" }, `${p.email} (${p.role})`, leads && h("button", { class: "quiet", onclick: () => act(() => call("team_members_remove", { teamId: t.id, userId: p.id }), "Removed from the team.") }, "Remove")))));
        if (leads) card.append(h("div", { class: "row" },
          add, h("button", { class: "quiet", onclick: () => add.value && act(() => call("team_members_add", { teamId: t.id, userId: add.value }), "Added.") }, "Add"),
          h("button", { class: "quiet", onclick: () => { const n = prompt("Rename the team", t.name); if (n) act(() => call("teams_update", { teamId: t.id, name: n }), "Renamed."); } }, "Rename"),
          h("button", { class: "danger", onclick: () => confirm(`Delete ${t.name} and its workspaces?`) && act(() => call("teams_delete", { teamId: t.id }), "Deleted.") }, "Delete")));
      }).catch(() => {});
      return card;
    });
    return h("div", { class: "card" }, h("h2", {}, `Teams (${state.teams.length})`),
      lock && !lock.unlocked ? h("p", { class: "lock" }, `🔒 Teams need the ${capital(lock.plan)} plan.`) : null,
      cards,
      leads && (!lock || lock.unlocked) && h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("teams_create", { orgId: org.id, name: name.value }), "Team created."); } }, name, h("button", { type: "submit" }, "Create team")),
      !manages && !leads ? h("p", { class: "muted" }, "Owners, Admins and Leads manage teams.") : null);
  }

  function workspacesSection(org, leads) {
    const lock = state.plan.entitlements.find((e) => e.feature === "workspaces.shared");
    const name = h("input", { placeholder: "Workspace name", name: "name", maxlength: 80 });
    const team = h("select", { name: "team" }, h("option", { value: "" }, "Whole organization"), state.teams.map((t) => h("option", { value: t.id }, `Team ${t.name}`)));
    const cards = state.workspaces.map((w) => {
      const url = h("input", { placeholder: "https://github.com/org/repo", name: "url", size: 40 });
      return h("div", { class: "card" },
        h("h3", {}, w.name, " ", h("span", { class: "muted" }, w.team ? `team ${w.team}` : "whole organization")),
        w.description && h("p", {}, w.description),
        h("ul", { class: "plain" }, w.repos.map((r) => h("li", { class: "row" }, h("code", {}, r.name), h("span", { class: "muted" }, r.url), leads && h("button", { class: "quiet", onclick: () => act(() => call("workspace_repos_remove", { workspaceId: w.id, url: r.url }), "Removed.") }, "Remove")))),
        leads && h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("workspace_repos_add", { workspaceId: w.id, url: url.value }), "Repository added."); } }, url, h("button", { class: "quiet", type: "submit" }, "Add repository"),
          h("button", { class: "danger", type: "button", onclick: () => confirm(`Delete workspace ${w.name}?`) && act(() => call("workspaces_delete", { workspaceId: w.id }), "Deleted.") }, "Delete")));
    });
    return h("div", { class: "card" }, h("h2", {}, `Workspaces (${state.workspaces.length})`),
      lock && !lock.unlocked ? h("p", { class: "lock" }, `🔒 Shared workspaces need the ${capital(lock.plan)} plan.`) : null,
      cards,
      leads && (!lock || lock.unlocked) && h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("workspaces_create", { orgId: org.id, name: name.value, teamId: team.value || undefined }), "Workspace created."); } }, name, team, h("button", { type: "submit" }, "Create workspace")));
  }

  function planSection(org, bills) {
    const p = state.plan;
    const seats = h("input", { type: "number", min: 1, value: org.seats.seats, name: "seats", class: "seats" });
    return h("div", { class: "card" }, h("h2", {}, `Plan: ${p.planName}`),
      h("ul", { class: "plain" }, p.entitlements.map((e) => h("li", { class: e.unlocked ? "ok" : "lock" }, `${e.unlocked ? "✓" : "🔒"} ${e.line}${e.unlocked ? "" : ` (${capital(e.plan)})`}`))),
      p.entitlement && h("p", { class: "muted" }, `Entitlement ${p.entitlement.status} via ${p.entitlement.source}, ${when(p.entitlement.updatedAt)}${p.entitlement.principal ? `, principal ${p.entitlement.principal}` : ""}`),
      bills && h("div", { class: "row" }, p.plans.filter((x) => !x.current && x.plan !== "community").map((x) => h("a", { class: "quiet", href: `/pricing?org=${org.id}&plan=${x.plan}` }, `Move to ${x.name}`))),
      bills && h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("seats_set", { orgId: org.id, seats: Number(seats.value) }), "Seats updated."); } }, h("label", {}, "Seats "), seats, h("button", { class: "quiet", type: "submit" }, "Set seats")),
      bills && principalForm(org));
  }
  function principalForm(org) {
    const principal = h("input", { value: org.principal || "", placeholder: "oa_…", name: "principal" });
    return h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("organizations_link", { orgId: org.id, principal: principal.value || null }), "OpenAccess principal saved."); } },
      h("label", {}, "OpenAccess principal "), principal, h("button", { class: "quiet", type: "submit" }, "Link"));
  }

  function domainsSection(org, manages) {
    if (!manages) return h("span");
    const lock = state.plan.entitlements.find((e) => e.feature === "sso.domain");
    const input = h("input", { value: org.domains.join(", "), placeholder: "company.com, subsidiary.com", name: "domains", size: 40 });
    return h("div", { class: "card" }, h("h2", {}, "Verified domains"),
      h("p", { class: "muted" }, "People who sign in with one of these email domains join as Users while seats last. A domain is verified by an Owner or Admin who signed in with it."),
      lock && !lock.unlocked ? h("p", { class: "lock" }, `🔒 Verified domains need the ${capital(lock.plan)} plan.`) : null,
      h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(() => call("domains_set", { orgId: org.id, domains: input.value.split(",").map((s) => s.trim()).filter(Boolean) }), "Domains saved."); } }, input, h("button", { class: "quiet", type: "submit" }, "Save")));
  }

  function auditSection(org, manages) {
    if (!manages || !state.audit) return h("span");
    const exportLock = state.plan.entitlements.find((e) => e.feature === "audit.export");
    return h("div", { class: "card" }, h("h2", {}, "Audit log"),
      exportLock && exportLock.unlocked ? h("p", {}, h("a", { href: `/api/v1/organizations/${org.id}/audit.csv` }, "Export CSV")) : h("p", { class: "lock" }, `🔒 Export needs the ${capital(exportLock ? exportLock.plan : "business")} plan.`),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Who"), h("th", {}, "What"), h("th", {}, "Details"))),
        h("tbody", {}, state.audit.map((a) => h("tr", {}, h("td", {}, when(a.at)), h("td", {}, a.actor || "system"), h("td", {}, a.action), h("td", { class: "muted" }, Object.entries(a.details).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")))))));
  }

  function dangerSection(org) {
    const transfer = h("input", { type: "email", placeholder: "new-owner@company.com", name: "transfer" });
    const confirmName = h("input", { placeholder: org.name, name: "confirm" });
    return h("div", { class: "card" }, h("h2", {}, "Danger"),
      org.role === "owner"
        ? h("div", {},
          h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); confirm(`Transfer ownership to ${transfer.value}? You become an admin.`) && act(() => call("organizations_transfer", { orgId: org.id, email: transfer.value }), "Ownership transferred."); } }, h("label", {}, "Transfer ownership to "), transfer, h("button", { class: "danger", type: "submit" }, "Transfer")),
          h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(async () => { await call("organizations_delete", { orgId: org.id, confirm: confirmName.value }); state.orgId = null; await loadOrgs(); }, "Organization deleted."); } }, h("label", {}, "Delete the organization: type its name "), confirmName, h("button", { class: "danger", type: "submit" }, "Delete")))
        : h("button", { class: "danger", onclick: () => confirm(`Leave ${org.name}?`) && act(async () => { await call("members_leave", { orgId: org.id }); state.orgId = null; await loadOrgs(); }, "You left.") }, "Leave this organization"));
  }

  function tokensCard() {
    if (!state.tokens) return h("span");
    const label = h("input", { placeholder: "CI token", name: "label", maxlength: 80 });
    // The token lives in state, not in a node: every action re-renders the
    // whole page, and a node-only token vanished with the render that
    // followed its creation.
    const fresh = state.newToken;
    const reveal = fresh && h("div", { class: "notice ok" },
      h("p", {}, h("strong", {}, `Token “${fresh.label}” created.`), " Copy it now; it is not shown again."),
      h("p", {}, h("input", { class: "token", value: fresh.token, readonly: true, spellcheck: "false", onclick: (e) => e.target.select() })),
      h("p", { class: "muted" }, `In CI: G1TZ_URL=${location.origin} G1TZ_TOKEN=<the token>`),
      h("button", { class: "quiet", onclick: () => { state.newToken = null; render(); } }, "I copied it"));
    return h("div", { class: "card" }, h("h2", {}, "Terminals and tokens"),
      h("p", { class: "muted" }, "Sessions from g1tz login and API tokens for CI. Revoking one signs that terminal out."),
      reveal,
      h("ul", { class: "plain" }, state.tokens.map((t) => h("li", { class: "row" }, `${t.label} (${t.kind}, until ${when(t.expiresAt).slice(0, 10)})`, h("button", { class: "quiet", onclick: () => act(() => call("tokens_revoke", { tokenId: t.id }), "Revoked.") }, "Revoke")))),
      h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(async () => { state.newToken = await call("tokens_create", { label: label.value || "API token" }); }); } }, label, h("button", { class: "quiet", type: "submit" }, "Create API token")));
  }

  boot().catch((error) => { app.innerHTML = ""; app.appendChild(h("div", { class: "notice error" }, error.message)); });
})();
