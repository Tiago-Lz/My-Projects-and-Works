'use strict';
// Registro dos pedidos (cifrado em disco) e fila de execução: um portal por vez.

const crypto = require('node:crypto');
const { Execucao } = require('./automacao');

const ARQ = 'pedidos.enc';

class Pedidos {
  constructor(cofre, opcoesAutomacao = {}) {
    this.cofre = cofre;
    this.opcoes = opcoesAutomacao;
    this.lista = [];
    this.execucao = null; // { id, exec }
    this.rodando = false;
  }

  carregar() {
    this.lista = this.cofre.existe(ARQ) ? JSON.parse(this.cofre.ler(ARQ).toString('utf8')) : [];
    // Pedidos interrompidos por um encerramento anterior não ficam presos em "executando".
    for (const p of this.lista) {
      if (p.status === 'fila' || p.status === 'executando') {
        p.status = 'erro';
        p.mensagem = 'Interrompido: o sistema foi encerrado antes da conclusão.';
      }
    }
  }

  salvar() { this.cofre.gravar(ARQ, Buffer.from(JSON.stringify(this.lista))); }

  obter(id) { return this.lista.find((p) => p.id === id); }

  criar(pessoa, certidoes) {
    const base = Date.now() * 1000;
    const novos = certidoes.map((c, i) => ({
      id: crypto.randomUUID(),
      seq: base + i, // ordem de execução: a da seleção
      criadoEm: new Date().toISOString(),
      concluidoEm: null,
      pessoa,
      certidao: { id: c.id, orgao: c.orgao, nome: c.nome, url: c.url, seletores: c.seletores, enviar: c.enviar },
      status: 'fila',
      mensagem: 'Aguardando na fila.',
      arquivo: null,
    }));
    this.lista.unshift(...novos);
    this.salvar();
    this._processar();
    return novos;
  }

  async _processar() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      for (;;) {
        const p = this.lista.filter((x) => x.status === 'fila').sort((a, b) => a.seq - b.seq)[0];
        if (!p || !this.cofre.aberto) break;
        p.status = 'executando';
        p.mensagem = 'Iniciando o navegador…';
        const exec = new Execucao({
          certidao: p.certidao, pessoa: p.pessoa, opcoes: this.opcoes,
          aoAtualizar: (m) => { p.mensagem = m; },
        });
        this.execucao = { id: p.id, exec };
        const r = await exec.executar();
        this.execucao = null;
        if (!this.cofre.aberto) break; // cofre bloqueado durante a execução: nada é gravado
        if (!this.obter(p.id)) continue; // excluído durante a execução
        p.status = r.status;
        p.mensagem = r.mensagem;
        p.concluidoEm = new Date().toISOString();
        if (r.arquivo) {
          const nome = `arquivos/${p.id}.enc`;
          this.cofre.gravar(nome, r.arquivo.conteudo);
          p.arquivo = {
            caminho: nome,
            mime: r.arquivo.mime,
            ext: r.arquivo.ext,
            origem: r.arquivo.origem,
            urlOrigem: r.arquivo.urlOrigem,
            tamanho: r.arquivo.conteudo.length,
            sha256: crypto.createHash('sha256').update(r.arquivo.conteudo).digest('hex'),
          };
        }
        this.salvar();
      }
    } finally {
      this.rodando = false;
    }
  }

  cancelar(id) {
    const p = this.obter(id);
    if (!p) return false;
    if (this.execucao?.id === id) this.execucao.exec.cancelar();
    else if (p.status === 'fila') {
      p.status = 'cancelado';
      p.mensagem = 'Cancelado pelo operador.';
      this.salvar();
    }
    return true;
  }

  async capturar(id) {
    if (this.execucao?.id !== id) throw new Error('Este pedido não está em execução.');
    await this.execucao.exec.capturarPagina();
  }

  excluir(id) {
    const p = this.obter(id);
    if (!p) return false;
    if (this.execucao?.id === id) this.execucao.exec.cancelar();
    if (p.arquivo) this.cofre.apagar(p.arquivo.caminho);
    this.lista = this.lista.filter((x) => x.id !== id);
    this.salvar();
    return true;
  }

  lerArquivo(id) {
    const p = this.obter(id);
    if (!p?.arquivo) return null;
    return { pedido: p, conteudo: this.cofre.ler(p.arquivo.caminho) };
  }

  /** Encerra a execução em curso (usado ao bloquear o cofre ou desligar). */
  interromper() { if (this.execucao) this.execucao.exec.cancelar(); }
}

module.exports = { Pedidos };
