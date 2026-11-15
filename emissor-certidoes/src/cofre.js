'use strict';
// Cofre local: tudo que contém dado pessoal é gravado em disco cifrado com
// AES-256-GCM. A chave é derivada da senha mestra (scrypt) e só existe em memória.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

class Cofre {
  constructor(dir) {
    this.dir = dir;
    this.arquivoMeta = path.join(dir, 'cofre.json');
    this.chave = null;
  }

  get configurado() { return fs.existsSync(this.arquivoMeta); }
  get aberto() { return this.chave !== null; }

  _derivar(senha, sal) { return crypto.scryptSync(String(senha), sal, 32, SCRYPT); }

  criar(senha) {
    if (this.configurado) throw new Error('Cofre já configurado.');
    if (String(senha).length < 8) throw new Error('A senha mestra deve ter ao menos 8 caracteres.');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const sal = crypto.randomBytes(16);
    this.chave = this._derivar(senha, sal);
    const meta = { versao: 1, sal: sal.toString('base64'), verificador: this.cifrar(Buffer.from('cofre-ok')).toString('base64') };
    fs.writeFileSync(this.arquivoMeta, JSON.stringify(meta), { mode: 0o600 });
  }

  abrir(senha) {
    const meta = JSON.parse(fs.readFileSync(this.arquivoMeta, 'utf8'));
    const chave = this._derivar(senha, Buffer.from(meta.sal, 'base64'));
    try {
      this.chave = chave;
      this.decifrar(Buffer.from(meta.verificador, 'base64'));
      return true;
    } catch {
      this.chave = null;
      return false;
    }
  }

  fechar() { if (this.chave) this.chave.fill(0); this.chave = null; }

  cifrar(buffer) {
    if (!this.chave) throw new Error('Cofre bloqueado.');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.chave, iv);
    const corpo = Buffer.concat([c.update(buffer), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), corpo]);
  }

  decifrar(buffer) {
    if (!this.chave) throw new Error('Cofre bloqueado.');
    const d = crypto.createDecipheriv('aes-256-gcm', this.chave, buffer.subarray(0, 12));
    d.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([d.update(buffer.subarray(28)), d.final()]);
  }

  gravar(nome, buffer) {
    const destino = path.join(this.dir, nome);
    fs.mkdirSync(path.dirname(destino), { recursive: true, mode: 0o700 });
    const tmp = destino + '.tmp';
    fs.writeFileSync(tmp, this.cifrar(buffer), { mode: 0o600 });
    fs.renameSync(tmp, destino);
  }

  ler(nome) { return this.decifrar(fs.readFileSync(path.join(this.dir, nome))); }
  existe(nome) { return fs.existsSync(path.join(this.dir, nome)); }
  apagar(nome) { fs.rmSync(path.join(this.dir, nome), { force: true }); }
}

module.exports = { Cofre };
