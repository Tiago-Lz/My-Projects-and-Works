'use strict';

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

function cpfValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digito = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

function cnpjValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const digito = (n) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((s, p, i) => s + p * Number(d[i]), 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return digito(12) === Number(d[12]) && digito(13) === Number(d[13]);
}

const formatarCpf = (v) => soDigitos(v).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
const formatarCnpj = (v) => soDigitos(v).replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

function dataValida(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso && d <= new Date();
}

/** Valida e normaliza os dados da pessoa pesquisada. Lança Error com mensagem para o usuário. */
function normalizarPessoa(entrada) {
  const e = entrada || {};
  const texto = (v, max = 200) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  const tipo = e.tipo === 'PJ' ? 'PJ' : 'PF';
  const pessoa = {
    tipo,
    nome: texto(e.nome),
    documento: soDigitos(e.documento),
    nomeMae: tipo === 'PF' ? texto(e.nomeMae) : '',
    nomePai: tipo === 'PF' ? texto(e.nomePai) : '',
    dataNascimento: tipo === 'PF' ? texto(e.dataNascimento, 10) : '',
    rg: tipo === 'PF' ? texto(e.rg, 30) : '',
    email: texto(e.email, 120),
  };
  if (pessoa.nome.length < 3) throw new Error(tipo === 'PF' ? 'Informe o nome completo.' : 'Informe a razão social.');
  if (tipo === 'PF' && !cpfValido(pessoa.documento)) throw new Error('CPF inválido.');
  if (tipo === 'PJ' && !cnpjValido(pessoa.documento)) throw new Error('CNPJ inválido.');
  if (pessoa.dataNascimento && !dataValida(pessoa.dataNascimento)) throw new Error('Data de nascimento inválida.');
  if (pessoa.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pessoa.email)) throw new Error('E-mail inválido.');
  return pessoa;
}

module.exports = { soDigitos, cpfValido, cnpjValido, formatarCpf, formatarCnpj, dataValida, normalizarPessoa };
