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
  <label>Senha do portal <input name="f5"></label>
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

test('solicita no portal, captura o PDF expedido e guarda cifrado', { timeout: 120000 }, async () => {
  const portal = await portalFalso();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  const cat = path.join(dir, 'cat.json');
  fs.writeFileSync(cat, JSON.stringify([
    { id: 'falso', esfera: 'estadual', uf: 'ZZ', orgao: 'TJ-Teste', nome: 'Certidão', natureza: ['civel'], pessoas: ['PF'], url: portal.url, opcoes: ['falencia', 'eleitora'] },
  ]));
  const codigos = new Map(); // e-mail -> último código enviado
  const app = criarServidor({ enviarCodigo: async ({ para, codigo }) => { codigos.set(para, codigo); return { modo: 'email' }; }, dirDados: path.join(dir, 'dados'), porta: 0, catalogoPadrao: cat, automacao: { headless: true, intervaloMs: 200, tempoLimiteMs: 60000 } });
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

    // Cadastro em etapas, como a tela faz: dados → código no e-mail → senha.
    const cadastrar = async (dados, senha) => {
      const ini = await chamar('POST', '/api/cadastro/iniciar', dados);
      if (ini.status !== 201) return ini;
      const { id } = await ini.json();
      const email = dados.email.toLowerCase();
      assert.equal((await chamar('POST', '/api/cadastro/concluir', { id, senha })).status, 400); // sem código, não conclui
      assert.equal((await chamar('POST', '/api/cadastro/verificar', { id, codigo: '000000' === codigos.get(email) ? '111111' : '000000' })).status, 400);
      assert.equal((await chamar('POST', '/api/cadastro/verificar', { id, codigo: codigos.get(email) })).status, 200);
      return chamar('POST', '/api/cadastro/concluir', { id, senha });
    };

    // O responsável pelo sistema tem acesso único e fixo; ele gerencia contas mas não emite certidões.
    const dono = (await (await chamar('POST', '/api/entrar', { usuario: 'Adm', senha: 'Adulao57@' })).json()).sessao;
    assert.ok(dono);
    assert.equal((await chamar('POST', '/api/configurar', { usuario: 'x', nome: 'X', senha: 'senha-qualquer' })).status, 401); // não há mais criação de responsável
    sessao = dono;
    assert.equal((await chamar('GET', '/api/pedidos')).status, 403);
    assert.equal((await chamar('GET', '/api/arquivos')).status, 403);

    // O escritório se cadastra e vira administrador pagante da própria conta.
    sessao = '';
    const fraca = await cadastrar({ tipo: 'escritorio', escritorio: 'Souza Advogados', nome: 'Ana Souza', email: 'ana@souza.adv.br' }, 'senha123');
    assert.match((await fraca.json()).erro, /símbolo/);
    sessao = (await (await cadastrar({ tipo: 'escritorio', escritorio: 'Souza Advogados', nome: 'Ana Souza', email: 'ana2@souza.adv.br' }, 'Senha-da-ana-1')).json()).sessao;
    assert.equal((await chamar('POST', '/api/cadastro/iniciar', { tipo: 'escritorio', escritorio: 'Outro', nome: 'Outra Pessoa', email: 'ANA2@souza.adv.br' })).status, 400); // e-mail já usado
    assert.equal((await chamar('POST', '/api/entrar', { usuario: 'ana2@souza.adv.br', senha: 'senha-errada-1' })).status, 401);
    assert.equal((await chamar('GET', '/api/dono/resumo')).status, 403);

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

    // Usuário entra com a chave gerada pelo administrador e usa a conta dele.
    const admin = sessao;
    const { chave } = await (await chamar('POST', '/api/conta/convites')).json();
    sessao = '';
    assert.equal((await chamar('POST', '/api/cadastro/iniciar', { tipo: 'convite', chave: 'AAAAA-AAAAA-AAAAA-AAAAA', nome: 'Bia Lima', email: 'bia@souza.adv.br' })).status, 400);
    sessao = (await (await cadastrar({ tipo: 'convite', chave, nome: 'Bia Lima', email: 'bia@souza.adv.br' }, 'Senha-da-bia-1')).json()).sessao;
    assert.equal((await chamar('POST', '/api/cadastro/iniciar', { tipo: 'convite', chave, nome: 'Caio Lopes', email: 'caio@souza.adv.br' })).status, 400); // chave já usada
    assert.equal((await chamar('POST', '/api/conta/convites')).status, 403);
    assert.equal((await (await chamar('GET', '/api/arquivos')).json()).length, 0); // não vê as certidões da Ana
    assert.equal((await chamar('GET', `/api/arquivos/${arq.id}`)).status, 404);
    assert.equal((await (await chamar('GET', '/api/conta')).json()).valor_mensal_centavos, undefined);

    // O dono vê o escritório, altera o limite e isso bloqueia novas emissões.
    sessao = dono;
    const resumo = await (await chamar('GET', '/api/dono/resumo')).json();
    assert.deepEqual([resumo.totais.contas, resumo.totais.usuarios, resumo.totais.certidoes_no_mes], [1, 2, 1]);
    assert.ok(!/MARIA|Silva/.test(JSON.stringify(resumo)));
    const contaId = resumo.contas[0].id;
    assert.equal((await chamar('POST', `/api/dono/contas/${contaId}`, { limite_certidoes_mes: 1 })).status, 200);
    sessao = admin;
    const bloqueado = await chamar('POST', '/api/pedidos', { pessoa, certidoes: ['falso'] });
    assert.equal(bloqueado.status, 400);
    assert.match((await bloqueado.json()).erro, /Limite mensal/);
    sessao = dono;
    await chamar('POST', `/api/dono/contas/${contaId}`, { status: 'suspensa' });
    sessao = admin;
    assert.match((await (await chamar('POST', '/api/pedidos', { pessoa, certidoes: ['falso'] })).json()).erro, /suspensa/);

    // Sair descarta os pedidos da sessão; a certidão guardada continua até o prazo.
    await chamar('POST', '/api/sair');
    assert.equal((await chamar('GET', '/api/pedidos')).status, 401);
    sessao = (await (await chamar('POST', '/api/entrar', { usuario: 'ana2@souza.adv.br', senha: 'Senha-da-ana-1' })).json()).sessao;
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
