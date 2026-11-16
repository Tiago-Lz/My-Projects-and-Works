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

test('banco: login, chave de dados por usuário e retenção de 7 dias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banco-'));
  const b = new Banco(dir);
  assert.throws(() => b.criarPrimeiroAdmin({ usuario: 'ana', nome: 'Ana', senha: 'curta' }), /8 caracteres/);
  const admin = b.criarPrimeiroAdmin({ usuario: 'Ana', nome: 'Ana Souza', senha: 'senha-da-ana-1' });
  assert.equal(admin.usuario.perfil, 'admin');
  assert.throws(() => b.criarPrimeiroAdmin({ usuario: 'outro', nome: 'Outro', senha: 'senha-outro-1' }), /já foi configurado/);
  assert.equal(b.autenticar('ana', 'senha-errada-1'), null);
  assert.equal(b.autenticar('ninguem', 'senha-da-ana-1'), null);

  // Operador criado pelo admin recebe a mesma chave de dados, sob a própria senha.
  const op = b.criarUsuario({ usuario: 'bia', nome: 'Bia Lima', senha: 'senha-da-bia-1' }, admin.chave);
  assert.equal(op.perfil, 'operador');
  assert.throws(() => b.criarUsuario({ usuario: 'bia', nome: 'Outra', senha: 'senha-da-bia-2' }, admin.chave), /Já existe/);
  const bia = b.autenticar('bia', 'senha-da-bia-1');
  assert.deepEqual(bia.chave, admin.chave);

  const id = b.guardarArquivo({ usuarioId: bia.usuario.id, orgao: 'TJ', certidao: 'Cível', nomeArquivo: 'TJ MARIA CPF.pdf', mime: 'application/pdf', origem: 'portal-oficial', conteudo: Buffer.from('%PDF-segredo') }, bia.chave);
  assert.ok(!fs.readFileSync(path.join(dir, 'arquivos', id + '.enc')).includes('segredo'));
  assert.equal(b.lerArquivo(id, admin.chave).toString(), '%PDF-segredo');
  assert.equal(b.arquivos(admin.usuario).length, 1); // admin vê os de todos
  const [a] = b.arquivos(bia.usuario);
  assert.equal(Math.round((new Date(a.expira_em) - new Date(a.criado_em)) / 86400000), 7);

  // Troca de senha mantém o acesso; a antiga deixa de valer.
  b.definirSenha(bia.usuario.id, 'senha-nova-bia-2', bia.chave);
  assert.equal(b.autenticar('bia', 'senha-da-bia-1'), null);
  assert.deepEqual(b.autenticar('bia', 'senha-nova-bia-2').chave, admin.chave);

  assert.throws(() => b.definirAtivo(admin.usuario.id, false), /único administrador/);
  b.definirAtivo(bia.usuario.id, false);
  assert.equal(b.autenticar('bia', 'senha-nova-bia-2'), null);

  // Passado o prazo, some do banco e do disco.
  assert.equal(b.limparVencidos(new Date(Date.now() + 6.9 * 86400000)), 0);
  assert.equal(b.limparVencidos(new Date(Date.now() + 7.1 * 86400000)), 1);
  assert.equal(b.arquivos(admin.usuario).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'arquivos')).length, 0);
  b.fechar();
  fs.rmSync(dir, { recursive: true });
});
