'use strict';
// Banco de dados local (SQLite): contas, usuários, mensalidades e o índice das
// certidões guardadas.
//
// Três perfis:
//   dono     gerencia as contas dos escritórios, preços, limites e pagamentos.
//            Não pertence a conta alguma e NÃO consegue abrir certidões.
//   admin    quem paga: dono de uma conta (escritório). Gera chaves de convite
//            e gerencia os usuários da própria conta.
//   usuario  entra com uma chave de convite gerada pelo admin e usa a conta dele.
//
// Dados do pesquisado não são gravados aqui (só o primeiro nome, no nome do
// arquivo). As certidões ficam cifradas com a chave de dados da conta; essa
// chave é guardada uma vez por usuário, protegida pela senha dele, e uma vez
// por convite pendente, protegida pela própria chave de convite.

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
const DIAS_CONVITE = 7;
const DIA = 86400000;
const VERSAO = 2;

const PADROES = { valor_mensal_centavos: 9900, limite_usuarios: 3, limite_certidoes_mes: 200, dias_teste: 7 };

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contas (
  id                    INTEGER PRIMARY KEY,
  nome                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'suspensa')),
  valor_mensal_centavos INTEGER NOT NULL,
  limite_usuarios       INTEGER NOT NULL,
  limite_certidoes_mes  INTEGER NOT NULL,
  vence_em              TEXT NOT NULL,
  criado_em             TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER PRIMARY KEY,
  conta_id      INTEGER REFERENCES contas(id),
  usuario       TEXT NOT NULL UNIQUE,
  nome          TEXT NOT NULL,
  perfil        TEXT NOT NULL CHECK (perfil IN ('dono', 'admin', 'usuario')),
  sal           BLOB NOT NULL,
  senha_hash    BLOB NOT NULL,
  chave_cifrada BLOB,
  ativo         INTEGER NOT NULL DEFAULT 1,
  criado_em     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS convites (
  id            INTEGER PRIMARY KEY,
  conta_id      INTEGER NOT NULL REFERENCES contas(id),
  codigo_hash   BLOB NOT NULL UNIQUE,
  sal           BLOB NOT NULL,
  chave_cifrada BLOB NOT NULL,
  criado_em     TEXT NOT NULL,
  expira_em     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pagamentos (
  id             INTEGER PRIMARY KEY,
  conta_id       INTEGER NOT NULL REFERENCES contas(id),
  valor_centavos INTEGER NOT NULL,
  registrado_em  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emissoes (
  id         INTEGER PRIMARY KEY,
  conta_id   INTEGER NOT NULL REFERENCES contas(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  orgao      TEXT NOT NULL,
  criado_em  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS arquivos (
  id            TEXT PRIMARY KEY,
  conta_id      INTEGER NOT NULL REFERENCES contas(id),
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

const agoraIso = () => new Date().toISOString();
const inteiro = (v, min, max, nome) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nome}: informe um número inteiro entre ${min} e ${max}.`);
  return n;
};

class Banco {
  constructor(dir) {
    this.dir = dir;
    this.dirArquivos = path.join(dir, 'arquivos');
    fs.mkdirSync(this.dirArquivos, { recursive: true, mode: 0o700 });
    const arquivoDb = path.join(dir, 'emissor.db');
    this.db = new DatabaseSync(arquivoDb);
    // Banco de uma versão anterior (outro esquema de perfis): é posto de lado, não convertido.
    const versao = this.db.prepare('PRAGMA user_version').get().user_version;
    const temTabelas = this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'usuarios'").get().n > 0;
    if (versao !== VERSAO && temTabelas) {
      this.db.close();
      fs.renameSync(arquivoDb, path.join(dir, `emissor-v${versao}-${Date.now()}.db.antigo`));
      this.db = new DatabaseSync(arquivoDb);
    }
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA user_version = ${VERSAO};` + ESQUEMA);
    const ins = this.db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
    for (const [k, v] of Object.entries(PADROES)) ins.run(k, v);
  }

  fechar() { this.db.close(); }
  _um(sql, ...p) { return this.db.prepare(sql).get(...p); }
  _todos(sql, ...p) { return this.db.prepare(sql).all(...p); }
  _exec(sql, ...p) { return this.db.prepare(sql).run(...p); }

  // ---------- Configuração (padrões para contas novas) ----------
  config() { return Object.fromEntries(this._todos('SELECT chave, valor FROM config').map((r) => [r.chave, r.valor])); }

  definirConfig(e) {
    const novo = {
      valor_mensal_centavos: inteiro(e.valor_mensal_centavos, 0, 100000000, 'Valor da mensalidade'),
      limite_usuarios: inteiro(e.limite_usuarios, 1, 10000, 'Limite de usuários'),
      limite_certidoes_mes: inteiro(e.limite_certidoes_mes, 0, 10000000, 'Limite de certidões por mês'),
      dias_teste: inteiro(e.dias_teste, 0, 365, 'Dias de teste'),
    };
    for (const [k, v] of Object.entries(novo)) this._exec('UPDATE config SET valor = ? WHERE chave = ?', v, k);
    return this.config();
  }

  // ---------- Usuários ----------
  temDono() { return this._um("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'dono'").n > 0; }

  _validar({ usuario, nome, senha }) {
    const u = String(usuario ?? '').trim().toLowerCase();
    const n = String(nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('Usuário: use de 3 a 32 letras, números, ponto, hífen ou sublinhado.');
    if (n.length < 2) throw new Error('Informe o nome.');
    this._validarSenha(senha);
    if (this._um('SELECT 1 AS x FROM usuarios WHERE usuario = ?', u)) throw new Error('Já existe um usuário com esse login.');
    return { usuario: u, nome: n };
  }

  _validarSenha(senha) {
    if (String(senha ?? '').length < 8) throw new Error('A senha deve ter ao menos 8 caracteres.');
  }

  _inserir({ usuario, nome, senha, perfil, contaId }, chave) {
    const sal = crypto.randomBytes(16);
    const { verificador, kek } = derivar(senha, sal);
    const r = this._exec('INSERT INTO usuarios (conta_id, usuario, nome, perfil, sal, senha_hash, chave_cifrada, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      contaId ?? null, usuario, nome, perfil, sal, verificador, chave ? cifrar(kek, chave) : null, agoraIso());
    return Number(r.lastInsertRowid);
  }

  /** Primeiro acesso: cria o dono do sistema. */
  criarDono(dados) {
    if (this.temDono()) throw new Error('O sistema já foi configurado.');
    const v = this._validar(dados);
    this._inserir({ ...v, senha: dados.senha, perfil: 'dono' }, null);
    return this.autenticar(v.usuario, dados.senha);
  }

  /** Cadastro de um escritório: cria a conta (em período de teste) e o administrador pagante. */
  criarConta(dados) {
    const escritorio = String(dados.escritorio ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (escritorio.length < 2) throw new Error('Informe o nome do escritório.');
    const v = this._validar(dados);
    const cfg = this.config();
    const conta = this._exec('INSERT INTO contas (nome, valor_mensal_centavos, limite_usuarios, limite_certidoes_mes, vence_em, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
      escritorio, cfg.valor_mensal_centavos, cfg.limite_usuarios, cfg.limite_certidoes_mes, new Date(Date.now() + cfg.dias_teste * DIA).toISOString(), agoraIso());
    this._inserir({ ...v, senha: dados.senha, perfil: 'admin', contaId: Number(conta.lastInsertRowid) }, crypto.randomBytes(32));
    return this.autenticar(v.usuario, dados.senha);
  }

  /** Devolve { usuario, chave } ou null. `chave` é null para o dono. */
  autenticar(usuario, senha) {
    const u = this._um('SELECT * FROM usuarios WHERE usuario = ?', String(usuario ?? '').trim().toLowerCase());
    // Deriva mesmo sem usuário, para o tempo de resposta não revelar se o login existe.
    const { verificador, kek } = derivar(senha, u ? u.sal : Buffer.alloc(16));
    if (!u || !u.ativo || !iguais(verificador, Buffer.from(u.senha_hash))) return null;
    return { usuario: this.usuario(u.id), chave: u.chave_cifrada ? decifrar(kek, Buffer.from(u.chave_cifrada)) : null };
  }

  /** Troca a senha regravando a chave de dados sob a senha nova. */
  definirSenha(id, senhaNova, chave) {
    this._validarSenha(senhaNova);
    const sal = crypto.randomBytes(16);
    const { verificador, kek } = derivar(senhaNova, sal);
    this._exec('UPDATE usuarios SET sal = ?, senha_hash = ?, chave_cifrada = ? WHERE id = ?', sal, verificador, chave ? cifrar(kek, chave) : null, id);
  }

  usuario(id) { return this._um('SELECT id, conta_id, usuario, nome, perfil, ativo, criado_em FROM usuarios WHERE id = ?', id); }
  usuariosDaConta(contaId) { return this._todos('SELECT id, usuario, nome, perfil, ativo, criado_em FROM usuarios WHERE conta_id = ? ORDER BY perfil, nome', contaId); }

  definirAtivo(id, ativo) {
    const u = this.usuario(id);
    if (!u) throw new Error('Usuário não encontrado.');
    if (u.perfil !== 'usuario') throw new Error('Só usuários convidados podem ser desativados aqui.');
    if (ativo) this._conferirVaga(u.conta_id);
    this._exec('UPDATE usuarios SET ativo = ? WHERE id = ?', ativo ? 1 : 0, id);
  }

  // ---------- Convites ----------
  _conferirVaga(contaId) {
    const conta = this.conta(contaId);
    const ativos = this._um('SELECT COUNT(*) AS n FROM usuarios WHERE conta_id = ? AND ativo = 1', contaId).n;
    if (ativos >= conta.limite_usuarios) throw new Error(`O plano permite ${conta.limite_usuarios} usuário(s). Desative alguém ou peça a ampliação do limite.`);
  }

  /** Gera uma chave de convite de uso único. O texto da chave só existe na resposta. */
  criarConvite(contaId, chave) {
    this._exec('DELETE FROM convites WHERE expira_em <= ?', agoraIso());
    this._conferirVaga(contaId);
    const codigo = crypto.randomBytes(15).toString('base64url').toUpperCase().replace(/[-_]/g, 'X').match(/.{5}/g).join('-');
    const sal = crypto.randomBytes(16);
    const { verificador, kek } = derivar(codigo, sal);
    const expira = new Date(Date.now() + DIAS_CONVITE * DIA).toISOString();
    this._exec('INSERT INTO convites (conta_id, codigo_hash, sal, chave_cifrada, criado_em, expira_em) VALUES (?, ?, ?, ?, ?, ?)',
      contaId, verificador, sal, cifrar(kek, chave), agoraIso(), expira);
    return { chave: codigo, expiraEm: expira };
  }

  convitesPendentes(contaId) {
    return this._um('SELECT COUNT(*) AS n FROM convites WHERE conta_id = ? AND expira_em > ?', contaId, agoraIso()).n;
  }

  /** Cadastro com chave de convite: o usuário passa a usar a conta de quem gerou a chave. */
  usarConvite(dados) {
    const codigo = String(dados.chave ?? '').trim().toUpperCase();
    let achado = null;
    let chave = null;
    for (const c of this._todos('SELECT * FROM convites WHERE expira_em > ?', agoraIso())) {
      const { verificador, kek } = derivar(codigo, c.sal);
      if (iguais(verificador, Buffer.from(c.codigo_hash))) { achado = c; chave = decifrar(kek, Buffer.from(c.chave_cifrada)); break; }
    }
    if (!achado) throw new Error('Chave de convite inválida ou vencida.');
    const v = this._validar(dados);
    this._conferirVaga(achado.conta_id);
    this._inserir({ ...v, senha: dados.senha, perfil: 'usuario', contaId: achado.conta_id }, chave);
    this._exec('DELETE FROM convites WHERE id = ?', achado.id);
    return this.autenticar(v.usuario, dados.senha);
  }

  // ---------- Contas, mensalidades e uso ----------
  _usoNoMes(contaId) {
    const inicio = new Date();
    inicio.setUTCDate(1); inicio.setUTCHours(0, 0, 0, 0);
    return this._um('SELECT COUNT(*) AS n FROM emissoes WHERE conta_id = ? AND criado_em >= ?', contaId, inicio.toISOString()).n;
  }

  conta(id) {
    const c = this._um('SELECT * FROM contas WHERE id = ?', id);
    if (!c) return null;
    const vencida = c.vence_em <= agoraIso();
    return {
      ...c,
      vencida,
      situacao: c.status === 'suspensa' ? 'suspensa' : vencida ? 'vencida' : 'em dia',
      usuarios_ativos: this._um('SELECT COUNT(*) AS n FROM usuarios WHERE conta_id = ? AND ativo = 1', id).n,
      certidoes_no_mes: this._usoNoMes(id),
    };
  }

  contas() { return this._todos('SELECT id FROM contas ORDER BY nome').map((r) => this.conta(r.id)); }
  pagamentos(contaId) { return this._todos('SELECT id, valor_centavos, registrado_em FROM pagamentos WHERE conta_id = ? ORDER BY registrado_em DESC', contaId); }

  /** Lança erro com o motivo se a conta não pode emitir `quantas` certidões agora. */
  conferirEmissao(contaId, quantas) {
    const c = this.conta(contaId);
    if (c.status === 'suspensa') throw new Error('Conta suspensa. Fale com o responsável pelo sistema.');
    if (c.vencida) throw new Error('Mensalidade vencida. Regularize o pagamento para voltar a emitir.');
    if (c.certidoes_no_mes + quantas > c.limite_certidoes_mes) {
      throw new Error(`Limite mensal de ${c.limite_certidoes_mes} certidões atingido (${c.certidoes_no_mes} já emitidas neste mês).`);
    }
  }

  /** Dono: altera valor, limites, situação e vencimento de uma conta. */
  alterarConta(id, e) {
    const c = this._um('SELECT * FROM contas WHERE id = ?', id);
    if (!c) throw new Error('Conta não encontrada.');
    const vence = e.vence_em === undefined ? c.vence_em : new Date(e.vence_em);
    if (vence instanceof Date && Number.isNaN(vence.getTime())) throw new Error('Data de vencimento inválida.');
    this._exec('UPDATE contas SET valor_mensal_centavos = ?, limite_usuarios = ?, limite_certidoes_mes = ?, status = ?, vence_em = ? WHERE id = ?',
      e.valor_mensal_centavos === undefined ? c.valor_mensal_centavos : inteiro(e.valor_mensal_centavos, 0, 100000000, 'Valor da mensalidade'),
      e.limite_usuarios === undefined ? c.limite_usuarios : inteiro(e.limite_usuarios, 1, 10000, 'Limite de usuários'),
      e.limite_certidoes_mes === undefined ? c.limite_certidoes_mes : inteiro(e.limite_certidoes_mes, 0, 10000000, 'Limite de certidões por mês'),
      e.status === undefined ? c.status : (e.status === 'suspensa' ? 'suspensa' : 'ativa'),
      vence instanceof Date ? vence.toISOString() : vence, id);
    return this.conta(id);
  }

  /** Dono: registra uma mensalidade paga e empurra o vencimento em um mês. */
  registrarPagamento(id, valorCentavos) {
    const c = this._um('SELECT * FROM contas WHERE id = ?', id);
    if (!c) throw new Error('Conta não encontrada.');
    const valor = valorCentavos === undefined ? c.valor_mensal_centavos : inteiro(valorCentavos, 0, 100000000, 'Valor pago');
    // Conta em dia: soma ao vencimento atual. Vencida: o mês conta a partir de hoje.
    const base = new Date(Math.max(Date.now(), new Date(c.vence_em).getTime()));
    base.setUTCMonth(base.getUTCMonth() + 1);
    this._exec('INSERT INTO pagamentos (conta_id, valor_centavos, registrado_em) VALUES (?, ?, ?)', id, valor, agoraIso());
    this._exec('UPDATE contas SET vence_em = ? WHERE id = ?', base.toISOString(), id);
    return this.conta(id);
  }

  /** Dono: visão geral. Não inclui nada sobre os pesquisados nem as certidões. */
  resumo() {
    const contas = this.contas();
    const mes = agoraIso().slice(0, 7);
    return {
      config: this.config(),
      totais: {
        contas: contas.length,
        em_dia: contas.filter((c) => c.situacao === 'em dia').length,
        vencidas: contas.filter((c) => c.situacao === 'vencida').length,
        suspensas: contas.filter((c) => c.situacao === 'suspensa').length,
        usuarios: contas.reduce((s, c) => s + c.usuarios_ativos, 0),
        certidoes_no_mes: contas.reduce((s, c) => s + c.certidoes_no_mes, 0),
        receita_mensal_prevista_centavos: contas.filter((c) => c.situacao === 'em dia').reduce((s, c) => s + c.valor_mensal_centavos, 0),
        recebido_no_mes_centavos: this._um('SELECT COALESCE(SUM(valor_centavos), 0) AS n FROM pagamentos WHERE substr(registrado_em, 1, 7) = ?', mes).n,
      },
      contas: contas.map((c) => ({ ...c, usuarios: this.usuariosDaConta(c.id), pagamentos: this.pagamentos(c.id) })),
    };
  }

  // ---------- Certidões guardadas ----------
  _caminho(id) { return path.join(this.dirArquivos, id + '.enc'); }

  guardarArquivo({ contaId, usuarioId, orgao, certidao, nomeArquivo, mime, origem, conteudo }, chave) {
    const id = crypto.randomUUID();
    const agora = Date.now();
    fs.writeFileSync(this._caminho(id), cifrar(chave, conteudo), { mode: 0o600 });
    this._exec('INSERT INTO arquivos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, contaId, usuarioId, orgao, certidao, nomeArquivo, mime, origem, conteudo.length,
      crypto.createHash('sha256').update(conteudo).digest('hex'),
      new Date(agora).toISOString(), new Date(agora + DIAS_RETENCAO * DIA).toISOString());
    this._exec('INSERT INTO emissoes (conta_id, usuario_id, orgao, criado_em) VALUES (?, ?, ?, ?)', contaId, usuarioId, orgao, new Date(agora).toISOString());
    return id;
  }

  /** Arquivos do usuário; o administrador vê os de toda a conta. */
  arquivos(usuario) {
    this.limparVencidos();
    const sql = 'SELECT a.*, u.nome AS dono FROM arquivos a JOIN usuarios u ON u.id = a.usuario_id WHERE a.conta_id = ?';
    return usuario.perfil === 'admin'
      ? this._todos(sql + ' ORDER BY a.criado_em DESC', usuario.conta_id)
      : this._todos(sql + ' AND a.usuario_id = ? ORDER BY a.criado_em DESC', usuario.conta_id, usuario.id);
  }

  arquivo(id, usuario) {
    const a = this._um('SELECT * FROM arquivos WHERE id = ?', id);
    if (!a || a.conta_id !== usuario.conta_id || (usuario.perfil !== 'admin' && a.usuario_id !== usuario.id)) return null;
    if (a.expira_em <= agoraIso()) { this.apagarArquivo(id); return null; }
    return a;
  }

  lerArquivo(id, chave) { return decifrar(chave, fs.readFileSync(this._caminho(id))); }

  apagarArquivo(id) {
    fs.rmSync(this._caminho(id), { force: true });
    this._exec('DELETE FROM arquivos WHERE id = ?', id);
  }

  /** Apaga do disco e do banco tudo que passou do prazo de retenção. */
  limparVencidos(agora = new Date()) {
    const vencidos = this._todos('SELECT id FROM arquivos WHERE expira_em <= ?', agora.toISOString());
    for (const { id } of vencidos) this.apagarArquivo(id);
    // Arquivos sem registro no banco (ex.: de uma versão anterior) também respeitam o prazo.
    for (const nome of fs.readdirSync(this.dirArquivos)) {
      const caminho = path.join(this.dirArquivos, nome);
      const id = nome.replace(/\.enc$/, '');
      if (agora.getTime() - fs.statSync(caminho).mtimeMs > DIAS_RETENCAO * DIA && !this._um('SELECT 1 AS x FROM arquivos WHERE id = ?', id)) fs.rmSync(caminho, { force: true });
    }
    return vencidos.length;
  }
}

module.exports = { Banco, DIAS_RETENCAO };
