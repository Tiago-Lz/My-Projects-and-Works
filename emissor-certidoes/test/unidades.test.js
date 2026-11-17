'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cpfValido, cnpjValido, normalizarPessoa } = require('../src/validacao');
const { Banco } = require('../src/banco');
const { formatar } = require('../src/automacao');

test('valida CPF e CNPJ pelos dígitos verificadores', () => {
  assert.ok(cpfValido('529.982.247-25'));
  assert.ok(!cpfValido('529.982.247-26'));
  assert.ok(!cpfValido('111.111.111-11'));
  assert.ok(cnpjValido('11.222.333/0001-81'));
  assert.ok(!cnpjValido('11.222.333/0001-82'));
});

test('normaliza a pessoa e recusa dados inválidos', () => {
  const p = normalizarPessoa({ tipo: 'PF', nome: '  Maria   da Silva ', documento: '529.982.247-25', dataNascimento: '1990-02-28' });
  assert.equal(p.nome, 'Maria da Silva');
  assert.equal(p.documento, '52998224725');
  assert.throws(() => normalizarPessoa({ tipo: 'PF', nome: 'Maria', documento: '123' }), /CPF/);
  assert.throws(() => normalizarPessoa({ tipo: 'PJ', nome: 'ACME', documento: '52998224725' }), /CNPJ/);
  assert.throws(() => normalizarPessoa({ tipo: 'PF', nome: 'Maria', documento: '52998224725', dataNascimento: '1990-02-30' }), /Data/);
  const pj = normalizarPessoa({ tipo: 'PJ', nome: 'ACME Ltda', documento: '11222333000181', nomeMae: 'x' });
  assert.equal(pj.nomeMae, '');
});

test('formata valores conforme o campo do portal', () => {
  assert.equal(formatar('cpf', '52998224725', { maxLength: -1 }), '529.982.247-25');
  assert.equal(formatar('cpf', '52998224725', { maxLength: 11 }), '52998224725');
  assert.equal(formatar('documento', '11222333000181', { maxLength: -1 }), '11.222.333/0001-81');
  assert.equal(formatar('dataNascimento', '1990-02-28', { tipo: 'text', maxLength: -1 }), '28/02/1990');
  assert.equal(formatar('dataNascimento', '1990-02-28', { tipo: 'date', maxLength: -1 }), '1990-02-28');
});

