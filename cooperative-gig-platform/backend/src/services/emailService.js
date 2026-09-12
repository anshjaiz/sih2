const nodemailer = require('nodemailer');
const env = require('../config/env');
const { OTP_TTL_MS } = require('../utils/otpUtils');
const { ApiError } = require('../middleware/errorMiddleware');

// Reusable Gmail SMTP transporter, created lazily from EMAIL_USER /
// EMAIL_APP_PASSWORD. Credentials are read from env ONLY and are never
// exposed to the API layer.
let transporter = null;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587, // STARTTLS — 465 (implicit TLS) is frequently blocked by hosts
      secure: false,
      requireTLS: true,
      auth: {
        user: env.emailUser,
        pass: env.emailAppPassword,
      },
      // Fail fast instead of hanging the register request for the SMTP layer's
      // default ~2min. A blocked/unreachable relay should surface a 502 in a
      // few seconds, not leave the user stuck on a spinner.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
  }
  return transporter;
};

/**
 * Send a 6-digit verification code email via Gmail SMTP (Nodemailer).
 * Returns { delivered: true } on success, or { delivered: false, otp }
 * when OTP_CONSOLE_FALLBACK is enabled and delivery failed (DEV ONLY).
 * On failure with the fallback OFF, throws a friendly ApiError — Gmail
 * internals and credentials are never surfaced to the client.
 */
const sendOtpEmail = async ({ toEmail, otp, name }) => {
  if (!env.emailUser || !env.emailAppPassword) {
    return devFallback({
      toEmail,
      otp,
      reason: 'EMAIL_USER / EMAIL_APP_PASSWORD not configured',
    });
  }

  const minutes = Math.round(OTP_TTL_MS / 60000);

  const mailOptions = {
    from: `"ShramikSetu" <${env.emailUser}>`,
    to: toEmail,
    subject: 'Verify your ShramikSetu account',
    html: `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:440px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e9eaf0;">
            <tr>
              <td style="padding:28px 28px 8px;">
                <p style="margin:0;font-size:18px;font-weight:bold;color:#1f2937;">ShramikSetu</p>
                <p style="margin:6px 0 0;font-size:13px;color:#6b7280;">Cooperative Gig Services Platform</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;">
                <p style="margin:0;font-size:14px;color:#374151;">Hi ${name || 'there'},</p>
                <p style="margin:14px 0 0;font-size:14px;color:#374151;">Use the code below to verify your email address. It expires in <strong>${minutes} minutes</strong>.</p>
                <p style="margin:22px 0 0;text-align:center;">
                  <span style="display:inline-block;background:#eef2ff;color:#4338ca;font-size:30px;font-weight:bold;letter-spacing:8px;padding:12px 22px;border-radius:10px;">${otp}</span>
                </p>
                <p style="margin:22px 0 0;font-size:12px;color:#9ca3af;">For your security, never share this code with anyone. ShramikSetu will never ask you for it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };

  try {
    await getTransporter().sendMail(mailOptions);
    // DEV convenience (OTP_CONSOLE_FALLBACK=true): mirror the code we just
    // emailed so demos can complete registration without opening the inbox.
    if (env.otpConsoleFallback) {
      console.warn(`[DEV] OTP emailed to ${toEmail} = ${otp}`);
    }
    return { delivered: true };
  } catch (error) {
    // Log server-side for diagnosis (App Password must never reach the client).
    console.error(
      `[email] OTP send to ${toEmail} failed: ${error.responseCode || error.code || ''}` +
        (error.response ? ` — ${String(error.response).slice(0, 200)}` : '') +
        ` (${error.message || 'unknown error'})`
    );
    return devFallback({ toEmail, otp, reason: error.message });
  }
};

// DEV ONLY (OTP_CONSOLE_FALLBACK=true): when SMTP delivery fails, surface the
// OTP on the server console (and, via { delivered:false }, to the request
// response) so local demos still register without a working mail account.
const devFallback = ({ toEmail, otp, reason }) => {
  if (!env.otpConsoleFallback) {
    throw new ApiError('Unable to send the verification email right now. Please try again in a moment.', 502);
  }
  console.warn(`[DEV] OTP for ${toEmail} (email delivery unavailable — ${reason || 'SMTP failure'}): code = ${otp}`);
  return { delivered: false, otp };
};

module.exports = { sendOtpEmail };