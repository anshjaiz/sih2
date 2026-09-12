const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const sendOtpEmail = async ({ toEmail, otp, name }) => {
  try {
    const data = await resend.emails.send({
      from: 'Shramik Setu <onboarding@resend.dev>',
      to: toEmail,
      subject: 'Your Verification Code - Shramik Setu',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Hello ${name || 'User'},</h2>
          <p>Your verification code for Shramik Setu is:</p>
          <h1 style="color: #4F46E5; letter-spacing: 2px;">${otp}</h1>
          <p>This code will expire in 5 minutes.</p>
        </div>
      `,
    });

    return { delivered: true, data };
  } catch (error) {
    console.error('Resend Email Error:', error);
    return { delivered: false, error };
  }
};

module.exports = { sendOtpEmail };