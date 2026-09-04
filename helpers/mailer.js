const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_TLS === 'true' && String(process.env.SMTP_PORT) === '465',
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      tls:
        process.env.SMTP_TLS === 'false'
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }
  return transporter;
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

async function sendMail({ to, subject, text, html, attachments = [] }) {
  const transport = getTransporter();
  if (!transport) {
    console.log('[mailer] SMTP não configurado — email NÃO enviado:');
    console.log(`  Para: ${to}\n  Assunto: ${subject}\n  Corpo: ${text || html}`);
    return { enviado: false, motivo: 'SMTP não configurado' };
  }
  const info = await transport.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Condomínio'}" <${process.env.SMTP_FROM || 'noreply@localhost'}>`,
    to,
    subject,
    text,
    html,
    attachments,
  });
  return { enviado: true, messageId: info.messageId };
}

module.exports = { sendMail, smtpConfigured };
