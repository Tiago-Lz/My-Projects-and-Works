'use strict';
// Primitivas de criptografia: senhas com scrypt, dados com AES-256-GCM.

const crypto = require('node:crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

/** Deriva 64 bytes da senha: 32 para conferir o login, 32 para proteger a chave de dados. */
function derivar(senha, sal) {
  const d = crypto.scryptSync(String(senha), sal, 64, SCRYPT);
  return { verificador: d.subarray(0, 32), kek: d.subarray(32) };
}

function cifrar(chave, buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const corpo = Buffer.concat([c.update(buffer), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), corpo]);
}

function decifrar(chave, buffer) {
  const d = crypto.createDecipheriv('aes-256-gcm', chave, buffer.subarray(0, 12));
  d.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([d.update(buffer.subarray(28)), d.final()]);
}

const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

module.exports = { derivar, cifrar, decifrar, iguais };
