'use strict';
// Servidor web local. Escuta somente em 127.0.0.1; nenhum dado sai da máquina
// além das requisições feitas pelo navegador aos portais oficiais.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Cofre } = require('./src/cofre');
const { Catalogo } = require('./src/catalogo');
const { Pedidos } = require('./src/pedidos');
const { normalizarPessoa } = require('./src/validacao');

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function criarServidor({ dirDados, porta, automacao = {}, catalogoPadrao } = {}) {
  const cofre = new Cofre(dirDados);
  const catalogo = new Catalogo(dirDados, catalogoPadrao);
  const pedidos = new Pedidos(cofre, automacao);
  const dirPublico = path.join(__dirname, 'public');
  let sessao = null;
  let falhas = 0;

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
  const autenticado = (req) => {
    const t = String(req.headers['x-sessao'] || '');
    return Boolean(sessao) && t.length === sessao.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(sessao));
  };
  const visao = (p) => ({ ...p, certidao: { id: p.certidao.id, orgao: p.certidao.orgao, nome: p.certidao.nome, url: p.certidao.url, rotulo: p.certidao.rotulo }, arquivo: p.arquivo && { ...p.arquivo, caminho: undefined } });

  function bloquear() {
    pedidos.interromper();
    pedidos.lista = [];
    cofre.fechar();
    sessao = null;
  }

  async function api(req, res, rota) {
    const m = req.method;
    if (rota === '/api/estado' && m === 'GET') return json(res, 200, { configurado: cofre.configurado, aberto: cofre.aberto && autenticado(req) });

    if (rota === '/api/desbloquear' && m === 'POST') {
      const { senha } = await lerCorpo(req);
      await new Promise((r) => setTimeout(r, Math.min(falhas, 10) * 500)); // freia tentativa e erro
      if (!cofre.configurado) cofre.criar(senha);
      else if (!cofre.aberto && !cofre.abrir(senha)) { falhas++; return json(res, 401, { erro: 'Senha mestra incorreta.' }); }
      else if (cofre.aberto) {
        // Já aberto (outra aba): a senha ainda precisa conferir.
        const teste = new Cofre(dirDados);
        if (!teste.abrir(senha)) { falhas++; return json(res, 401, { erro: 'Senha mestra incorreta.' }); }
        teste.fechar();
      }
      falhas = 0;
      if (!sessao) { sessao = crypto.randomBytes(32).toString('hex'); pedidos.carregar(); }
      return json(res, 200, { sessao });
    }

    if (!autenticado(req)) return json(res, 401, { erro: 'Cofre bloqueado.' });

    if (rota === '/api/bloquear' && m === 'POST') { bloquear(); return json(res, 200, {}); }

    if (rota === '/api/catalogo' && m === 'GET') return json(res, 200, catalogo.listar());
    if (rota === '/api/catalogo' && m === 'POST') return json(res, 201, catalogo.adicionar(await lerCorpo(req)));
    let r = rota.match(/^\/api\/catalogo\/([\w-]+)$/);
    if (r && m === 'DELETE') return catalogo.remover(r[1]) ? json(res, 200, {}) : json(res, 404, { erro: 'Portal não encontrado.' });

    if (rota === '/api/pedidos' && m === 'GET') return json(res, 200, pedidos.lista.map(visao));
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
      return json(res, 201, pedidos.criar(pessoa, itens).map(visao));
    }
    r = rota.match(/^\/api\/pedidos\/([\w-]+)(?:\/(cancelar|capturar|arquivo))?$/);
    if (r) {
      const [, id, acao] = r;
      if (!pedidos.obter(id)) return json(res, 404, { erro: 'Pedido não encontrado.' });
      if (!acao && m === 'DELETE') { pedidos.excluir(id); return json(res, 200, {}); }
      if (acao === 'cancelar' && m === 'POST') { pedidos.cancelar(id); return json(res, 200, {}); }
      if (acao === 'capturar' && m === 'POST') { await pedidos.capturar(id); return json(res, 200, {}); }
      if (acao === 'arquivo' && m === 'GET') {
        const a = pedidos.lerArquivo(id);
        if (!a) return json(res, 404, { erro: 'Este pedido não tem arquivo.' });
        res.writeHead(200, { 'Content-Type': a.pedido.arquivo.mime, 'Content-Length': a.conteudo.length, 'Cache-Control': 'no-store' });
        return res.end(a.conteudo);
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

  return {
    servidor, pedidos, cofre, bloquear,
    iniciar: () => new Promise((resolve) => servidor.listen(porta ?? 8787, '127.0.0.1', () => resolve(servidor.address().port))),
    parar: () => new Promise((resolve) => { bloquear(); servidor.close(resolve); servidor.closeAllConnections(); }),
  };
}

if (require.main === module) {
  const app = criarServidor({
    dirDados: process.env.CERTIDOES_DADOS || path.join(__dirname, 'dados'),
    porta: Number(process.env.PORTA) || 8787,
    automacao: { headless: process.env.CERTIDOES_HEADLESS === '1' },
  });
  app.iniciar().then((porta) => {
    console.log(`Emissor de certidões em http://127.0.0.1:${porta}  (Ctrl+C para encerrar)`);
  });
  const sair = () => app.parar().then(() => process.exit(0));
  process.on('SIGINT', sair);
  process.on('SIGTERM', sair);
}

module.exports = { criarServidor };
