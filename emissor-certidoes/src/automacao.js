'use strict';
// Motor de automação. Para cada pedido:
//   1. abre o portal OFICIAL do órgão em um navegador visível;
//   2. localiza e preenche os campos do formulário com os dados informados;
//   3. o operador confere, resolve o CAPTCHA (nunca é burlado) e envia;
//   4. o PDF expedido pelo portal é capturado e devolvido para arquivamento.
// O sistema nunca fabrica a certidão: só guarda o que o órgão expediu.

const { formatarCpf, formatarCnpj } = require('./validacao');

// Ordem importa: "Nome da mãe" precisa casar antes de "Nome".
const PADROES = [
  ['nomeMae', 'm[ãa]e|genitora'],
  ['nomePai', '\\bpai\\b|\\bgenitor\\b'],
  ['dataNascimento', 'nasc'],
  ['documento', 'cpf.*cnpj|cnpj.*cpf'],
  ['cnpj', 'cnpj'],
  ['cpf', 'cpf'],
  ['rg', '\\brg\\b|identidade'],
  ['email', 'e-?mail'],
  ['nome', 'nome|raz[ãa]o\\s*social|requerente'],
];

// Executada dentro da página: etiqueta os campos reconhecidos com data-cert-campo.
/* c8 ignore start */
function marcarCampos(padroes) {
  const regras = padroes.map(([campo, fonte]) => [campo, new RegExp(fonte, 'i')]);
  const tipos = new Set(['', 'text', 'tel', 'email', 'date', 'number', 'search']);
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.hasAttribute('data-cert-campo')) continue;
    if (el.tagName === 'INPUT' && !tipos.has((el.getAttribute('type') || '').toLowerCase())) continue;
    if (el.disabled || el.readOnly || !el.getClientRects().length) continue;
    const rotulos = [...(el.labels || [])].map((l) => l.textContent);
    const bruto = [...rotulos, el.getAttribute('aria-label'), el.placeholder, el.title, el.name, el.id]
      .filter(Boolean).join(' ');
    const descricao = bruto.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.:]/g, ' ');
    if (/captcha|senha|password|usu[áa]rio|login|c[óo]digo/i.test(descricao)) {
      el.setAttribute('data-cert-campo', 'ignorado');
      continue;
    }
    const regra = regras.find(([, re]) => re.test(descricao));
    if (regra) el.setAttribute('data-cert-campo', regra[0]);
  }
}
/* c8 ignore stop */

function valoresPara(pessoa) {
  const pf = pessoa.tipo === 'PF';
  return {
    nome: pessoa.nome,
    documento: pessoa.documento,
    cpf: pf ? pessoa.documento : '',
    cnpj: pf ? '' : pessoa.documento,
    nomeMae: pessoa.nomeMae,
    nomePai: pessoa.nomePai,
    dataNascimento: pessoa.dataNascimento,
    rg: pessoa.rg,
    email: pessoa.email,
  };
}

function formatar(campo, valor, { tipo, maxLength }) {
  const cabe = (s) => !(maxLength > 0 && s.length > maxLength);
  if (campo === 'cpf' || campo === 'cnpj' || campo === 'documento') {
    const f = valor.length === 11 ? formatarCpf(valor) : formatarCnpj(valor);
    return cabe(f) ? f : valor;
  }
  if (campo === 'dataNascimento') {
    if (tipo === 'date') return valor;
    const [a, m, d] = valor.split('-');
    const f = `${d}/${m}/${a}`;
    return cabe(f) ? f : `${d}${m}${a}`;
  }
  return valor;
}

async function preencherFrame(frame, valores, seletores) {
  let preenchidos = 0;
  // Seletores explícitos do catálogo têm precedência sobre a heurística.
  for (const [campo, seletor] of Object.entries(seletores || {})) {
    await frame.locator(seletor).first()
      .evaluate((el, c) => { if (!el.hasAttribute('data-cert-campo')) el.setAttribute('data-cert-campo', c); }, campo)
      .catch(() => {});
  }
  await frame.evaluate(marcarCampos, PADROES);
  const pendentes = await frame
    .locator('[data-cert-campo]:not([data-cert-campo="ignorado"]):not([data-cert-ok])')
    .elementHandles();
  for (const h of pendentes) {
    const info = await h.evaluate((e) => {
      e.setAttribute('data-cert-ok', '1'); // cada campo é tratado uma única vez
      return { campo: e.getAttribute('data-cert-campo'), tipo: e.type, maxLength: e.maxLength, atual: e.value };
    });
    const valor = valores[info.campo];
    if (!valor || info.atual) continue; // nada a informar, ou já preenchido pelo operador
    const texto = formatar(info.campo, valor, info);
    await h.fill(texto).catch(() => h.type(texto).catch(() => {}));
    preenchidos++;
  }
  return preenchidos;
}

