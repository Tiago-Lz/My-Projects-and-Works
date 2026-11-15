'use strict';
// Fluxo completo contra um portal simulado: preenchimento, envio, captura do PDF
// expedido, gravação cifrada e download pela API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarServidor } = require('../server');

const FORM = `<!doctype html><meta charset="utf-8"><form method="post" action="/emitir">
  <label for="a">Nome completo</label><input id="a" name="f1">
  <label>CPF/CNPJ <input name="f2"></label>
  <input name="nmMae" placeholder="">
  <label>Data de nascimento <input name="f4" maxlength="10"></label>
  <label>Código da imagem (captcha) <input name="f5"></label>
  <input name="usuarioNome">
  <button id="enviar">Emitir</button></form>`;

function portalFalso() {
  const recebidos = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let corpo = '';
      req.on('data', (p) => { corpo += p; });
      req.on('end', () => {
        recebidos.push(Object.fromEntries(new URLSearchParams(corpo)));
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="certidao.pdf"' });
        res.end('%PDF-1.4\n% certidao de teste\n%%EOF\n');
      });
    } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FORM); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, recebidos, url: `http://127.0.0.1:${srv.address().port}/` })));
}

test('solicita no portal, captura o PDF expedido e guarda cifrado', async () => {
  const portal = await portalFalso();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  const cat = path.join(dir, 'cat.json');
  fs.writeFileSync(cat, JSON.stringify([
    { id: 'falso', esfera: 'estadual', uf: 'ZZ', orgao: 'TJ-Teste', nome: 'Certidão', natureza: ['civel'], pessoas: ['PF'], url: portal.url, enviar: '#enviar' },
  ]));
  const app = criarServidor({ dirDados: path.join(dir, 'dados'), porta: 0, catalogoPadrao: cat, automacao: { headless: true, intervaloMs: 200, tempoLimiteMs: 60000 } });
  const porta = await app.iniciar();
  const base = `http://127.0.0.1:${porta}`;
  let sessao = '';
  const chamar = (m, rota, corpo) => fetch(base + rota, { method: m, headers: { 'X-Sessao': sessao, 'Content-Type': 'application/json' }, body: corpo && JSON.stringify(corpo) });
  try {
    assert.equal((await chamar('GET', '/api/pedidos')).status, 401);
    const statusComHost = (host) => new Promise((ok) => http.get({ host: '127.0.0.1', port: porta, path: '/api/estado', headers: { Host: host } }, (r) => { r.resume(); ok(r.statusCode); }));
    assert.equal(await statusComHost('malicioso.example'), 403);
    assert.equal(await statusComHost(`localhost:${porta}`), 200);
    sessao = (await (await chamar('POST', '/api/desbloquear', { senha: 'senha-mestra-1' })).json()).sessao;
    assert.equal((await chamar('POST', '/api/desbloquear', { senha: 'outra-senha-9' })).status, 401);

    const invalido = await chamar('POST', '/api/pedidos', { pessoa: { tipo: 'PF', nome: 'Maria', documento: '1' }, certidoes: ['falso'] });
    assert.equal(invalido.status, 400);

    const pessoa = { tipo: 'PF', nome: 'Maria da Silva', documento: '529.982.247-25', nomeMae: 'Ana da Silva', dataNascimento: '1990-02-28' };
    const [criado] = await (await chamar('POST', '/api/pedidos', { pessoa, certidoes: ['falso'] })).json();

    let p;
    for (let i = 0; i < 150; i++) {
      p = (await (await chamar('GET', '/api/pedidos')).json()).find((x) => x.id === criado.id);
      if (p.status !== 'fila' && p.status !== 'executando') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(p.status, 'concluido', p.mensagem);
    assert.equal(p.arquivo.origem, 'portal-oficial');
    assert.equal(p.arquivo.caminho, undefined);
    assert.deepEqual(portal.recebidos[0], { f1: 'Maria da Silva', f2: '529.982.247-25', nmMae: 'Ana da Silva', f4: '28/02/1990', f5: '', usuarioNome: '' });

    const pdf = Buffer.from(await (await chamar('GET', `/api/pedidos/${p.id}/arquivo`)).arrayBuffer());
    assert.ok(pdf.toString().startsWith('%PDF-'));
    // Nada legível em disco.
    const emDisco = fs.readdirSync(path.join(dir, 'dados'), { recursive: true })
      .map((f) => path.join(dir, 'dados', f)).filter((f) => fs.statSync(f).isFile() && !f.endsWith('cofre.json'))
      .map((f) => fs.readFileSync(f).toString('latin1')).join('');
    assert.ok(!emDisco.includes('Maria') && !emDisco.includes('52998224725') && !emDisco.includes('%PDF'));

    await chamar('POST', '/api/bloquear');
    assert.equal((await chamar('GET', '/api/pedidos')).status, 401);
    sessao = (await (await chamar('POST', '/api/desbloquear', { senha: 'senha-mestra-1' })).json()).sessao;
    assert.equal((await (await chamar('GET', '/api/pedidos')).json()).length, 1);
    assert.equal((await chamar('DELETE', `/api/pedidos/${p.id}`)).status, 200);
    assert.equal(fs.readdirSync(path.join(dir, 'dados', 'arquivos')).length, 0);
  } finally {
    await app.parar();
    portal.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
