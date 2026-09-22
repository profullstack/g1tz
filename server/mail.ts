/**
 * Outbound mail through Resend. No console fallback: a sign-in link or an
 * invitation that was never delivered must never look like it was.
 */
export interface SignInMail { to: string; url: string }
export interface InviteMail { to: string; url: string; org: string; inviter: string; role: string }
export interface Mailer {
  signIn(mail: SignInMail): Promise<void>;
  invite(mail: InviteMail): Promise<void>;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function mailer(apiKey = process.env.RESEND_API_KEY, from = process.env.G1TZ_MAIL_FROM, mode = process.env.G1TZ_MAIL): Mailer {
  // G1TZ_MAIL=log prints every link to stderr for local development. It is an
  // explicit opt-in and never a fallback: production refuses it outright.
  if (mode === "log") {
    if (process.env.NODE_ENV === "production") throw new Error("G1TZ_MAIL=log is not allowed in production");
    const log = (kind: string, to: string, url: string) => { console.error(`[mail] ${kind} for ${to}: ${url}`); };
    return {
      signIn: async ({ to, url }) => log("sign-in", to, url),
      invite: async ({ to, url, org }) => log(`invitation to ${org}`, to, url),
    };
  }
  const send = async (to: string, subject: string, textBody: string, html: string) => {
    if (!apiKey || !from) throw new Error("Email delivery is not configured");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ from, to: [to], subject, text: textBody, html }),
    });
    if (!response.ok) {
      console.error("Mail delivery failed", response.status);
      throw new Error("Email provider rejected the message");
    }
  };
  const wrap = (title: string, body: string) =>
    `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:32px;color:#15202b"><h1>${title}</h1>${body}</div>`;
  const button = (url: string, label: string) =>
    `<p style="margin:32px 0"><a href="${escape(url)}" style="background:#1d4ed8;color:white;padding:14px 22px;border-radius:6px;text-decoration:none">${label}</a></p>`;
  return {
    signIn: ({ to, url }) => send(to, "Your g1tz sign-in link",
      `Sign in to g1tz\n\nOpen this link to verify your email and sign in:\n${url}\n\nIt expires in 15 minutes and works once. If you didn't request it, ignore this email. Never forward this link.`,
      wrap("Sign in to g1tz", `<p>Verify your email and sign in.</p>${button(url, "Verify email &amp; sign in")}<p>The link expires in 15 minutes and works once.</p><p>If you didn't request it, ignore this email. Never forward this link.</p>`)),
    invite: ({ to, url, org, inviter, role }) => send(to, `${inviter} invited you to ${org} on g1tz`,
      `${inviter} invited you to join ${org} on g1tz as ${role}.\n\nAccept here:\n${url}\n\nThe invitation expires in 7 days.`,
      wrap(`Join ${escape(org)}`, `<p>${escape(inviter)} invited you to join <b>${escape(org)}</b> as <b>${escape(role)}</b>.</p>${button(url, "Accept the invitation")}<p>The invitation expires in 7 days.</p>`)),
  };
}
