'use strict';
// O motor contra portais simulados: envio automático, espera pelo CAPTCHA e
// reconhecimento da certidão onde quer que ela apareça (outra aba, blob, HTML…).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Execucao } = require('../src/automacao');

const PDF = '%PDF-1.4\n% certidao de teste\n%%EOF\n';
const pessoa = { tipo: 'PF', nome: 'Maria da Silva', documento: '52998224725', nomeMae: '', nomePai: '', dataNascimento: '', rg: '', email: '' };
const html = (corpo) => `<!doctype html><meta charset="utf-8"><body>${corpo}</body>`;
const CAMPOS = '<label>Nome <input name="n"></label><label>CPF <input name="c"></label>';

async function rodar(rotas, extra = {}) {
  const posts = [];
  const srv = http.createServer((req, res) => {
    const rota = rotas[`${req.method} ${req.url.split('?')[0]}`];
    if (!rota) { res.writeHead(404); return res.end(); }
    let corpo = '';
    req.on('data', (p) => { corpo += p; });
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ em: Date.now(), ...Object.fromEntries(new URLSearchParams(corpo)) });
      const [tipo, texto] = typeof rota === 'function' ? rota() : rota;
      res.writeHead(200, { 'Content-Type': tipo });
      res.end(texto);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const inicio = Date.now();
  const exec = new Execucao({
    certidao: { url: `http://127.0.0.1:${srv.address().port}/`, ...extra },
    pessoa, opcoes: { headless: process.env.TESTE_JANELA !== '1', intervaloMs: 150, tempoLimiteMs: Number(process.env.LIMITE_TESTE) || 12000 },
  });
  try { return { r: await exec.executar(), posts, inicio }; } finally { srv.close(); srv.closeAllConnections(); }
}

test('envia sozinho e reconhece o PDF aberto em outra aba', { timeout: 90000 }, async () => {
  const { r, posts } = await rodar({
    'GET /': ['text/html', html(`<form method="post" action="/emitir" target="_blank">${CAMPOS}<button type="button">Limpar</button><button>Emitir certidão</button></form>`)],
    'POST /emitir': ['application/pdf', PDF],
  });
  assert.equal(r.status, 'concluido', r.mensagem);
  assert.equal(r.arquivo.origem, 'portal-oficial');
  assert.deepEqual([posts[0].n, posts[0].c], ['Maria da Silva', '529.982.247-25']);
  assert.equal(posts.length, 1, 'o pedido não pode ser repetido no portal');
});

test('espera o reCAPTCHA ser resolvido antes de enviar', { timeout: 90000 }, async () => {
  // O "widget" se resolve sozinho após 1,2 s, como se o operador tivesse clicado.
  const { r, posts, inicio } = await rodar({
    'GET /': ['text/html', html(`<form method="post" action="/emitir">${CAMPOS}
      <iframe src="/recaptcha/api2/anchor" width="300" height="80"></iframe>
      <textarea name="g-recaptcha-response" style="display:none"></textarea>
      <input type="submit" value="Consultar"></form>
      <script>setTimeout(() => { document.querySelector('textarea').value = 'token-resolvido'; }, 1200)</script>`)],
    'GET /recaptcha/api2/anchor': ['text/html', html('não sou um robô')],
    'POST /emitir': ['application/pdf', PDF],
  });
  assert.equal(r.status, 'concluido', r.mensagem);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]['g-recaptcha-response'], 'token-resolvido');
  assert.ok(posts[0].em - inicio >= 1200, 'não pode enviar antes do CAPTCHA');
});

test('CAPTCHA de imagem: envia quando o operador termina de digitar', { timeout: 90000 }, async () => {
  const { r, posts } = await rodar({
    'GET /': ['text/html', html(`<form method="post" action="/emitir">${CAMPOS}
      <label>Digite os caracteres da imagem <input name="cap"></label><button>Pesquisar</button></form>
      <script>setTimeout(() => { document.querySelector('[name=cap]').value = 'x7k2p'; }, 900)</script>`)],
    'POST /emitir': ['application/pdf', PDF],
  });
  assert.equal(r.status, 'concluido', r.mensagem);
  assert.equal(posts[0].cap, 'x7k2p');
});

test('PDF gerado no navegador (blob) em nova aba', { timeout: 90000 }, async () => {
  const { r } = await rodar({
    'GET /': ['text/html', html(`<form id="f">${CAMPOS}<button>Gerar</button></form>
      <script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault();
        window.open(URL.createObjectURL(new Blob([${JSON.stringify(PDF)}], { type: 'application/pdf' }))); });</script>`)],
  });
  assert.equal(r.status, 'concluido', r.mensagem);
  assert.equal(r.arquivo.origem, 'portal-oficial');
  assert.ok(r.arquivo.conteudo.toString().includes('certidao de teste'));
});

test('resultado com link "Baixar certidão" em etapa seguinte', { timeout: 90000 }, async () => {
  const { r } = await rodar({
    'GET /': ['text/html', html(`<form method="post" action="/resultado">${CAMPOS}<button>Solicitar</button></form>`)],
    'POST /resultado': ['text/html', html('<p>Pedido registrado.</p><a href="/doc" target="_blank">Baixar certidão</a>')],
    'GET /doc': ['application/pdf', PDF],
  });
  assert.equal(r.status, 'concluido', r.mensagem);
  assert.equal(r.arquivo.origem, 'portal-oficial');
});

test('certidão exibida em HTML é salva em PDF; página de erro não', { timeout: 90000 }, async () => {
  const ok = await rodar({
    'GET /': ['text/html', html(`<form method="post" action="/emitir">${CAMPOS}<button>Emitir</button></form>`)],
    'POST /emitir': ['text/html', html(`<h1>CERTIDÃO NEGATIVA</h1><p>${'Certifico que, revendo os registros de distribuição, NADA CONSTA em nome de Maria da Silva. '.repeat(4)}</p><p>Código de validação: 1234-ABCD</p>`)],
  });
  assert.equal(ok.r.status, 'concluido', ok.r.mensagem);
  assert.equal(ok.r.arquivo.origem, 'captura-de-pagina');
  assert.equal(ok.r.arquivo.mime, 'application/pdf');

  const erro = await rodar({
    'GET /': ['text/html', html(`<form method="post" action="/emitir">${CAMPOS}<button>Emitir</button></form>`)],
    'POST /emitir': ['text/html', html(`<h1>Certidão</h1><p>${'Não foi possível emitir a certidão negativa: código de verificação inválido. '.repeat(4)}</p>`)],
  }, {});
  assert.equal(erro.r.status, 'erro'); // esgota o tempo sem capturar a página de erro
});
