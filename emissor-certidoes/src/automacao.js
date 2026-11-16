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
    if (/captcha|c[óo]digo (da|de) (imagem|seguran|verifica)|caracteres|texto da imagem|letras/i.test(descricao)) {
      el.setAttribute('data-cert-campo', 'captcha');
      continue;
    }
    if (/senha|password|usu[áa]rio|login|c[óo]digo/i.test(descricao)) {
      el.setAttribute('data-cert-campo', 'ignorado');
      continue;
    }
    const regra = regras.find(([, re]) => re.test(descricao));
    if (regra) el.setAttribute('data-cert-campo', regra[0]);
  }
}
/* c8 ignore stop */

// Executada dentro da página: escolhe o modelo/tipo de certidão em listas e botões
// de opção. Cada termo de `opcoes` casa quando todas as suas palavras aparecem no
// texto da opção, sem diferenciar acentos nem maiúsculas.
/* c8 ignore start */
function marcarOpcoes(opcoes) {
  const limpar = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const casa = (texto) => { const t = limpar(texto); return opcoes.some((o) => limpar(o).split(/\s+/).every((p) => t.includes(p))); };
  let n = 0;
  for (const sel of document.querySelectorAll('select:not([data-cert-ok])')) {
    if (sel.disabled || !sel.getClientRects().length) continue;
    const op = [...sel.options].find((o) => casa(o.textContent));
    if (!op) continue;
    sel.setAttribute('data-cert-ok', '1');
    if (sel.value !== op.value) { sel.value = op.value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); n++; }
  }
  const grupos = new Set();
  for (const r of document.querySelectorAll('input[type=radio]:not([data-cert-ok])')) {
    if (r.disabled || grupos.has(r.name)) continue;
    const texto = [...(r.labels || [])].map((l) => l.textContent).join(' ') || r.value;
    if (!casa(texto)) continue;
    grupos.add(r.name);
    document.querySelectorAll(`input[type=radio][name="${CSS.escape(r.name)}"]`).forEach((x) => x.setAttribute('data-cert-ok', '1'));
    if (!r.checked) { r.click(); n++; }
  }
  return n;
}
/* c8 ignore stop */


// ---- Executadas dentro da página -------------------------------------------
/* c8 ignore start */

// Situação do formulário: quantos campos nossos estão visíveis e se há CAPTCHA por resolver.
function estadoFormulario() {
  const visivel = (el) => el.getClientRects().length > 0;
  const campos = [...document.querySelectorAll('[data-cert-ok][data-cert-campo]')].filter((e) => visivel(e) && e.value).length;
  let captcha = 'nenhum';
  let tamanho = 0;
  const resposta = document.querySelector('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]');
  const desafio = [...document.querySelectorAll('iframe[src*="recaptcha"][src*="anchor"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"]')]
    .some((f) => { const r = f.getBoundingClientRect(); return r.width > 60 && r.height > 40; });
  if (desafio) { // sem widget visível o reCAPTCHA é invisível e se resolve no envio
    const v = resposta ? resposta.value : '';
    captcha = v ? 'ok' : 'pendente';
    tamanho = v.length;
  }
  const imagem = [...document.querySelectorAll('[data-cert-campo="captcha"]')].find(visivel);
  if (imagem) {
    tamanho += imagem.value.length;
    if (imagem.value.trim().length < 3) captcha = 'pendente';
    else if (captcha !== 'pendente') captcha = 'ok';
  }
  return { campos, captcha, tamanho };
}

