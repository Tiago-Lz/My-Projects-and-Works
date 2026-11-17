'use strict';
// Envio do código de verificação do cadastro.
// Com SMTP configurado pelo responsável (painel → E-mail), envia de verdade.
// Sem SMTP, o código aparece só na janela de console do sistema, nesta máquina.

const CAMPOS = ['smtp_host', 'smtp_porta', 'smtp_seguro', 'smtp_usuario', 'smtp_senha', 'smtp_remetente'];

function configurado(cfg) { return Boolean(cfg.smtp_host && cfg.smtp_remetente); }

async function enviarSmtp(cfg, { para, assunto, texto, html }) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: Number(cfg.smtp_porta) || 587,
    secure: cfg.smtp_seguro === '1',
    auth: cfg.smtp_usuario ? { user: cfg.smtp_usuario, pass: cfg.smtp_senha } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
  await t.sendMail({ from: cfg.smtp_remetente, to: para, subject: assunto, text: texto, html });
}

function mensagemCodigo(nome, codigo) {
  const primeiro = String(nome).split(' ')[0];
  const texto = `Olá, ${primeiro}.\n\nSeu código para criar a conta no Emissor de Certidões é ${codigo}.\nEle vale por 10 minutos.\n\nSe você não pediu este cadastro, ignore este e-mail.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1b2430">
    <p style="font-size:13px;color:#5d6875;letter-spacing:.08em;text-transform:uppercase">Emissor de Certidões</p>
    <p>Olá, ${primeiro.replace(/[<>&"]/g, '')}.</p><p>Use o código abaixo para confirmar seu e-mail:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:.3em;background:#f1f4f8;padding:16px;text-align:center;border-radius:8px">${codigo}</p>
    <p style="font-size:13px;color:#5d6875">O código vale por 10 minutos. Se você não pediu este cadastro, ignore este e-mail.</p></div>`;
  return { assunto: `${codigo} é o seu código de verificação`, texto, html };
}

/** Cria a função de envio usada pelo servidor. Devolve { modo: 'email' | 'console' }. */
function criarEnviador(banco) {
  return async ({ para, nome, codigo }) => {
    const cfg = banco.textos();
    if (!configurado(cfg)) {
      console.log(`\n[Cadastro] Envio de e-mail não configurado. Código para ${para}: ${codigo}\n`);
      return { modo: 'console' };
    }
    await enviarSmtp(cfg, { para, ...mensagemCodigo(nome, codigo) });
    return { modo: 'email' };
  };
}

module.exports = { CAMPOS, configurado, enviarSmtp, criarEnviador, mensagemCodigo };
