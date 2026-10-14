// Email delivery. Prefers Resend over a Gmail Apps Script relay. If neither
// is configured we still generate the OTP, write it to the audit log, and the
// admin reads it out of band — demo-friendly.

export async function sendOtpEmail(env, to, otp, subject = "Plasma Lab LIMS verification code") {
  if (env.RESEND_API_KEY && env.SMTP_FROM) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: `${env.SMTP_FROM_NAME || "Plasma Lab LIMS"} <${env.SMTP_FROM}>`,
        to: [to],
        subject,
        text: `Your Plasma Lab LIMS OTP is ${otp}. This code expires in 24 hours.`
      })
    });
    if (!r.ok) throw new Error(`Email delivery failed: ${await r.text()}`);
    return true;
  }
  if (env.GMAIL_APPS_SCRIPT_URL) {
    const r = await fetch(env.GMAIL_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, otp, subject })
    });
    if (!r.ok) throw new Error("Gmail email delivery failed");
    return true;
  }
  return false;
}

export function emailConfigured(env) {
  return Boolean((env.RESEND_API_KEY && env.SMTP_FROM) || env.GMAIL_APPS_SCRIPT_URL);
}

// Fire-and-forget OTP send. Returns true if the Worker was configured to send
// anything, false if we only generated the code. The caller still writes the
// audit row either way.
export function sendOtpInBackground(ctx, env, to, otp, subject) {
  if (!emailConfigured(env)) return false;
  const task = sendOtpEmail(env, to, otp, subject).catch(e =>
    console.error(JSON.stringify({ event: "otp_email_failed", to, error: e.message }))
  );
  if (ctx?.waitUntil) ctx.waitUntil(task); else void task;
  return true;
}
