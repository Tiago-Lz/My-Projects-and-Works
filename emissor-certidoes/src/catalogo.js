'use strict';
// Catálogo de portais: catalogo.json (padrão, versionado) + portais cadastrados
// pelo operador (dados/catalogo-personalizado.json). Só contém endereços públicos.

const fs = require('node:fs');
const path = require('node:path');

const ESFERAS = ['federal', 'estadual', 'trabalho', 'superior', 'mp', 'policia', 'fiscal', 'controle', 'registro'];
const NATUREZAS = ['civel', 'criminal', 'fiscal', 'trabalhista', 'cadastral'];

class Catalogo {
  constructor(dirDados, arquivoPadrao = path.join(__dirname, '..', 'catalogo.json')) {
    this.padrao = JSON.parse(fs.readFileSync(arquivoPadrao, 'utf8'));
    this.arquivo = path.join(dirDados, 'catalogo-personalizado.json');
    this.personalizado = fs.existsSync(this.arquivo) ? JSON.parse(fs.readFileSync(this.arquivo, 'utf8')) : [];
    // Endereços corrigidos pelo responsável na tela de revisão: valem por cima do catálogo padrão.
    this.arquivoEnderecos = path.join(dirDados, 'catalogo-enderecos.json');
    this.enderecos = fs.existsSync(this.arquivoEnderecos) ? JSON.parse(fs.readFileSync(this.arquivoEnderecos, 'utf8')) : {};
  }

  listar() {
    const corrigir = (c) => (this.enderecos[c.id] ? { ...c, url: this.enderecos[c.id], urlOriginal: c.url, conferir: false } : c);
    return [...this.padrao.map(corrigir), ...this.personalizado.map((c) => ({ ...c, personalizado: true }))];
  }

  /** Troca o endereço de um portal (vazio volta ao padrão). */
  definirEndereco(id, url) {
    const c = this.padrao.find((x) => x.id === id);
    const pessoal = this.personalizado.find((x) => x.id === id);
    if (!c && !pessoal) throw new Error('Portal não encontrado.');
    const novo = String(url ?? '').trim();
    if (novo) {
      let u;
      try { u = new URL(novo); } catch { throw new Error('Endereço inválido.'); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Endereço inválido.');
    }
    if (pessoal) { if (!novo) throw new Error('Informe o endereço.'); pessoal.url = novo; this._salvar(); return; }
    if (!novo || novo === c.url) delete this.enderecos[id]; else this.enderecos[id] = novo;
    fs.mkdirSync(path.dirname(this.arquivoEnderecos), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.arquivoEnderecos, JSON.stringify(this.enderecos, null, 2), { mode: 0o600 });
  }

  obter(id) { return this.listar().find((c) => c.id === id); }

  _salvar() {
    fs.mkdirSync(path.dirname(this.arquivo), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.arquivo, JSON.stringify(this.personalizado, null, 2), { mode: 0o600 });
  }

  adicionar(e) {
    const texto = (v, max) => String(v ?? '').trim().slice(0, max);
    const item = {
      id: 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      esfera: ESFERAS.includes(e.esfera) ? e.esfera : 'estadual',
      uf: texto(e.uf, 2).toUpperCase() || undefined,
      orgao: texto(e.orgao, 80),
      nome: texto(e.nome, 160),
      natureza: (Array.isArray(e.natureza) ? e.natureza : []).filter((n) => NATUREZAS.includes(n)),
      pessoas: (Array.isArray(e.pessoas) ? e.pessoas : []).filter((p) => p === 'PF' || p === 'PJ'),
      url: texto(e.url, 500),
    };
    if (!item.orgao || !item.nome) throw new Error('Informe o órgão e o nome da certidão.');
    let u;
    try { u = new URL(item.url); } catch { throw new Error('Endereço do portal inválido.'); }
    if (u.protocol !== 'https:') throw new Error('O portal deve usar https.');
    if (!item.natureza.length) throw new Error('Selecione ao menos uma natureza.');
    if (!item.pessoas.length) item.pessoas = ['PF', 'PJ'];
    this.personalizado.push(item);
    this._salvar();
    return item;
  }

  remover(id) {
    const antes = this.personalizado.length;
    this.personalizado = this.personalizado.filter((c) => c.id !== id);
    if (this.personalizado.length === antes) return false;
    this._salvar();
    return true;
  }
}

module.exports = { Catalogo };
