'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cpfValido, cnpjValido, normalizarPessoa } = require('../src/validacao');
const { Cofre } = require('../src/cofre');
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

test('cofre cifra em disco e rejeita senha errada ou adulteração', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-'));
  const c = new Cofre(dir);
  assert.throws(() => c.criar('curta'), /8 caracteres/);
  c.criar('senha-mestra-1');
  c.gravar('x.enc', Buffer.from('CPF 529.982.247-25'));
  assert.ok(!fs.readFileSync(path.join(dir, 'x.enc')).includes('529'));
  c.fechar();
  assert.throws(() => c.ler('x.enc'), /bloqueado/);
  assert.equal(new Cofre(dir).abrir('senha-errada-1'), false);
  const c2 = new Cofre(dir);
  assert.equal(c2.abrir('senha-mestra-1'), true);
  assert.equal(c2.ler('x.enc').toString(), 'CPF 529.982.247-25');
  const bruto = fs.readFileSync(path.join(dir, 'x.enc'));
  bruto[bruto.length - 1] ^= 1;
  fs.writeFileSync(path.join(dir, 'x.enc'), bruto);
  assert.throws(() => c2.ler('x.enc'));
  fs.rmSync(dir, { recursive: true });
});