// Marca o botão que envia o pedido (data-cert-enviar). Devolve false se não achar.
function marcarEnviar() {
  document.querySelectorAll('[data-cert-enviar]').forEach((e) => e.removeAttribute('data-cert-enviar'));
  const sim = /^\s*(emitir|gerar|solicitar|consultar|pesquisar|enviar|confirmar|continuar|avan[cç]ar|prosseguir|obter|buscar|validar|requerer|ok)\b|(emitir|gerar|solicitar|obter) (a )?certid/i;
  const nao = /limpar|cancelar|voltar|nova (consulta|pesquisa)|imprimir|sair|fechar|ajuda|login|entrar|cadastr|autenticar|validar certid|conferir/i;
  const nossos = new Set([...document.querySelectorAll('[data-cert-ok]')].map((e) => e.closest('form')).filter(Boolean));
  let melhor = null;
  let nota = 0;
  for (const el of document.querySelectorAll('button, input[type=submit], input[type=button], input[type=image], a[role=button], a.btn, a.button')) {
    if (el.disabled || !el.getClientRects().length) continue;
    const texto = (el.textContent || '').trim() || el.value || el.title || el.getAttribute('aria-label') || el.alt || '';
    if (nao.test(texto)) continue;
    const noForm = nossos.has(el.closest('form'));
    const ehSubmit = el.type === 'submit' || el.type === 'image';
    let n = 0;
    if (sim.test(texto)) n += 4;
    if (noForm) n += 2;
    if (ehSubmit) n += 1;
    if (n >= 3 && n > nota) { nota = n; melhor = el; } // exige texto de envio, ou submit dentro do nosso formulário
  }
  if (!melhor) return false;
  melhor.setAttribute('data-cert-enviar', '1');
  return true;
}

// Depois do envio: marca um link/botão de "baixar/visualizar a certidão" ainda não usado.
function marcarBaixar() {
  const re = /baixar|download|gerar pdf|(visualizar|abrir|exibir|imprimir|ver|obter) (a )?certid|2[ªa] via|segunda via|clique aqui para (visualizar|baixar|imprimir|abrir)|vers[ãa]o para impress/i;
  for (const el of document.querySelectorAll('a, button, input[type=button], input[type=submit]')) {
    if (el.hasAttribute('data-cert-clicado') || el.disabled || !el.getClientRects().length) continue;
    const texto = (el.textContent || '').trim() || el.value || el.title || '';
    if (texto.length > 80 || !re.test(texto)) continue;
    el.setAttribute('data-cert-clicado', '1');
    el.setAttribute('data-cert-baixar', '1');
    return true;
  }
  return false;
}

// A página visível é a própria certidão (portais que a exibem em HTML)?
function pareceCertidao() {
  if (window.__certImprimiu) return 'impressao';
  if ([...document.querySelectorAll('[data-cert-ok][data-cert-campo]')].some((e) => e.getClientRects().length)) return '';
  const t = (document.body ? document.body.innerText : '').slice(0, 20000);
  if (/\berro\b|inv[áa]lid|incorret|tente novamente|n[ãa]o foi poss[íi]vel|expirad|preencha|obrigat[óo]ri/i.test(t.slice(0, 3000))) return '';
  const titulo = /certid[ãa]o|atestado|folha corrida/i.test(t);
  const corpo = /nada consta|n[ãa]o consta|n[ãa]o constam|consta[m]? (os seguintes|distribu|em nome)|certific[ao] que|c[óo]digo de (valida|autentic|controle|verifica)|autenticidade|certid[ãa]o (negativa|positiva)/i.test(t);
  return titulo && corpo && t.length > 200 ? 'texto' : '';
}

