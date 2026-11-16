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
  <select name="modelo"><option value="">Selecione</option><option value="6">CERTIDÃO DE DISTRIBUIÇÃO CÍVEL</option><option value="9">FALÊNCIAS, CONCORDATAS E RECUPERAÇÕES</option></select>
  <label><input type="radio" name="tipo" value="c" checked> Cível</label><label><input type="radio" name="tipo" value="e"> Fins eleitorais</label>
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
    { id: 'falso', esfera: 'estadual', uf: 'ZZ', orgao: 'TJ-Teste', nome: 'Certidão', natureza: ['civel'], pessoas: ['PF'], url: portal.url, enviar: '#enviar', opcoes: ['falencia', 'eleitora'] },
  ]));
  const app = criarServidor({ dirDados: path.join(dir, 'dados'), porta: 0, catalogoPadrao: cat, automacao: { headless: true, intervaloMs: 200, tempoLimiteMs: 60000 } });
  const porta = await app.iniciar();
  const base = `http://127.0.0.1:${porta}`;
  let sessao = '';
  const chamar = (m, rota, corpo) => fetch(base + rota, { method: m, headers: { 'X-Sessao': sessao, 'Content-Type': 'application/json' }, body: corpo && JSON.stringify(corpo) });
  const esperar = async (id) => {
    for (let i = 0; i < 150; i++) {
      const p = (await (await chamar('GET', '/api/pedidos')).json()).find((x) => x.id === id);
      if (p.status !== 'fila' && p.status !== 'executando') return p;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('pedido não terminou');
  };
  try {
    assert.equal((await chamar('GET', '/api/pedidos')).status, 401);
    const statusComHost = (host) => new Promise((ok) => http.get({ host: '127.0.0.1', port: porta, path: '/api/estado', headers: { Host: host } }, (r) => { r.resume(); ok(r.statusCode); }));
    assert.equal(await statusComHost('malicioso.example'), 403);
    assert.equal(await statusComHost(`localhost:${porta}`), 200);

    // Primeiro acesso cria o administrador; depois disso a rota se fecha.
    sessao = (await (await chamar('POST', '/api/configurar', { usuario: 'ana', nome: 'Ana Souza', senha: 'senha-da-ana-1' })).json()).sessao;
    assert.equal((await chamar('POST', '/api/configurar', { usuario: 'x', nome: 'X', senha: 'senha-qualquer' })).status, 400);
    assert.equal((await chamar('POST', '/api/entrar', { usuario: 'ana', senha: 'senha-errada-1' })).status, 401);

    const invalido = await chamar('POST', '/api/pedidos', { pessoa: { tipo: 'PF', nome: 'Maria', documento: '1' }, certidoes: ['falso'] });
    assert.equal(invalido.status, 400);

    const pessoa = { tipo: 'PF', nome: 'Maria da Silva', documento: '529.982.247-25', nomeMae: 'Ana Pereira', dataNascimento: '1990-02-28' };
    const [criado] = await (await chamar('POST', '/api/pedidos', { pessoa, certidoes: ['falso'] })).json();
    const p = await esperar(criado.id);
    assert.equal(p.status, 'concluido', p.mensagem);
    assert.equal(p.pessoa, 'MARIA CPF');
    assert.deepEqual(portal.recebidos[0], { f1: 'Maria da Silva', f2: '529.982.247-25', nmMae: 'Ana Pereira', f4: '28/02/1990', f5: '', usuarioNome: '', modelo: '9', tipo: 'e' });

    // Depois da emissão os dados do pesquisado não existem mais nem em memória.
    assert.equal(app.pedidos.segredos.size, 0);
    assert.ok(!/Silva|Pereira|52998224725|1990/.test(JSON.stringify(app.pedidos.lista)));

    const [arq] = await (await chamar('GET', '/api/arquivos')).json();
    assert.equal(arq.id, p.arquivoId);
    assert.equal(arq.nomeArquivo, 'TJ-TESTE MARIA CPF.pdf');
    assert.equal(arq.origem, 'portal-oficial');
    const pdf = Buffer.from(await (await chamar('GET', `/api/arquivos/${arq.id}`)).arrayBuffer());
    assert.ok(pdf.toString().startsWith('%PDF-'));

    // Em disco: nenhum dado do pesquisado além do primeiro nome, e nenhum PDF legível.
    const emDisco = fs.readdirSync(path.join(dir, 'dados'), { recursive: true })
      .map((f) => path.join(dir, 'dados', f)).filter((f) => fs.statSync(f).isFile())
      .map((f) => fs.readFileSync(f).toString('latin1')).join('');
    assert.ok(!/Silva|Pereira|52998224725|529\.982|1990-02-28|28\/02\/1990|%PDF/.test(emDisco));

    // Operador: não gerencia usuários, não vê certidões de outro usuário.
    assert.equal((await chamar('POST', '/api/usuarios', { usuario: 'bia', nome: 'Bia Lima', senha: 'senha-da-bia-1' })).status, 201);
    const admin = sessao;
    sessao = (await (await chamar('POST', '/api/entrar', { usuario: 'bia', senha: 'senha-da-bia-1' })).json()).sessao;
    assert.equal((await chamar('GET', '/api/usuarios')).status, 403);
    assert.equal((await (await chamar('GET', '/api/arquivos')).json()).length, 0);
    assert.equal((await chamar('GET', `/api/arquivos/${arq.id}`)).status, 404);
    await chamar('POST', '/api/sair');
    assert.equal((await chamar('GET', '/api/pedidos')).status, 401);

    // Sair descarta os pedidos da sessão; a certidão guardada continua até o prazo.
    sessao = admin;
    await chamar('POST', '/api/sair');
    sessao = (await (await chamar('POST', '/api/entrar', { usuario: 'ana', senha: 'senha-da-ana-1' })).json()).sessao;
    assert.equal((await (await chamar('GET', '/api/pedidos')).json()).length, 0);
    assert.equal((await (await chamar('GET', '/api/arquivos')).json()).length, 1);
    app.banco.limparVencidos(new Date(Date.now() + 8 * 86400000));
    assert.equal((await chamar('GET', `/api/arquivos/${arq.id}`)).status, 404);
    assert.equal(fs.readdirSync(path.join(dir, 'dados', 'arquivos')).length, 0);
  } finally {
    await app.parar();
    portal.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
