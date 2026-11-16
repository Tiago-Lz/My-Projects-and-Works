'use strict';
// Banco de dados local (SQLite): contas de usuário e o índice das certidões
// guardadas. Nenhum dado do pesquisado é gravado aqui além do primeiro nome
// usado no nome do arquivo; CPF/CNPJ, filiação, nascimento e RG existem só em
// memória durante a emissão.
//
// As certidões ficam cifradas em disco com uma chave de dados aleatória. Essa
// chave é guardada uma vez por usuário, protegida pela senha dele, de modo que
// só quem faz login consegue abrir os arquivos.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// O módulo embutido de SQLite avisa que é experimental; o aviso só confundiria na janela do sistema.
const avisar = process.emitWarning;
process.emitWarning = (aviso, ...resto) => (String(aviso).includes('SQLite') ? undefined : avisar.call(process, aviso, ...resto));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = avisar;
const { derivar, cifrar, decifrar, iguais } = require('./cripto');

const DIAS_RETENCAO = 7;

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER PRIMARY KEY,
  usuario       TEXT NOT NULL UNIQUE,
  nome          TEXT NOT NULL,
  perfil        TEXT NOT NULL CHECK (perfil IN ('admin', 'operador')),
  sal           BLOB NOT NULL,
  senha_hash    BLOB NOT NULL,
  chave_cifrada BLOB NOT NULL,
  ativo         INTEGER NOT NULL DEFAULT 1,
  criado_em     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS arquivos (
  id            TEXT PRIMARY KEY,
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  orgao         TEXT NOT NULL,
  certidao      TEXT NOT NULL,
  nome_arquivo  TEXT NOT NULL,
  mime          TEXT NOT NULL,
  origem        TEXT NOT NULL,
  tamanho       INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  criado_em     TEXT NOT NULL,
  expira_em     TEXT NOT NULL
);`;

class Banco {
  constructor(dir) {
    this.dir = dir;
    this.dirArquivos = path.join(dir, 'arquivos');
    fs.mkdirSync(this.dirArquivos, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, 'emissor.db'));
    this.db.exec('PRAGMA foreign_keys = ON;' + ESQUEMA);
  }

  fechar() { this.db.close(); }

  // ---------- Usuários ----------
  temUsuarios() { return this.db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0; }

  _validar({ usuario, nome, senha }) {
    const u = String(usuario ?? '').trim().toLowerCase();
    const n = String(nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('Usuário: use de 3 a 32 letras, números, ponto, hífen ou sublinhado.');
    if (n.length < 2) throw new Error('Informe o nome do usuário.');
    this._validarSenha(senha);
    return { usuario: u, nome: n };
  }

  _validarSenha(senha) {
    if (String(senha ?? '').length < 8) throw new Error('A senha deve ter ao menos 8 caracteres.');
  }

  _inserir({ usuario, nome, senha, perfil }, chave) {
    const sal = crypto.randomBytes(16);
    const { verificador, kek } = derivar(senha, sal);
    try {
      const r = this.db.prepare('INSERT INTO usuarios (usuario, nome, perfil, sal, senha_hash, chave_cifrada, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(usuario, nome, perfil, sal, verificador, cifrar(kek, chave), new Date().toISOString());
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new Error('Já existe um usuário com esse login.');
      throw e;
    }
  }

  /** Primeiro acesso: cria o administrador e a chave de dados. */
  criarPrimeiroAdmin(dados) {
    if (this.temUsuarios()) throw new Error('O sistema já foi configurado.');
    const v = this._validar(dados);
    this._inserir({ ...v, senha: dados.senha, perfil: 'admin' }, crypto.randomBytes(32));
    return this.autenticar(v.usuario, dados.senha);
  }

  /** `chave` é a chave de dados de quem está criando (um administrador logado). */
  criarUsuario(dados, chave) {
    const v = this._validar(dados);
    const id = this._inserir({ ...v, senha: dados.senha, perfil: dados.perfil === 'admin' ? 'admin' : 'operador' }, chave);
    return this.usuario(id);
  }

  /** Devolve { usuario, chave } ou null. */
  autenticar(usuario, senha) {
    const u = this.db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(String(usuario ?? '').trim().toLowerCase());
    // Deriva mesmo sem usuário, para o tempo de resposta não revelar se o login existe.
    const { verificador, kek } = derivar(senha, u ? u.sal : Buffer.alloc(16));
    if (!u || !u.ativo || !iguais(verificador, Buffer.from(u.senha_hash))) return null;
    return { usuario: this.usuario(u.id), chave: decifrar(kek, Buffer.from(u.chave_cifrada)) };
  }

  /** Troca a senha regravando a chave de dados sob a senha nova. */
  definirSenha(id, senhaNova, chave) {
    this._validarSenha(senhaNova);
    const sal = crypto.randomBytes(16);
    const { verificador, kek } = derivar(senhaNova, sal);
    this.db.prepare('UPDATE usuarios SET sal = ?, senha_hash = ?, chave_cifrada = ? WHERE id = ?').run(sal, verificador, cifrar(kek, chave), id);
  }

  usuario(id) { return this.db.prepare('SELECT id, usuario, nome, perfil, ativo, criado_em FROM usuarios WHERE id = ?').get(id); }
  usuarios() { return this.db.prepare('SELECT id, usuario, nome, perfil, ativo, criado_em FROM usuarios ORDER BY nome').all(); }

  definirAtivo(id, ativo) {
    const u = this.usuario(id);
    if (!u) throw new Error('Usuário não encontrado.');
    if (!ativo && u.perfil === 'admin' && this.db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'admin' AND ativo = 1 AND id <> ?").get(id).n === 0) {
      throw new Error('Não é possível desativar o único administrador.');
    }
    this.db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
  }

  // ---------- Certidões guardadas ----------
  _caminho(id) { return path.join(this.dirArquivos, id + '.enc'); }

  guardarArquivo({ usuarioId, orgao, certidao, nomeArquivo, mime, origem, conteudo }, chave) {
    const id = crypto.randomUUID();
    const agora = Date.now();
    fs.writeFileSync(this._caminho(id), cifrar(chave, conteudo), { mode: 0o600 });
    this.db.prepare('INSERT INTO arquivos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, usuarioId, orgao, certidao, nomeArquivo, mime, origem, conteudo.length,
      crypto.createHash('sha256').update(conteudo).digest('hex'),
      new Date(agora).toISOString(), new Date(agora + DIAS_RETENCAO * 86400000).toISOString());
    return id;
  }

  /** Arquivos do usuário; administradores veem os de todos. */
  arquivos(usuario) {
    this.limparVencidos();
    const sql = 'SELECT a.*, u.nome AS dono FROM arquivos a JOIN usuarios u ON u.id = a.usuario_id';
    return usuario.perfil === 'admin'
      ? this.db.prepare(sql + ' ORDER BY a.criado_em DESC').all()
      : this.db.prepare(sql + ' WHERE a.usuario_id = ? ORDER BY a.criado_em DESC').all(usuario.id);
  }

  arquivo(id, usuario) {
    const a = this.db.prepare('SELECT * FROM arquivos WHERE id = ?').get(id);
    if (!a || (usuario.perfil !== 'admin' && a.usuario_id !== usuario.id)) return null;
    if (a.expira_em <= new Date().toISOString()) { this.apagarArquivo(id); return null; }
    return a;
  }

  lerArquivo(id, chave) { return decifrar(chave, fs.readFileSync(this._caminho(id))); }

  apagarArquivo(id) {
    fs.rmSync(this._caminho(id), { force: true });
    this.db.prepare('DELETE FROM arquivos WHERE id = ?').run(id);
  }

  /** Apaga do disco e do banco tudo que passou do prazo de retenção. */
  limparVencidos(agora = new Date()) {
    const vencidos = this.db.prepare('SELECT id FROM arquivos WHERE expira_em <= ?').all(agora.toISOString());
    for (const { id } of vencidos) this.apagarArquivo(id);
    return vencidos.length;
  }
}

module.exports = { Banco, DIAS_RETENCAO };
