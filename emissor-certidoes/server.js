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
const email = require('./src/email');

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const OCIOSO_MS = 30 * 60 * 1000;

function criarServidor({ dirDados, dirRecursos = __dirname, porta, automacao = {}, catalogoPadrao, enviarCodigo } = {}) {
  const banco = new Banco(dirDados);
  const enviar = enviarCodigo || email.criarEnviador(banco);
  const cadastros = new Map(); // id -> cadastro em andamento (só em memória, expira em 30 min)
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

    if (rota === '/api/estado' && m === 'GET') return json(res, 200, { usuario: s ? s.usuario : null, diasRetencao: DIAS_RETENCAO });

    // ---------- Cadastro em etapas: tipo → dados → código no e-mail → senha ----------
    if (rota.startsWith('/api/cadastro/') && m === 'POST') {
      const corpo = await lerCorpo(req);
      const agora = Date.now();
      for (const [id, c] of cadastros) if (c.expira < agora) cadastros.delete(id);
      const hashCodigo = (id, codigo) => crypto.createHash('sha256').update(id + ':' + String(codigo).trim()).digest();
      const novoCodigo = async (id, c) => {
        if (c.envios >= 5) throw new Error('Limite de reenvios atingido. Recomece o cadastro.');
        const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        c.codigo = hashCodigo(id, codigo);
        c.codigoExpira = Date.now() + 10 * 60 * 1000;
        c.tentativas = 0;
        c.envios++;
        c.ultimoEnvio = Date.now();
        try { c.modoEnvio = (await enviar({ para: c.dados.email, nome: c.dados.nome, codigo })).modo; } catch (e) {
          throw new Error('Não foi possível enviar o e-mail de verificação. Tente novamente em instantes.');
        }
      };
      const mascarar = (e) => e.replace(/^(.)(.*)(@.*)$/, (_, a, meio, dom) => a + '•'.repeat(Math.min(meio.length, 6)) + dom);
      const pegar = () => {
        const c = cadastros.get(String(corpo.id || ''));
        if (!c) throw new Error('Cadastro expirado. Recomece.');
        return c;
      };

      if (rota === '/api/cadastro/iniciar') {
        const tipo = corpo.tipo === 'convite' ? 'convite' : 'escritorio';
        const dados = banco.validarNovo(corpo);
        if (tipo === 'escritorio') {
          dados.escritorio = String(corpo.escritorio ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
          if (dados.escritorio.length < 2) throw new Error('Informe o nome do escritório.');
        } else {
          const n = falhas.get('convite') || 0;
          await new Promise((r) => setTimeout(r, Math.min(n, 10) * 500)); // freia a adivinhação de chaves
          try { dados.conta = banco.conferirConvite(corpo.chave).conta.nome; falhas.delete('convite'); } catch (e) { falhas.set('convite', n + 1); throw e; }
          dados.chave = String(corpo.chave).trim().toUpperCase();
        }
        const id = crypto.randomBytes(16).toString('hex');
        const c = { tipo, dados, envios: 0, verificado: false, expira: agora + 30 * 60 * 1000 };
        await novoCodigo(id, c);
        cadastros.set(id, c);
        return json(res, 201, { id, email: mascarar(dados.email), conta: dados.conta, modoEnvio: c.modoEnvio });
      }
      if (rota === '/api/cadastro/reenviar') {
        const c = pegar();
        if (Date.now() - c.ultimoEnvio < 30000) throw new Error('Aguarde alguns segundos para pedir outro código.');
        await novoCodigo(String(corpo.id), c);
        return json(res, 200, { modoEnvio: c.modoEnvio });
      }
      if (rota === '/api/cadastro/verificar') {
        const c = pegar();
        if (c.codigoExpira < Date.now()) throw new Error('Código vencido. Peça um novo.');
        if (c.tentativas >= 5) throw new Error('Muitas tentativas. Peça um novo código.');
        c.tentativas++;
        if (!crypto.timingSafeEqual(c.codigo, hashCodigo(String(corpo.id), corpo.codigo))) throw new Error('Código incorreto.');
        c.verificado = true;
        return json(res, 200, {});
      }
      if (rota === '/api/cadastro/concluir') {
        const c = pegar();
        if (!c.verificado) throw new Error('Confirme o código enviado ao e-mail.');
        const d = { ...c.dados, senha: corpo.senha };
        const r = c.tipo === 'escritorio' ? banco.criarConta(d) : banco.usarConvite(d);
        cadastros.delete(String(corpo.id));
        return json(res, 201, abrirSessao(r));
      }
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
      if (rota === '/api/dono/portais/verificar' && m === 'POST') {
        // Abre cada endereço a partir desta máquina e informa o que o portal respondeu.
        const lista = catalogo.listar();
        const resultado = [];
        let proximo = 0;
        const verificar = async (c) => {
          const ctrl = new AbortController();
          const relogio = setTimeout(() => ctrl.abort(), 15000);
          try {
            const r = await fetch(c.url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EmissorCertidoes/1.0', Accept: 'text/html,*/*' } });
            r.body?.cancel().catch(() => {});
            return { id: c.id, status: r.status, final: r.url !== c.url ? r.url : '', ok: r.status < 400 };
          } catch (e) {
            return { id: c.id, status: 0, final: '', ok: false, erro: e.name === 'AbortError' ? 'Sem resposta em 15 s' : (e.cause && e.cause.code) || e.message };
          } finally { clearTimeout(relogio); }
        };
        await Promise.all(Array.from({ length: 8 }, async () => { while (proximo < lista.length) { const c = lista[proximo++]; resultado.push(await verificar(c)); } }));
        return json(res, 200, resultado);
      }
      const ep = rota.match(/^\/api\/dono\/portais\/([\w-]+)$/);
      if (ep && m === 'POST') { catalogo.definirEndereco(ep[1], (await lerCorpo(req)).url); return json(res, 200, catalogo.obter(ep[1])); }
      if (rota === '/api/dono/email' && m === 'GET') {
        const t = banco.textos();
        return json(res, 200, { ...Object.fromEntries(email.CAMPOS.map((k) => [k, k === 'smtp_senha' ? '' : t[k] || ''])), senha_definida: Boolean(t.smtp_senha), configurado: email.configurado(t) });
      }
      if (rota === '/api/dono/email' && m === 'POST') {
        const corpo = await lerCorpo(req);
        const novo = Object.fromEntries(email.CAMPOS.filter((k) => k in corpo && !(k === 'smtp_senha' && corpo[k] === '')).map((k) => [k, String(corpo[k]).trim().slice(0, 200)]));
        banco.definirTextos(novo);
        return json(res, 200, {});
      }
      if (rota === '/api/dono/email/teste' && m === 'POST') {
        const { para } = await lerCorpo(req);
        const t = banco.textos();
        if (!email.configurado(t)) throw new Error('Preencha e salve o servidor SMTP e o remetente primeiro.');
        try { await email.enviarSmtp(t, { para, assunto: 'Teste do Emissor de Certidões', texto: 'O envio de e-mails está funcionando.' }); } catch (e) { throw new Error('Falha no envio: ' + e.message); }
        return json(res, 200, {});
      }
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
      const nome = path.extname(rota) ? path.basename(rota) : 'index.html';
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
