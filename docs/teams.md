# Teams

g1tz Teams gives the git TUI an organization: who you work with, what each
person may do, how many seats you have, which repositories a team shares, and
who changed what. It follows GitKraken's organization model on purpose, so a
team that already runs on GitKraken finds the same words and the same rules.

The service runs at **https://g1tz.hqtui.com**. The terminal and the browser
share one identity: `g1tz login` prints a code you approve on the account page,
and the terminal receives a 90-day token that is never typed or pasted.

## Roles

One organization has exactly one Owner. Every other role can be held by any
number of people.

| Role | Holds a seat | Manage users | Manage teams and workspaces | Billing | Insights | Transfer ownership |
|---|---|---|---|---|---|---|
| Owner | yes | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | yes | ✓ | ✓ | ✓ | ✓ | |
| Lead | yes | | ✓ | | ✓ | |
| User | yes | | | | | |
| Billing Contact | **no** | | | ✓ | | |

- Admins cannot change or remove the Owner. Ownership moves with
  `g1tz org transfer ORG EMAIL`; the previous Owner becomes an Admin.
- The Lead role exists on plans that have Insights (Business and up), as it
  does in GitKraken.
- Managing users covers inviting, changing roles, removing, verified domains,
  CSV import and export, renaming the organization and reading the audit log.

## Seats

Every role except Billing Contact consumes a seat. A pending invitation holds a
seat until it is accepted or revoked. The plan caps how many seats an
organization can hold; adding a person past the cap is refused with the plan
that would allow it.

```
Seats: 3 in use, 1 invited, 6 free of 10 (cap 10)
```

## Plans

| Plan | Seats | Unlocks |
|---|---|---|
| Community | 1 | Everything local: the repository, staging, Pulse. A personal organization. |
| Pro | up to 2 | Invite people and assign roles. Shared workspaces for the whole organization. |
| Advanced | up to 10 | Teams, and workspaces only a team sees. One verified email domain. |
| Business | up to 100 | Any number of verified domains. Insights and the Lead role. Audit log export. |
| Enterprise | unlimited | Custom contract and a support SLA. |

Tiers nest: whatever Pro has, Advanced has. The whole table lives in
`src/teams-model.ts`, the server enforces it (HTTP 402 carries the feature and
the plan that unlocks it), and the CLI and the Team screen show every feature
with its plan, unlocked or locked.

Nothing local is ever gated. Community keeps the repository screen, staging and
Pulse exactly as they are.

### How a plan arrives

A plan is an [OpenAccess](https://logicsrc.com/openaccess) entitlement, so it
is bought once for a principal and every app that honours the product hears
about it.

1. An Owner, Admin or Billing Contact links the organization to its principal:
   `g1tz org link ORG oa_…` (or on the account page).
2. The product is bought at the hub. This site's descriptor at
   `/.well-known/openaccess.json` names one product per paid tier:
   `g1tz.hqtui.com/pro`, `/advanced`, `/business`, `/enterprise`.
3. The hub signs an entitlement event (Ed25519, `X-OpenAccess-Signature`) to
   `POST /api/openaccess/webhook`. The organization moves to the plan with the
   seats the entitlement carries. When it lapses the organization returns to
   Community and keeps its people; it just cannot add more.

Nothing on the site takes a card. The site administrator (`admin_claim` with
`G1TZ_ADMIN_BOOTSTRAP_SECRET`) can also set a plan directly, which is how a
comped or hand-invoiced organization is handled.

## Teams and workspaces

- A team is a named group inside the organization. Owners, Admins and Leads
  create teams; whoever creates one is on it.
- A workspace is a named list of repositories (remote URLs). An organization
  workspace is visible to every member. A team workspace is visible only to
  that team (and to Owners and Admins). A Lead makes workspaces for the teams
  they are on.
- Deleting a team deletes its workspaces. Removing a member removes them from
  every team.

## Verified domains

An Owner or Admin who signed in with `@example.com` can verify `example.com`.
From then on anyone who signs in with that domain joins the organization as a
User, while seats last. Advanced allows one domain, Business any number. Public
mail providers are refused.

## Audit log

Every change to the organization is recorded with who did it: member invited,
joined, role changed, removed; team and workspace changes; plan and seat
changes (entitlement events are recorded with no actor). Owners and Admins read
it with `g1tz audit`; Business and up export it as CSV.

## Command line

```
g1tz login [--label NAME]            a code, approved in the browser
g1tz logout | whoami
g1tz org list | create NAME | show [ID] | use ID | rename ID NAME
g1tz org transfer ID EMAIL | link ID PRINCIPAL | domains ID [DOMAIN ...] | delete ID --confirm NAME
g1tz members [--org ID]
g1tz members invite EMAIL [--role admin|lead|user|billing] [--team ID]
g1tz members role EMAIL ROLE | remove EMAIL | leave | export [--out FILE] | import FILE
g1tz invites | invites accept ID | revoke ID
g1tz teams | teams create NAME | rename ID NAME | delete ID | members ID | add ID EMAIL | remove ID EMAIL
g1tz workspaces | workspaces create NAME [--team ID] | show ID | delete ID | add ID URL | rm ID URL
g1tz plan | plan request PLAN | plan seats N
g1tz audit [--limit N] [--export FILE]
g1tz cloud OPERATION [--args JSON]   any operation, raw
```

`--org ID` or `G1TZ_ORG` picks the organization; `g1tz org use ID` remembers
one. `--json` prints the server's answer. `G1TZ_URL` points at another server
(a saved token never travels to a different one); `G1TZ_TOKEN` supplies a token
for CI, created on the account page.

In the TUI, `t` opens the Team screen; `Tab` cycles members, teams and
workspaces; `r` re-reads; `t` or `Esc` goes back.

## Parity with GitKraken

| GitKraken | g1tz | Notes |
|---|---|---|
| Organization with one Owner | ✓ | |
| Roles: Owner, Admin, Lead, User, Billing Contact | ✓ | Same permissions, same seat rule |
| Licenses / seats, purchase workflow when full | ✓ | Seats per plan; entitlement carries the count |
| Teams (Advanced+) | ✓ | |
| Cloud Workspaces (Pro+), team visibility (Advanced+) | ✓ | Repository lists; the TUI shows them |
| CSV import and export of users | ✓ | |
| SSO | partial | Verified email domains that auto-join. No SAML/SCIM yet. |
| Insights (Business+) | partial | The Lead role and the gate exist; no DORA-style metrics yet. |
| Launchpad, Team Launchpad | not yet | PRs, issues and tasks across a workspace |
| Cloud Patches, Code Suggest | not yet | |
| AI commit messages, conflict resolution | not yet | |
| Multiple organizations per account | ✓ | Up to 20 owned |
| Audit log | ✓ | Export on Business+ |

## Running your own

```
G1TZ_URL=https://teams.example.com G1TZ_DB=/data/g1tz.sqlite \
RESEND_API_KEY=… G1TZ_MAIL_FROM="g1tz <accounts@example.com>" \
bun server/server.ts
```

`G1TZ_MAIL=log` prints every sign-in link and invitation to stderr instead of
sending it; it is refused when `NODE_ENV=production`. `G1TZ_ADMIN_BOOTSTRAP_SECRET`
lets the first person who knows it claim site administration
(`g1tz cloud admin_claim --args '{"token":"…"}'`). Point the CLI at your
server with `G1TZ_URL`.
