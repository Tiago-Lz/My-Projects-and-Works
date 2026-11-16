'use strict';
// Fila de pedidos, mantida SOMENTE em memória. Os dados do pesquisado existem
// do envio do formulário até o fim da emissão e são descartados em seguida;
// nada deles vai para o disco. O que fica guardado (por 7 dias) é a certidão.

const crypto = require('node:crypto');
const { Execucao } = require('./automacao');

const semAcento = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '');

class Pedidos {
  constructor(banco, opcoesAutomacao = {}) {
    this.banco = banco;
    this.opcoes = opcoesAutomacao;
    this.lista = [];
    this.segredos = new Map(); // id -> { pessoa, chave }: nunca sai deste módulo
    this.execucao = null; // { id, exec }
    this.rodando = false;
  }

  criar(dono, chave, pessoa, certidoes) {
    const base = Date.now() * 1000;
    const primeiroNome = semAcento(pessoa.nome).split(' ')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
    const novos = certidoes.map((c, i) => {
      const p = {
        id: crypto.randomUUID(),
        seq: base + i, // ordem de execução: a da seleção
        dono: dono.id,
        criadoEm: new Date().toISOString(),
        certidao: { id: c.id, orgao: c.orgao, nome: c.nome, url: c.url, rotulo: c.rotulo, seletores: c.seletores, opcoes: c.opcoes, enviar: c.enviar },
        rotuloPessoa: `${primeiroNome} ${pessoa.tipo === 'PF' ? 'CPF' : 'CNPJ'}`,
        status: 'fila',
        mensagem: 'Aguardando na fila.',
        arquivoId: null,
      };
      this.segredos.set(p.id, { pessoa, chave });
      return p;
    });
    this.lista.unshift(...novos);
    this._processar();
    return novos;
  }

  doDono(donoId) { return this.lista.filter((p) => p.dono === donoId); }
  obter(id, donoId) { return this.lista.find((p) => p.id === id && p.dono === donoId); }

  _encerrar(p, status, mensagem) {
    this.segredos.delete(p.id); // descarta os dados do pesquisado
    p.status = status;
    p.mensagem = mensagem;
  }

  async _processar() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      for (;;) {
        const p = this.lista.filter((x) => x.status === 'fila').sort((a, b) => a.seq - b.seq)[0];
        if (!p) break;
        const { pessoa, chave } = this.segredos.get(p.id);
        p.status = 'executando';
        p.mensagem = 'Iniciando o navegador…';
        const exec = new Execucao({ certidao: p.certidao, pessoa, opcoes: this.opcoes, aoAtualizar: (m) => { p.mensagem = m; } });
        this.execucao = { id: p.id, exec };
        const r = await exec.executar();
        this.execucao = null;
        if (r.arquivo && this.lista.includes(p)) {
          const base = p.certidao.rotulo || semAcento(p.certidao.orgao).toUpperCase();
          p.arquivoId = this.banco.guardarArquivo({
            usuarioId: p.dono,
            orgao: p.certidao.orgao,
            certidao: p.certidao.nome,
            nomeArquivo: `${base} ${p.rotuloPessoa}.${r.arquivo.ext}`.replace(/[^\w.\- ]+/g, ''),
            mime: r.arquivo.mime,
            origem: r.arquivo.origem,
            conteudo: r.arquivo.conteudo,
          }, chave);
        }
        this._encerrar(p, r.status, r.mensagem);
      }
    } finally {
      this.rodando = false;
    }
  }

  cancelar(p) {
    if (this.execucao?.id === p.id) this.execucao.exec.cancelar();
    else if (p.status === 'fila') this._encerrar(p, 'cancelado', 'Cancelado pelo operador.');
  }

  async capturar(p) {
    if (this.execucao?.id !== p.id) throw new Error('Este pedido não está em execução.');
    await this.execucao.exec.capturarPagina();
  }

  remover(p) {
    this.cancelar(p);
    this.segredos.delete(p.id);
    this.lista = this.lista.filter((x) => x !== p);
  }

  /** Ao sair: interrompe e esquece tudo que pertence ao usuário (ou a todos). */
  esquecer(donoId) {
    for (const p of [...this.lista]) if (donoId === undefined || p.dono === donoId) this.remover(p);
  }
}

module.exports = { Pedidos };
