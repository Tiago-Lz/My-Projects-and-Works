'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let sessao = sessionStorage.getItem('sessao') || '';
  let catalogo = [];
  let ultimaLista = '';
  const marcados = new Set();
  let relogio = null;

  // Cria elementos sem innerHTML: dados do usuário e dos portais nunca viram HTML.
  function h(tag, props = {}, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...filhos.filter((f) => f != null && f !== false));
    return el;
  }

  async function api(metodo, rota, corpo) {
    const r = await fetch(rota, {
      method: metodo,
      headers: { 'X-Sessao': sessao, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401 && rota !== '/api/desbloquear') { mostrarCofre(true); throw new Error('Cofre bloqueado.'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || 'Falha na operação.');
    return r;
  }

  // ---------- Cofre ----------
  function mostrarCofre(configurado) {
    clearInterval(relogio);
    sessao = '';
    sessionStorage.removeItem('sessao');
    $('#tela-app').hidden = true;
    $('#btn-bloquear').hidden = true;
    $('#tela-cofre').hidden = false;
    $('#cofre-titulo').textContent = configurado ? 'Desbloquear cofre' : 'Criar senha mestra';
    $('#cofre-texto').textContent = configurado
      ? 'Os pedidos e as certidões estão cifrados. Informe a senha mestra para abri-los.'
      : 'Esta senha cifra todos os dados pessoais e certidões gravados nesta máquina. Não há como recuperá-la: se for perdida, os dados ficam inacessíveis.';
    $('#rotulo-confirma').hidden = configurado;
    $('#senha2').required = !configurado;
    $('#senha').value = $('#senha2').value = '';
    $('#senha').focus();
  }

  $('#form-cofre').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#cofre-erro');
    erro.textContent = '';
    if (!$('#rotulo-confirma').hidden && $('#senha').value !== $('#senha2').value) {
      erro.textContent = 'As senhas não conferem.';
      return;
    }
    try {
      const r = await api('POST', '/api/desbloquear', { senha: $('#senha').value });
      sessao = (await r.json()).sessao;
      sessionStorage.setItem('sessao', sessao);
      await abrirApp();
    } catch (ex) { erro.textContent = ex.message; }
  });

  $('#btn-bloquear').addEventListener('click', async () => {
    await api('POST', '/api/bloquear').catch(() => {});
    mostrarCofre(true);
  });

  // ---------- Catálogo ----------
  const ESFERAS = { federal: 'Justiça Federal', estadual: 'Justiça Estadual', trabalho: 'Justiça do Trabalho', superior: 'Tribunais superiores', mp: 'Ministério Público', policia: 'Polícia', fiscal: 'Fazenda e dívida ativa', registro: 'Junta comercial' };
  const tipoAtual = () => document.querySelector('input[name=tipo]:checked').value;

  function desenharCatalogo() {
    const tipo = tipoAtual();
    const nat = $('#filtro-natureza').value;
    const uf = $('#filtro-uf').value;
    const visiveis = catalogo.filter((c) => c.pessoas.includes(tipo) && (!nat || c.natureza.includes(nat)) && (!uf || c.uf === uf));
    // Uma certidão que deixou de valer para o tipo de pessoa não pode seguir marcada.
    for (const id of [...marcados]) if (!catalogo.some((c) => c.id === id && c.pessoas.includes(tipo))) marcados.delete(id);
    const caixa = $('#catalogo');
    caixa.replaceChildren();
    for (const [esfera, titulo] of Object.entries(ESFERAS)) {
      const itens = visiveis.filter((c) => c.esfera === esfera);
      if (!itens.length) continue;
      caixa.append(h('div', { class: 'grupo-titulo' }, titulo));
      for (const c of itens) {
        const caixinha = h('input', { type: 'checkbox', checked: marcados.has(c.id), onchange: (e) => { e.target.checked ? marcados.add(c.id) : marcados.delete(c.id); contar(); } });
        caixa.append(h('label', { class: 'item' }, caixinha,
          h('span', { class: 'texto' }, h('strong', {}, c.orgao + (c.uf && !c.orgao.includes(c.uf) ? ` (${c.uf})` : '')), ' — ' + c.nome, h('small', {}, c.url)),
          c.personalizado && h('button', { type: 'button', class: 'discreto perigo', onclick: async (e) => { e.preventDefault(); await api('DELETE', '/api/catalogo/' + c.id); await carregarCatalogo(); } }, 'Remover')));
      }
    }
    if (!caixa.children.length) caixa.append(h('p', { class: 'vazio' }, 'Nenhum portal para este filtro. Cadastre o portal abaixo.'));
    contar();
  }
  const contar = () => { $('#contagem').textContent = marcados.size ? `${marcados.size} selecionada(s)` : ''; };

  async function carregarCatalogo() {
    catalogo = await (await api('GET', '/api/catalogo')).json();
    const ufs = [...new Set(catalogo.map((c) => c.uf).filter(Boolean))].sort();
    const sel = $('#filtro-uf');
    const atual = sel.value;
    sel.replaceChildren(h('option', { value: '' }, 'Todas'), ...ufs.map((u) => h('option', { value: u }, u)));
    sel.value = ufs.includes(atual) ? atual : '';
    desenharCatalogo();
  }

  function ajustarTipo() {
    const pj = tipoAtual() === 'PJ';
    $('#rotulo-nome').textContent = pj ? 'Razão social' : 'Nome completo';
    $('#rotulo-doc').textContent = pj ? 'CNPJ' : 'CPF';
    document.querySelectorAll('.so-pf').forEach((el) => { el.hidden = pj; });
    desenharCatalogo();
  }
  document.querySelectorAll('input[name=tipo]').forEach((r) => r.addEventListener('change', ajustarTipo));
  $('#filtro-natureza').addEventListener('change', desenharCatalogo);
  $('#filtro-uf').addEventListener('change', desenharCatalogo);

  $('#form-pedido').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#pedido-erro');
    erro.textContent = '';
    const f = new FormData(e.target);
    const pessoa = Object.fromEntries(f.entries());
    try {
      await api('POST', '/api/pedidos', { pessoa, certidoes: [...marcados] });
      marcados.clear();
      desenharCatalogo();
      await atualizarPedidos();
      $('#pedidos').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) { erro.textContent = ex.message; }
  });

  $('#form-portal').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#portal-erro');
    erro.textContent = '';
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/catalogo', { orgao: f.get('orgao'), uf: f.get('uf'), nome: f.get('nome'), url: f.get('url'), esfera: f.get('esfera'), natureza: f.getAll('natureza') });
      e.target.reset();
      $('#novo-portal').open = false;
      await carregarCatalogo();
    } catch (ex) { erro.textContent = ex.message; }
  });

  // ---------- Pedidos ----------
  const ROTULOS = { fila: 'Na fila', executando: 'Em andamento', concluido: 'Concluído', erro: 'Não concluído', cancelado: 'Cancelado' };
  const mascara = (d) => d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  async function baixar(p, abrir) {
    const blob = await (await api('GET', `/api/pedidos/${p.id}/arquivo`)).blob();
    const url = URL.createObjectURL(blob);
    if (abrir) window.open(url, '_blank', 'noopener');
    else {
      // Padrão de nome: "TRF3 CIVIL ADALTO CPF.pdf"
      const semAcento = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const primeiro = semAcento(p.pessoa.nome).split(' ')[0].toUpperCase();
      const nome = `${p.certidao.rotulo || semAcento(p.certidao.orgao).toUpperCase()} ${primeiro} ${p.pessoa.tipo === 'PF' ? 'CPF' : 'CNPJ'}.${p.arquivo.ext}`.replace(/[^\w.\- ]+/g, '');
      h('a', { href: url, download: nome }).click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const acao = (texto, fn, classe = 'discreto') => h('button', { type: 'button', class: classe, onclick: async (e) => {
    e.target.disabled = true;
    try { await fn(); await atualizarPedidos(); } catch (ex) { alert(ex.message); } finally { e.target.disabled = false; }
  } }, texto);

  function cartaoPedido(p) {
    const botoes = [];
    if (p.status === 'executando') botoes.push(acao('Salvar a página aberta como certidão', () => api('POST', `/api/pedidos/${p.id}/capturar`)));
    if (p.status === 'executando' || p.status === 'fila') botoes.push(acao('Cancelar', () => api('POST', `/api/pedidos/${p.id}/cancelar`)));
    if (p.arquivo) botoes.push(acao('Abrir', () => baixar(p, true)), acao('Baixar', () => baixar(p, false)));
    if (p.status !== 'executando') botoes.push(acao('Excluir', async () => { if (confirm('Excluir este pedido e o arquivo da certidão?')) await api('DELETE', `/api/pedidos/${p.id}`); }, 'discreto perigo'));
    return h('article', { class: 'pedido ' + p.status },
      h('div', { class: 'pedido-topo' },
        h('div', {}, h('strong', {}, p.certidao.orgao), ' — ' + p.certidao.nome),
        h('span', { class: 'selo ' + p.status }, ROTULOS[p.status])),
      h('p', {}, `${p.pessoa.nome} · ${p.pessoa.tipo === 'PF' ? 'CPF' : 'CNPJ'} ${mascara(p.pessoa.documento)} · pedido em ${quando(p.criadoEm)}`),
      h('p', { class: 'msg' }, p.mensagem),
      p.arquivo && p.arquivo.origem === 'captura-de-pagina' && h('p', { class: 'alerta' }, 'Arquivo gerado por captura da página exibida, não pelo PDF do portal. Confira o conteúdo antes de usar.'),
      p.arquivo && h('p', {}, `SHA-256 ${p.arquivo.sha256} · ${(p.arquivo.tamanho / 1024).toFixed(0)} KB`),
      h('div', { class: 'acoes' }, ...botoes));
  }

  async function atualizarPedidos() {
    const lista = await (await api('GET', '/api/pedidos')).json();
    const assinatura = JSON.stringify(lista);
    if (assinatura === ultimaLista) return; // evita redesenhar (e perder o foco) sem mudança
    ultimaLista = assinatura;
    $('#pedidos').replaceChildren(...(lista.length ? lista.map(cartaoPedido) : [h('p', { class: 'vazio' }, 'Nenhum pedido ainda.')]));
  }

  async function abrirApp() {
    $('#tela-cofre').hidden = true;
    $('#tela-app').hidden = false;
    $('#btn-bloquear').hidden = false;
    ultimaLista = '';
    await carregarCatalogo();
    ajustarTipo();
    await atualizarPedidos();
    clearInterval(relogio);
    relogio = setInterval(() => atualizarPedidos().catch(() => {}), 2000);
  }

  (async () => {
    const estado = await (await fetch('/api/estado', { headers: { 'X-Sessao': sessao } })).json();
    if (estado.aberto) await abrirApp(); else mostrarCofre(estado.configurado);
  })();
})();