test('banco: dono, escritório pagante, convite, limites, mensalidade e retenção', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banco-'));
  const b = new Banco(dir);
  // O responsável pelo sistema já existe, com acesso único: adm / Adulao57@.
  const dono = b.autenticar('ADM', 'Adulao57@');
  assert.equal(dono.usuario.perfil, 'dono');
  assert.equal(dono.chave, null); // o dono não tem como abrir certidões
  assert.equal(b.autenticar('adm', 'adulao57@'), null);
  assert.throws(() => b.criarConta({ escritorio: 'X Adv', nome: 'Ana Souza', email: 'ana@x.com', senha: 'curta' }), /8 caracteres/);
  assert.throws(() => b.criarConta({ escritorio: 'X Adv', nome: 'Ana Souza', email: 'ana@x.com', senha: 'semnumero!' }), /um número/);
  assert.throws(() => b.criarConta({ escritorio: 'X Adv', nome: 'Ana', email: 'ana@x.com', senha: 'Senha-da-ana-1' }), /nome completo/);
  assert.throws(() => b.criarConta({ escritorio: 'X Adv', nome: 'Ana Souza', email: 'ana@', senha: 'Senha-da-ana-1' }), /e-mail/);

  // Dono define os padrões; o escritório nasce com eles, em período de teste.
  b.definirConfig({ valor_mensal_centavos: 15000, limite_usuarios: 2, limite_certidoes_mes: 3, dias_teste: 5 });
  const ana = b.criarConta({ escritorio: 'Souza Advogados', email: 'Ana@Souza.adv.br', nome: 'Ana Souza', senha: 'senha-da-ana-1' });
  assert.equal(ana.usuario.perfil, 'admin');
  let conta = b.conta(ana.usuario.conta_id);
  assert.deepEqual([conta.valor_mensal_centavos, conta.limite_usuarios, conta.limite_certidoes_mes, conta.situacao], [15000, 2, 3, 'em dia']);
  assert.equal(Math.round((new Date(conta.vence_em) - Date.now()) / 86400000), 5);
  assert.equal(b.autenticar('ana@souza.adv.br', 'senha-errada-1'), null);
  assert.throws(() => b.criarConta({ escritorio: 'Outro', email: 'ana@souza.adv.br', nome: 'Outra Pessoa', senha: 'senha-qualquer-1' }), /Já existe/);

  // Convite: chave aleatória de uso único, que carrega a chave de dados da conta.
  const convite = b.criarConvite(conta.id, ana.chave);
  assert.match(convite.chave, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
  assert.ok(!fs.readFileSync(path.join(dir, 'emissor.db')).includes(convite.chave));
  assert.throws(() => b.usarConvite({ chave: 'AAAAA-BBBBB-CCCCC-DDDDD', email: 'bia@souza.adv.br', nome: 'Bia Lima', senha: 'senha-da-bia-1' }), /inválida/);
  const bia = b.usarConvite({ chave: convite.chave.toLowerCase(), email: 'bia@souza.adv.br', nome: 'Bia Lima', senha: 'senha-da-bia-1' });
  assert.equal(bia.usuario.perfil, 'usuario');
  assert.equal(bia.usuario.conta_id, conta.id);
  assert.deepEqual(bia.chave, ana.chave);
  assert.throws(() => b.usarConvite({ chave: convite.chave, email: 'caio@outro.adv.br', nome: 'Caio Lopes', senha: 'senha-do-caio-1' }), /inválida/); // já usada
  assert.throws(() => b.criarConvite(conta.id, ana.chave), /permite 2 usuário/); // limite do plano

  // Certidões: o usuário vê as suas, o admin vê as da conta, outra conta não vê nada.
  const guardar = (quem) => b.guardarArquivo({ contaId: quem.usuario.conta_id, usuarioId: quem.usuario.id, orgao: 'TJ', certidao: 'Cível', nomeArquivo: 'TJ MARIA CPF.pdf', mime: 'application/pdf', origem: 'portal-oficial', conteudo: Buffer.from('%PDF-segredo') }, quem.chave);
  const id = guardar(bia);
  assert.ok(!fs.readFileSync(path.join(dir, 'arquivos', id + '.enc')).includes('segredo'));
  assert.equal(b.lerArquivo(id, ana.chave).toString(), '%PDF-segredo');
  assert.equal(b.arquivos(ana.usuario).length, 1);
  const outro = b.criarConta({ escritorio: 'Outro Escritório', email: 'caio@outro.adv.br', nome: 'Caio Lopes', senha: 'senha-do-caio-1' });
  assert.equal(b.arquivos(outro.usuario).length, 0);
  assert.equal(b.arquivo(id, outro.usuario), null);
  assert.notDeepEqual(outro.chave, ana.chave);

  // Limite mensal, mensalidade vencida e suspensão bloqueiam a emissão.
  b.conferirEmissao(conta.id, 2);
  assert.throws(() => b.conferirEmissao(conta.id, 3), /Limite mensal de 3/);
  b.alterarConta(conta.id, { vence_em: new Date(Date.now() - 86400000).toISOString() });
  assert.equal(b.conta(conta.id).situacao, 'vencida');
  assert.throws(() => b.conferirEmissao(conta.id, 1), /Mensalidade vencida/);
  conta = b.registrarPagamento(conta.id);
  assert.equal(conta.situacao, 'em dia');
  assert.ok(new Date(conta.vence_em) - Date.now() > 27 * 86400000);
  b.alterarConta(conta.id, { status: 'suspensa', valor_mensal_centavos: 20000 });
  assert.throws(() => b.conferirEmissao(conta.id, 1), /suspensa/);
  b.alterarConta(conta.id, { status: 'ativa' });

  const r = b.resumo();
  assert.deepEqual([r.totais.contas, r.totais.usuarios, r.totais.certidoes_no_mes, r.totais.recebido_no_mes_centavos], [2, 3, 1, 15000]);
  assert.ok(!JSON.stringify(r).includes('MARIA')); // o dono não vê nada das certidões

  // Troca de senha mantém o acesso; desativar bloqueia o login.
  b.definirSenha(bia.usuario.id, 'senha-nova-bia-2', bia.chave);
  assert.equal(b.autenticar('bia@souza.adv.br', 'senha-da-bia-1'), null);
  assert.deepEqual(b.autenticar('bia@souza.adv.br', 'senha-nova-bia-2').chave, ana.chave);
  b.definirAtivo(bia.usuario.id, false);
  assert.equal(b.autenticar('bia@souza.adv.br', 'senha-nova-bia-2'), null);

  // Passado o prazo, a certidão some do banco e do disco.
  assert.equal(b.limparVencidos(new Date(Date.now() + 6.9 * 86400000)), 0);
  assert.equal(b.limparVencidos(new Date(Date.now() + 7.1 * 86400000)), 1);
  assert.equal(fs.readdirSync(path.join(dir, 'arquivos')).length, 0);
  b.fechar();
  fs.rmSync(dir, { recursive: true });
});
