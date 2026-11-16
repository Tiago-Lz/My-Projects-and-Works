'use strict';
// Servidor web local. Escuta somente em 127.0.0.1; nenhum dado sai da máquina
// além das requisições feitas pelo navegador aos portais oficiais.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Banco, DIAS_RETENCAO } = require('./src/banco');
const { Catalogo } = require('./src/catalogo');
const { Pedidos } = require('./src/pedidos');
const { normalizarPessoa } = require('./src/validacao');

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const OCIOSO_MS = 30 * 60 * 1000;

function criarServidor({ dirDados, dirRecursos = __dirname, porta, automacao = {}, catalogoPadrao } = {}) {
  const banco = new Banco(dirDados);
  const catalogo = new Catalogo(dirDados, catalogoPadrao || path.join(dirRecursos, 'catalogo.json'));
  const pedidos = new Pedidos(banco, automacao);
  const dirPublico = path.join(dirRecursos, 'public');
  const sessoes = new Map(); // token -> { usuario, chave, visto }
  const falhas = new Map(); // login -> tentativas erradas seguidas

  const json = (res, status, corpo) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(corpo));
  };
  const lerCorpo = (req) => new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (p) => { dados += p; if (dados.length > 1e5) { reject(new Error('Requisição grande demais.')); req.destroy(); } });
    req.on('end', () => { try { resolve(dados ? JSON.parse(dados) : {}); } catch { reject(new Error('JSON inválido.')); } });
    req.on('error', reject);
  });

  function encerrarSessao(token) {
    const s = sessoes.get(token);
    if (!s) return;
    sessoes.delete(token);
    // Sem outra sessão do mesmo usuário, os pedidos dele (e os dados neles) são descartados.
    if (![...sessoes.values()].some((x) => x.usuario.id === s.usuario.id)) pedidos.esquecer(s.usuario.id);
    if (s.chave) s.chave.fill(0);
  }
  function abrirSessao({ usuario, chave }) {
    const token = crypto.randomBytes(32).toString('hex');
    sessoes.set(token, { usuario, chave, visto: Date.now() });
    return { sessao: token, usuario };
  }
  function sessaoDe(req) {
    const token = String(req.headers['x-sessao'] || '');
    const s = sessoes.get(token);
    if (!s) return null;
    // Com pedido em andamento a sessão não expira: o operador está na janela do portal.
    const ocupado = pedidos.doDono(s.usuario.id).some((p) => p.status === 'fila' || p.status === 'executando');
    if (!ocupado && Date.now() - s.visto > OCIOSO_MS) { encerrarSessao(token); return null; }
    s.visto = Date.now();
    return { ...s, token };
  }

  const visaoPedido = (p) => ({ id: p.id, criadoEm: p.criadoEm, orgao: p.certidao.orgao, certidao: p.certidao.nome, pessoa: p.rotuloPessoa, status: p.status, mensagem: p.mensagem, arquivoId: p.arquivoId });
  const visaoArquivo = (a) => ({ id: a.id, orgao: a.orgao, certidao: a.certidao, nomeArquivo: a.nome_arquivo, origem: a.origem, tamanho: a.tamanho, sha256: a.sha256, criadoEm: a.criado_em, expiraEm: a.expira_em, dono: a.dono });

  async function entrar(res, corpo, autenticar) {
    const login = String(corpo.usuario ?? '').trim().toLowerCase();
    const n = falhas.get(login) || 0;
    await new Promise((r) => setTimeout(r, Math.min(n, 10) * 500)); // freia tentativa e erro
    const r = autenticar();
    if (!r) { falhas.set(login, n + 1); return json(res, 401, { erro: 'Usuário ou senha incorretos.' }); }
    falhas.delete(login);
    return json(res, 200, abrirSessao(r));
  }

  async function api(req, res, rota) {
    const m = req.method;
    const s = sessaoDe(req);

    if (rota === '/api/estado' && m === 'GET') return json(res, 200, { configurado: banco.temDono(), usuario: s ? s.usuario : null, diasRetencao: DIAS_RETENCAO });
    // Três portas de entrada: o dono (uma única vez), o escritório pagante e o convidado.
    if (rota === '/api/configurar' && m === 'POST') return json(res, 201, abrirSessao(banco.criarDono(await lerCorpo(req))));
    if (rota === '/api/contas' && m === 'POST') {
      if (!banco.temDono()) throw new Error('O sistema ainda não foi configurado pelo responsável.');
      return json(res, 201, abrirSessao(banco.criarConta(await lerCorpo(req))));
    }
    if (rota === '/api/convites/usar' && m === 'POST') {
      const corpo = await lerCorpo(req);
      const ip = 'convite';
      const n = falhas.get(ip) || 0;
      await new Promise((r) => setTimeout(r, Math.min(n, 10) * 500)); // freia a adivinhação de chaves
      try { const r = banco.usarConvite(corpo); falhas.delete(ip); return json(res, 201, abrirSessao(r)); } catch (e) { if (/convite/.test(e.message)) falhas.set(ip, n + 1); throw e; }
    }
    if (rota === '/api/entrar' && m === 'POST') {
      const corpo = await lerCorpo(req);
      return entrar(res, corpo, () => banco.autenticar(corpo.usuario, corpo.senha));
    }

    if (!s) return json(res, 401, { erro: 'Faça login.' });
    const eu = s.usuario;

    if (rota === '/api/sair' && m === 'POST') { encerrarSessao(s.token); return json(res, 200, {}); }
    if (rota === '/api/senha' && m === 'POST') {
      const { atual, nova } = await lerCorpo(req);
      if (!banco.autenticar(eu.usuario, atual)) return json(res, 401, { erro: 'Senha atual incorreta.' });
      banco.definirSenha(eu.id, nova, s.chave);
      return json(res, 200, {});
    }

    // ---------- Dono do sistema: contas, preços, limites e mensalidades ----------
    if (rota.startsWith('/api/dono')) {
      if (eu.perfil !== 'dono') return json(res, 403, { erro: 'Área restrita ao responsável pelo sistema.' });
      if (rota === '/api/dono/resumo' && m === 'GET') return json(res, 200, banco.resumo());
      if (rota === '/api/dono/config' && m === 'POST') return json(res, 200, banco.definirConfig(await lerCorpo(req)));
      const d = rota.match(/^\/api\/dono\/contas\/(\d+)(\/pagamentos)?$/);
      if (d && m === 'POST') {
        const corpo = await lerCorpo(req);
        return json(res, 200, d[2] ? banco.registrarPagamento(Number(d[1]), corpo.valor_centavos) : banco.alterarConta(Number(d[1]), corpo));
      }
      return json(res, 404, { erro: 'Rota não encontrada.' });
    }
    // Daqui em diante é uso do sistema, que o dono não faz (ele não tem conta nem chave de dados).
    if (eu.perfil === 'dono') return json(res, 403, { erro: 'O responsável pelo sistema não emite certidões.' });

    // ---------- Conta do escritório ----------
    if (rota === '/api/conta' && m === 'GET') {
      const conta = banco.conta(eu.conta_id);
      const base = { nome: conta.nome, situacao: conta.situacao, vence_em: conta.vence_em, limite_certidoes_mes: conta.limite_certidoes_mes, certidoes_no_mes: conta.certidoes_no_mes };
      if (eu.perfil !== 'admin') return json(res, 200, base);
      return json(res, 200, { ...base, valor_mensal_centavos: conta.valor_mensal_centavos, limite_usuarios: conta.limite_usuarios, usuarios_ativos: conta.usuarios_ativos,
        convites_pendentes: banco.convitesPendentes(conta.id), usuarios: banco.usuariosDaConta(conta.id), pagamentos: banco.pagamentos(conta.id) });
    }
    if (rota.startsWith('/api/conta/')) {
      if (eu.perfil !== 'admin') return json(res, 403, { erro: 'Apenas o administrador da conta faz isso.' });
      if (rota === '/api/conta/convites' && m === 'POST') return json(res, 201, banco.criarConvite(eu.conta_id, s.chave));
      const u = rota.match(/^\/api\/conta\/usuarios\/(\d+)\/(senha|ativo)$/);
      if (u && m === 'POST') {
        const alvo = banco.usuario(Number(u[1]));
        if (!alvo || alvo.conta_id !== eu.conta_id) return json(res, 404, { erro: 'Usuário não encontrado.' });
        const corpo = await lerCorpo(req);
        if (u[2] === 'senha') banco.definirSenha(alvo.id, corpo.senha, s.chave);
        else banco.definirAtivo(alvo.id, Boolean(corpo.ativo));
        // Senha redefinida ou conta desativada: derruba as sessões abertas desse usuário.
        if (u[2] === 'senha' || !corpo.ativo) for (const [t, x] of sessoes) if (x.usuario.id === alvo.id && t !== s.token) encerrarSessao(t);
        return json(res, 200, {});
      }
      return json(res, 404, { erro: 'Rota não encontrada.' });
    }

    // ---------- Catálogo ----------
    if (rota === '/api/catalogo' && m === 'GET') return json(res, 200, catalogo.listar());
    if (rota === '/api/catalogo' && m === 'POST') return json(res, 201, catalogo.adicionar(await lerCorpo(req)));
    let r = rota.match(/^\/api\/catalogo\/([\w-]+)$/);
    if (r && m === 'DELETE') return catalogo.remover(r[1]) ? json(res, 200, {}) : json(res, 404, { erro: 'Portal não encontrado.' });

    // ---------- Pedidos (em memória) ----------
    if (rota === '/api/pedidos' && m === 'GET') return json(res, 200, pedidos.doDono(eu.id).map(visaoPedido));
    if (rota === '/api/pedidos' && m === 'POST') {
      const corpo = await lerCorpo(req);
      const pessoa = normalizarPessoa(corpo.pessoa);
      const ids = [...new Set(Array.isArray(corpo.certidoes) ? corpo.certidoes : [])];
      if (!ids.length) throw new Error('Selecione ao menos uma certidão.');
      const itens = ids.map((id) => {
        const c = catalogo.obter(id);
        if (!c) throw new Error('Certidão desconhecida no catálogo.');
        if (!c.pessoas.includes(pessoa.tipo)) throw new Error(`${c.orgao}: certidão indisponível para ${pessoa.tipo === 'PF' ? 'pessoa física' : 'pessoa jurídica'}.`);
        return c;
      });
      const naFila = pedidos.lista.filter((p) => p.conta === eu.conta_id && (p.status === 'fila' || p.status === 'executando')).length;
      banco.conferirEmissao(eu.conta_id, itens.length + naFila);
      return json(res, 201, pedidos.criar(eu, Buffer.from(s.chave), pessoa, itens).map(visaoPedido));
    }
    r = rota.match(/^\/api\/pedidos\/([\w-]+)(?:\/(cancelar|capturar))?$/);
    if (r) {
      const p = pedidos.obter(r[1], eu.id);
      if (!p) return json(res, 404, { erro: 'Pedido não encontrado.' });
      if (!r[2] && m === 'DELETE') { pedidos.remover(p); return json(res, 200, {}); }
      if (r[2] === 'cancelar' && m === 'POST') { pedidos.cancelar(p); return json(res, 200, {}); }
      if (r[2] === 'capturar' && m === 'POST') { await pedidos.capturar(p); return json(res, 200, {}); }
    }

    // ---------- Certidões guardadas ----------
    if (rota === '/api/arquivos' && m === 'GET') return json(res, 200, banco.arquivos(eu).map(visaoArquivo));
    r = rota.match(/^\/api\/arquivos\/([\w-]+)$/);
    if (r) {
      const a = banco.arquivo(r[1], eu);
      if (!a) return json(res, 404, { erro: 'Arquivo não encontrado ou já expirado.' });
      if (m === 'DELETE') { banco.apagarArquivo(a.id); return json(res, 200, {}); }
      if (m === 'GET') {
        const conteudo = banco.lerArquivo(a.id, s.chave);
        res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': conteudo.length, 'Cache-Control': 'no-store' });
        return res.end(conteudo);
      }
    }
    return json(res, 404, { erro: 'Rota não encontrada.' });
  }

  const servidor = http.createServer(async (req, res) => {
    // Só atende a quem chama pelo endereço local (bloqueia DNS rebinding e outras origens).
    const { port } = servidor.address();
    const locais = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origem = req.headers.origin;
    if (!locais.includes(req.headers.host) || (origem && !locais.some((h) => origem === `http://${h}`))) {
      res.writeHead(403); return res.end();
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'");
    const rota = new URL(req.url, 'http://local').pathname;
    try {
      if (rota.startsWith('/api/')) return await api(req, res, rota);
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      const nome = rota === '/' ? 'index.html' : path.basename(rota);
      const arquivo = path.join(dirPublico, nome);
      if (!TIPOS[path.extname(nome)] || !fs.existsSync(arquivo)) { res.writeHead(404); return res.end('Não encontrado'); }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(nome)], 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(arquivo));
    } catch (erro) {
      if (!res.headersSent) json(res, 400, { erro: erro.message });
      else res.end();
    }
  });

  // Retenção: confere na partida e de hora em hora.
  banco.limparVencidos();
  const faxina = setInterval(() => banco.limparVencidos(), 60 * 60 * 1000);
  faxina.unref();

  const ouvir = (p) => new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(p, '127.0.0.1', () => { servidor.removeListener('error', reject); resolve(servidor.address().port); });
  });

  return {
    servidor, pedidos, banco,
    /** Com `porta` ocupada, tenta as dez seguintes. */
    async iniciar() {
      const base = porta ?? 8787;
      for (let i = 0; ; i++) {
        try { return await ouvir(base === 0 ? 0 : base + i); } catch (e) { if (e.code !== 'EADDRINUSE' || i >= 10) throw e; }
      }
    },
    parar: () => new Promise((resolve) => {
      clearInterval(faxina);
      for (const t of [...sessoes.keys()]) encerrarSessao(t);
      pedidos.esquecer();
      servidor.close(() => { banco.fechar(); resolve(); });
      servidor.closeAllConnections();
    }),
  };
}