class Execucao {
  constructor({ certidao, pessoa, opcoes, aoAtualizar }) {
    this.certidao = certidao;
    this.pessoa = pessoa;
    this.opcoes = { headless: false, tempoLimiteMs: 15 * 60 * 1000, intervaloMs: 1200, ...opcoes };
    this.aoAtualizar = aoAtualizar || (() => {});
    this.paginaAtual = null;
    this._concluir = null;
  }

  _finalizar(resultado) { if (this._concluir) { this._concluir(resultado); this._concluir = null; } }

  cancelar() { this._finalizar({ status: 'cancelado', mensagem: 'Cancelado pelo operador.' }); }

  /** Salva a página visível (para portais que exibem a certidão em HTML, sem PDF). */
  async capturarPagina() {
    const p = this.paginaAtual;
    if (!p || p.isClosed()) throw new Error('Nenhuma página aberta para capturar.');
    let arquivo;
    try {
      arquivo = { conteudo: await p.pdf({ format: 'A4', printBackground: true }), mime: 'application/pdf', ext: 'pdf' };
    } catch {
      arquivo = { conteudo: await p.screenshot({ fullPage: true }), mime: 'image/png', ext: 'png' };
    }
    this._finalizar({ status: 'concluido', mensagem: 'Página capturada pelo operador.', arquivo: { ...arquivo, origem: 'captura-de-pagina', urlOrigem: p.url() } });
  }

  async executar() {
    const { chromium } = require('playwright');
    const valores = valoresPara(this.pessoa);
    let navegador;
    const resultado = new Promise((resolve) => { this._concluir = resolve; });
    const relogio = setTimeout(() => this._finalizar({ status: 'erro', mensagem: 'Tempo limite esgotado sem que a certidão fosse expedida.' }), this.opcoes.tempoLimiteMs);
    let laco;
    try {
      navegador = await chromium.launch({ headless: this.opcoes.headless });
      navegador.on('disconnected', () => this._finalizar({ status: 'erro', mensagem: 'O navegador foi fechado antes da expedição da certidão.' }));
      const contexto = await navegador.newContext({ acceptDownloads: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });

      const entregarPdf = (conteudo, urlOrigem) => {
        if (conteudo.subarray(0, 5).toString('latin1') !== '%PDF-') return;
        this._finalizar({ status: 'concluido', mensagem: 'Certidão expedida pelo portal oficial.', arquivo: { conteudo, mime: 'application/pdf', ext: 'pdf', origem: 'portal-oficial', urlOrigem } });
      };
      const observar = (pagina) => {
        this.paginaAtual = pagina;
        pagina.on('download', async (d) => {
          try {
            const fluxo = await d.createReadStream();
            const partes = [];
            for await (const p of fluxo) partes.push(p);
            entregarPdf(Buffer.concat(partes), d.url());
          } catch { /* download cancelado */ }
        });
        pagina.on('close', () => {
          const abertas = contexto.pages();
          this.paginaAtual = abertas[abertas.length - 1] || null;
        });
      };
      contexto.on('page', observar);
      contexto.on('response', async (r) => {
        if (!/application\/pdf/i.test(r.headers()['content-type'] || '')) return;
        try { entregarPdf(await r.body(), r.url()); } catch { /* corpo indisponível: virá como download */ }
      });

      const pagina = await contexto.newPage();
      this.aoAtualizar('Abrindo o portal oficial…');
      await pagina.goto(this.certidao.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      let avisou = false;
      let enviado = false;
      const ciclo = async () => {
        for (const p of contexto.pages()) {
          for (const frame of p.frames()) {
            const n = await preencherFrame(frame, valores, this.certidao.seletores).catch(() => 0);
            if (n && this.certidao.enviar && !enviado) {
              enviado = true; // só para portais sem CAPTCHA, configurados explicitamente
              await frame.locator(this.certidao.enviar).first().click().catch(() => { enviado = false; });
            }
          }
        }
        if (!avisou) {
          avisou = true;
          this.aoAtualizar('Dados preenchidos. Confira o formulário na janela do navegador, resolva o CAPTCHA se houver e envie o pedido.');
        }
      };
      laco = (async () => {
        while (this._concluir) {
          await ciclo().catch(() => {});
          await new Promise((r) => setTimeout(r, this.opcoes.intervaloMs));
        }
      })();

      return await resultado;
    } catch (erro) {
      this._finalizar(null);
      return { status: 'erro', mensagem: `Falha ao acessar o portal: ${String(erro.message).split('\n')[0]}` };
    } finally {
      clearTimeout(relogio);
      this._concluir = null;
      await laco;
      if (navegador) await navegador.close().catch(() => {});
    }
  }
}

module.exports = { Execucao, formatar, valoresPara, PADROES };