// PDFs embutidos na página (embed/object/iframe), inclusive blob: e data:.
function pdfsEmbutidos() {
  const urls = [];
  for (const el of document.querySelectorAll('embed, object, iframe')) {
    const u = el.src || el.data || '';
    const tipo = (el.type || '').toLowerCase();
    if (!u) continue;
    if (tipo === 'application/pdf' || /^blob:|^data:application\/pdf/i.test(u) || /\.pdf(\?|#|$)/i.test(u)) urls.push(u);
  }
  return urls;
}

// Baixa uma URL de dentro da página (mesma sessão e origem) e devolve em base64.
async function buscarNaPagina(url) {
  const r = await fetch(url, { credentials: 'include' });
  const bytes = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
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

// Uma aba que virou visualizador de PDF (ou travou) pode nunca responder a uma chamada.
// Nada no laço pode esperar para sempre, senão o pedido inteiro fica preso.
function comPrazo(promessa, ms) {
  let relogio;
  const limite = new Promise((_, rejeitar) => { relogio = setTimeout(() => rejeitar(new Error('sem resposta da página')), ms); });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(relogio));
}
const avaliar = (alvo, fn, arg) => comPrazo(alvo.evaluate(fn, arg), 4000);

async function preencherFrame(frame, valores, seletores, opcoes) {
  let preenchidos = 0;
  // O modelo vem primeiro: em vários portais ele define quais campos aparecem.
  if (opcoes && opcoes.length) preenchidos += await avaliar(frame, marcarOpcoes, opcoes);
  // Seletores explícitos do catálogo têm precedência sobre a heurística.
  for (const [campo, seletor] of Object.entries(seletores || {})) {
    await frame.locator(seletor).first()
      .evaluate((el, c) => { if (!el.hasAttribute('data-cert-campo')) el.setAttribute('data-cert-campo', c); }, campo)
      .catch(() => {});
  }
  await avaliar(frame, marcarCampos, PADROES);
  const pendentes = await frame
    .locator('[data-cert-campo]:not([data-cert-campo="ignorado"]):not([data-cert-campo="captcha"]):not([data-cert-ok])')
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

// O Playwright fica fora do executável (pasta node_modules ao lado dele).
function carregarPlaywright() {
  const { createRequire } = require('node:module');
  const path = require('node:path');
  let empacotado = false;
  try { empacotado = require('node:sea').isSea(); } catch { /* Node sem suporte a SEA */ }
  const base = empacotado ? path.join(path.dirname(process.execPath), 'app.js') : __filename;
  return createRequire(base)('playwright-core');
}

// Usa o navegador já instalado na máquina (Edge vem com o Windows; depois Chrome)
// e só então o Chromium do Playwright, se houver. CERTIDOES_NAVEGADOR força um canal.
let canalQueFunciona;
async function abrirNavegador(headless) {
  const { chromium } = carregarPlaywright();
  const forcado = process.env.CERTIDOES_NAVEGADOR;
  const canais = canalQueFunciona !== undefined ? [canalQueFunciona] : forcado ? [forcado] : ['msedge', 'chrome', null];
  let ultimoErro;
  for (const canal of canais) {
    try {
      const n = await chromium.launch({ headless, ...(canal ? { channel: canal } : {}) });
      canalQueFunciona = canal;
      return n;
    } catch (e) { ultimoErro = e; }
  }
  throw new Error('nenhum navegador encontrado (instale o Microsoft Edge ou o Google Chrome). ' + String(ultimoErro.message).split('\n')[0]);
}

class Execucao {
  constructor({ certidao, pessoa, opcoes, aoAtualizar }) {
    this.certidao = certidao;
    this.pessoa = pessoa;
    this.opcoes = { headless: false, tempoLimiteMs: 15 * 60 * 1000, intervaloMs: 1200, ...opcoes };
    this.aoAtualizar = aoAtualizar || (() => {});
    this.contexto = null;
    this._concluir = null;
  }

  _finalizar(resultado) { if (this._concluir) { this._concluir(resultado); this._concluir = null; } }

  cancelar() { this._finalizar({ status: 'cancelado', mensagem: 'Cancelado pelo operador.' }); }

  _paginaVisivel(contexto) {
    const abertas = contexto.pages().filter((p) => !p.isClosed() && p.url() !== 'about:blank');
    return abertas[abertas.length - 1] || null;
  }

  async _imprimir(p) {
    try {
      return { conteudo: await p.pdf({ format: 'A4', printBackground: true }), mime: 'application/pdf', ext: 'pdf' };
    } catch {
      return { conteudo: await p.screenshot({ fullPage: true }), mime: 'image/png', ext: 'png' };
    }
  }

  /** Salva a página visível (para portais que exibem a certidão em HTML, sem PDF). */
  async capturarPagina() {
    const p = this.contexto && this._paginaVisivel(this.contexto);
    if (!p) throw new Error('Nenhuma página aberta para capturar.');
    this._finalizar({ status: 'concluido', mensagem: 'Página capturada pelo operador.', arquivo: { ...(await comPrazo(this._imprimir(p), 20000)), origem: 'captura-de-pagina', urlOrigem: p.url() } });
  }

  async executar() {
    const valores = valoresPara(this.pessoa);
    let navegador;
    const resultado = new Promise((resolve) => { this._concluir = resolve; });
    const relogio = setTimeout(() => this._finalizar({ status: 'erro', mensagem: 'Tempo limite esgotado sem que a certidão fosse expedida.' }), this.opcoes.tempoLimiteMs);
    let laco;
    try {
      navegador = await abrirNavegador(this.opcoes.headless);
      navegador.on('disconnected', () => this._finalizar({ status: 'erro', mensagem: 'O navegador foi fechado antes da expedição da certidão.' }));
      const contexto = await navegador.newContext({ acceptDownloads: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
      this.contexto = contexto;
      // "Imprimir" não abre a caixa de impressão: vira o sinal de que a página é a certidão.
      await contexto.addInitScript(() => { window.print = () => { window.__certImprimiu = true; }; });

      const ehPdf = (b) => b && b.subarray(0, 5).toString('latin1') === '%PDF-';
      const entregarPdf = (conteudo, urlOrigem) => {
        if (!ehPdf(conteudo)) return false;
        this._finalizar({ status: 'concluido', mensagem: 'Certidão expedida pelo portal oficial.', arquivo: { conteudo, mime: 'application/pdf', ext: 'pdf', origem: 'portal-oficial', urlOrigem } });
        return true;
      };

      // --- A certidão pode surgir em QUALQUER aba ou janela do contexto ---------
      // (a) download; (b) resposta de rede em PDF; (c) aba/embutido em blob:, data: ou .pdf.
      const observar = (pagina) => {
        pagina.on('download', async (d) => {
          try {
            const partes = [];
            await comPrazo((async () => { for await (const p of await d.createReadStream()) partes.push(p); })(), 60000);
            entregarPdf(Buffer.concat(partes), d.url());
          } catch { /* download cancelado */ }
        });
      };
      contexto.on('page', observar);
      contexto.on('response', async (r) => {
        const h = r.headers();
        const pareceUrl = /\.pdf(\?|#|$)/i.test(r.url()) || /\.pdf/i.test(h['content-disposition'] || '');
        if (!/application\/(pdf|x-pdf)/i.test(h['content-type'] || '') && !(pareceUrl && /octet-stream|force-download|binary/i.test(h['content-type'] || ''))) return;
        try { if (entregarPdf(await r.body(), r.url())) return; } catch { /* o visualizador de PDF ficou com o corpo */ }
        // O navegador não devolveu o corpo (comum com PDF aberto em outra aba). Dá tempo para o
        // download ou a varredura das abas resolverem; só então refaz a requisição. Um POST é
        // refeito por último, porque repete o pedido no portal.
        await new Promise((ok) => setTimeout(ok, r.request().method() === 'GET' ? 1500 : 4000));
        if (!this._concluir) return;
        try { entregarPdf(await (await contexto.request.fetch(r.request())).body(), r.url()); } catch { /* segue para a varredura das abas */ }
      });

      const tentadas = new Set();
      const buscarUrl = async (url, frame) => {
        if (tentadas.has(url)) return;
        tentadas.add(url);
        try {
          if (/^data:/i.test(url)) {
            const [cab, dados] = [url.slice(0, url.indexOf(',')), url.slice(url.indexOf(',') + 1)];
            return void entregarPdf(/;base64/i.test(cab) ? Buffer.from(dados, 'base64') : Buffer.from(decodeURIComponent(dados), 'latin1'), 'data:');
          }
          if (/^blob:/i.test(url)) {
            // Um blob só é legível na origem que o criou: tenta nos quadros de todas as abas.
            const quadros = [frame, ...contexto.pages().flatMap((p) => p.frames())].filter(Boolean);
            for (const q of quadros) {
              try { if (entregarPdf(Buffer.from(await avaliar(q, buscarNaPagina, url), 'base64'), url)) return; } catch { /* outra origem */ }
            }
            return;
          }
          if (/^https?:/i.test(url)) entregarPdf(await (await contexto.request.get(url)).body(), url);
        } catch { /* indisponível */ }
      };
      const varrerAbas = async () => {
        for (const p of contexto.pages()) {
          if (p.isClosed()) continue;
          const u = p.url();
          if (/^blob:|^data:application\/pdf/i.test(u) || /\.pdf(\?|#|$)/i.test(u)) await buscarUrl(u, null);
          for (const frame of p.frames()) {
            const urls = await avaliar(frame, pdfsEmbutidos).catch(() => []);
            for (const url of urls) await buscarUrl(url, frame);
          }
        }
      };

      const pagina = await contexto.newPage();
      this.aoAtualizar('Abrindo o portal oficial…');
      await pagina.goto(this.certidao.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // --- Preenchimento e envio automáticos --------------------------------------
      const enviados = new Map(); // quadro -> assinatura do formulário já enviado
      let cliques = 0;
      let ultimoEnvio = 0;
      let captchaAnterior = '';
      let certidaoVista = 0;
      const ciclo = async () => {
        let aguardandoCaptcha = false;
        for (const p of contexto.pages()) {
          if (p.isClosed()) continue;
          for (const frame of p.frames()) {
            await preencherFrame(frame, valores, this.certidao.seletores, this.certidao.opcoes).catch(() => 0);
            const est = await avaliar(frame, estadoFormulario).catch(() => null);
            if (!est || !est.campos) continue;
            if (est.captcha === 'pendente') { aguardandoCaptcha = true; captchaAnterior = ''; continue; }
            // CAPTCHA de imagem: só envia quando o texto parou de mudar (o operador terminou de digitar).
            const marca = `${est.captcha}:${est.tamanho}`;
            if (est.captcha === 'ok' && marca !== captchaAnterior) { captchaAnterior = marca; aguardandoCaptcha = true; continue; }
            const assinatura = `${frame.url()}|${est.campos}|${est.tamanho}`;
            if (enviados.get(frame) === assinatura || cliques >= 8) continue;
            const alvo = this.certidao.enviar
              ? frame.locator(this.certidao.enviar).first()
              : (await avaliar(frame, marcarEnviar).catch(() => false)) ? frame.locator('[data-cert-enviar]').first() : null;
            enviados.set(frame, assinatura);
            cliques++;
            ultimoEnvio = Date.now();
            if (alvo) await alvo.click({ timeout: 5000 }).catch(() => {});
            else await frame.locator('[data-cert-ok][data-cert-campo]').last().press('Enter').catch(() => {});
            this.aoAtualizar('Pedido enviado ao portal. Aguardando a certidão…');
          }
        }
        if (aguardandoCaptcha) this.aoAtualizar('Resolva o CAPTCHA na janela do navegador. O envio é automático.');
        else if (!cliques) this.aoAtualizar('Preenchendo o formulário…');

        await varrerAbas();
        if (!this._concluir || !cliques || Date.now() - ultimoEnvio < 1500) return;

        // Depois do envio: página que já é a certidão, ou um link para abri-la.
        const visivel = this._paginaVisivel(contexto);
        const sinal = visivel ? await avaliar(visivel, pareceCertidao).catch(() => '') : '';
        if (sinal === 'impressao' || (sinal === 'texto' && ++certidaoVista >= 2)) {
          const arquivo = await comPrazo(this._imprimir(visivel), 20000);
          return this._finalizar({ status: 'concluido', mensagem: 'Certidão exibida pelo portal e salva em PDF.', arquivo: { ...arquivo, origem: 'captura-de-pagina', urlOrigem: visivel.url() } });
        }
        if (sinal !== 'texto') certidaoVista = 0;
        for (const p of contexto.pages()) {
          for (const frame of p.isClosed() ? [] : p.frames()) {
            if (await avaliar(frame, marcarBaixar).catch(() => false)) {
              const link = frame.locator('[data-cert-baixar]').first();
              await link.click({ timeout: 5000 }).catch(() => {});
              await link.evaluate((e) => e.removeAttribute('data-cert-baixar')).catch(() => {});
              ultimoEnvio = Date.now();
              return;
            }
          }
        }
      };
      laco = (async () => {
        while (this._concluir) {
          await comPrazo(ciclo(), 30000).catch(() => {});
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
      await comPrazo(Promise.resolve(laco), 5000).catch(() => {});
      this.contexto = null;
      if (navegador) await comPrazo(navegador.close(), 10000).catch(() => {});
    }
  }
}

module.exports = { Execucao, formatar, valoresPara, PADROES };