function abrirNoNavegador(url) {
  const { spawn } = require('node:child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* o endereço já está no console */ }
}

function principal() {
  let empacotado = false;
  try { empacotado = require('node:sea').isSea(); } catch { /* Node sem suporte a SEA */ }
  // Empacotado: recursos ao lado do .exe e dados na pasta do usuário.
  const dirRecursos = empacotado ? path.join(path.dirname(process.execPath), 'recursos') : __dirname;
  const dirDados = process.env.CERTIDOES_DADOS
    || (empacotado ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'EmissorCertidoes') : path.join(__dirname, 'dados'));
  const app = criarServidor({
    dirDados, dirRecursos,
    porta: Number(process.env.PORTA) || 8787,
    automacao: { headless: process.env.CERTIDOES_HEADLESS === '1' },
  });
  app.iniciar().then((porta) => {
    const url = `http://127.0.0.1:${porta}`;
    console.log(`Emissor de Certidões em ${url}`);
    console.log('Mantenha esta janela aberta enquanto usa o sistema. Feche-a (ou Ctrl+C) para encerrar.');
    if (empacotado || process.env.CERTIDOES_ABRIR === '1') abrirNoNavegador(url);
  }).catch((e) => {
    console.error('Não foi possível iniciar: ' + e.message);
    if (empacotado) setTimeout(() => process.exit(1), 15000); else process.exit(1);
  });
  const sair = () => app.parar().then(() => process.exit(0));
  process.on('SIGINT', sair);
  process.on('SIGTERM', sair);
}

let ehEntrada = require.main === module;
try { ehEntrada = ehEntrada || require('node:sea').isSea(); } catch { /* Node sem suporte a SEA */ }
if (ehEntrada) principal();

module.exports = { criarServidor };
