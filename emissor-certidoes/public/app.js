'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let sessao = sessionStorage.getItem('sessao') || '';
  let eu = null;
  let catalogo = [];
  let ultimo = '';
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

  const PUBLICAS = ['/api/entrar', '/api/configurar', '/api/senha'];
  async function api(metodo, rota, corpo) {
    const r = await fetch(rota, {
      method: metodo,
      headers: { 'X-Sessao': sessao, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401 && !PUBLICAS.includes(rota)) { mostrarLogin(true); throw new Error('Sessão encerrada. Faça login novamente.'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || 'Falha na operação.');
    return r;
  }

  // ---------- Login ----------
  function mostrarLogin(configurado) {
    clearInterval(relogio);
    sessao = '';
    eu = null;
    sessionStorage.removeItem('sessao');
    $('#tela-app').hidden = true;
    $('#barra-usuario').hidden = true;
    $('#tela-login').hidden = false;
    $('#login-titulo').textContent = configurado ? 'Entrar' : 'Primeiro acesso';
    $('#login-texto').textContent = configurado ? '' : 'Crie a conta do administrador. Ela poderá cadastrar os demais usuários.';
    document.querySelectorAll('.so-primeiro').forEach((el) => { el.hidden = configurado; el.querySelector('input').required = !configurado; });
    $('#form-login').dataset.modo = configurado ? 'entrar' : 'configurar';
    $('#form-login').reset();
    $('#login-usuario').focus();
  }

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#login-erro');
    erro.textContent = '';
    const f = Object.fromEntries(new FormData(e.target).entries());
    const novo = e.target.dataset.modo === 'configurar';
    if (novo && f.senha !== f.senha2) { erro.textContent = 'As senhas não conferem.'; return; }
    try {
      const r = await (await api('POST', novo ? '/api/configurar' : '/api/entrar', f)).json();
      sessao = r.sessao;
      sessionStorage.setItem('sessao', sessao);
      e.target.reset();
      await abrirApp(r.usuario);
    } catch (ex) { erro.textContent = ex.message; }
  });

  $('#btn-sair').addEventListener('click', async () => {
    await api('POST', '/api/sair').catch(() => {});
    mostrarLogin(true);
  });

  $('#form-senha').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#senha-msg');
    msg.textContent = '';
    const f = Object.fromEntries(new FormData(e.target).entries());
    if (f.nova !== f.nova2) { msg.textContent = 'As senhas não conferem.'; return; }
    try {
      await api('POST', '/api/senha', { atual: f.atual, nova: f.nova });
      e.target.reset();
      msg.textContent = 'Senha alterada.';
    } catch (ex) { msg.textContent = ex.message; }
  });

  // ---------- Usuários (administrador) ----------
  async function carregarUsuarios() {
    if (eu.perfil !== 'admin') return;
    const lista = await (await api('GET', '/api/usuarios')).json();
    $('#usuarios').replaceChildren(...lista.map((u) => h('div', { class: 'linha-usuario' },
      h('span', { class: 'texto' }, h('strong', {}, u.nome), ` · ${u.usuario} · ${u.perfil === 'admin' ? 'administrador' : 'operador'}${u.ativo ? '' : ' · desativado'}`),
      acao('Redefinir senha', async () => {
        const senha = prompt(`Nova senha para ${u.usuario} (mínimo 8 caracteres):`);
        if (senha) await api('POST', `/api/usuarios/${u.id}/senha`, { senha });
      }),
      u.id !== eu.id && acao(u.ativo ? 'Desativar' : 'Reativar', () => api('POST', `/api/usuarios/${u.id}/ativo`, { ativo: !u.ativo }), 'discreto' + (u.ativo ? ' perigo' : '')))));
  }

  $('#form-usuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#usuario-erro');
    erro.textContent = '';
    try {
      await api('POST', '/api/usuarios', Object.fromEntries(new FormData(e.target).entries()));
      e.target.reset();
      await carregarUsuarios();
    } catch (ex) { erro.textContent = ex.message; }
  });

  // ---------- Catálogo ----------
  const ESFERAS = { federal: 'Justiça Federal', estadual: 'Justiça Estadual', trabalho: 'Justiça do Trabalho', superior: 'Tribunais superiores', mp: 'Ministério Público', policia: 'Polícia', fiscal: 'Fazenda e dívida ativa', registro: 'Junta comercial' };
  const tipoAtual = () => document.querySelector('input[name=tipo]:checked').value;

  const ESTADOS = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
  const semAcento = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // Estados a que um portal se aplica; vazio = âmbito nacional. Um TRF vale para
  // todos os estados da sua região e aparece em cada um deles.
  const ufsDe = (c) => (c.uf ? [c.uf] : c.ufs || []);
  const abertos = new Set();

  function linhaCertidao(c) {
    const caixinha = h('input', { type: 'checkbox', 'data-id': c.id, checked: marcados.has(c.id), onchange: (e) => {
      e.target.checked ? marcados.add(c.id) : marcados.delete(c.id);
      // A mesma certidão pode estar listada em mais de um estado.
      document.querySelectorAll(`#catalogo input[data-id="${c.id}"]`).forEach((x) => { x.checked = e.target.checked; });
      contar();
    } });
    return h('label', { class: 'item' }, caixinha,
      h('span', { class: 'texto' }, h('strong', {}, c.orgao), ' — ' + c.nome,
        h('small', {}, (c.ufs ? `Abrange ${c.ufs.join(', ')} · ` : '') + c.url)),
      c.personalizado && h('button', { type: 'button', class: 'discreto perigo', onclick: async (e) => { e.preventDefault(); await api('DELETE', '/api/catalogo/' + c.id); await carregarCatalogo(); } }, 'Remover'));
  }

  function desenharCatalogo() {
    const tipo = tipoAtual();
    const nat = $('#filtro-natureza').value;
    const uf = $('#filtro-uf').value;
    const termos = semAcento($('#filtro-texto').value).split(/\s+/).filter(Boolean);
    const visiveis = catalogo.filter((c) => {
      if (!c.pessoas.includes(tipo) || (nat && !c.natureza.includes(nat))) return false;
      const texto = semAcento([c.orgao, c.nome, c.rotulo, ...ufsDe(c), ...ufsDe(c).map((u) => ESTADOS[u])].join(' '));
      return termos.every((t) => texto.includes(t));
    });
    // Uma certidão que deixou de valer para o tipo de pessoa não pode seguir marcada.
    for (const id of [...marcados]) if (!catalogo.some((c) => c.id === id && c.pessoas.includes(tipo))) marcados.delete(id);

    const grupos = [['', 'Âmbito nacional', visiveis.filter((c) => !ufsDe(c).length)]];
    for (const sigla of Object.keys(ESTADOS).sort((x, y) => ESTADOS[x].localeCompare(ESTADOS[y], 'pt-BR'))) {
      grupos.push([sigla, `${ESTADOS[sigla]} (${sigla})`, visiveis.filter((c) => ufsDe(c).includes(sigla))]);
    }
    const caixa = $('#catalogo');
    caixa.replaceChildren();
    for (const [sigla, titulo, itens] of grupos) {
      if (!itens.length || (uf && sigla && sigla !== uf)) continue;
      // Dentro do estado: na ordem das esferas.
      itens.sort((x, y) => Object.keys(ESFERAS).indexOf(x.esfera) - Object.keys(ESFERAS).indexOf(y.esfera));
      const aberto = Boolean(termos.length) || (uf ? sigla === uf : abertos.has(sigla));
      const selecionadas = itens.filter((c) => marcados.has(c.id)).length;
      const bloco = h('details', { class: 'grupo', open: aberto, ontoggle: (e) => { if (termos.length || uf) return; e.target.open ? abertos.add(sigla) : abertos.delete(sigla); } },
        h('summary', { class: 'grupo-titulo' }, titulo, h('span', { class: 'qtd' }, `${itens.length} ${itens.length === 1 ? 'certidão' : 'certidões'}`)),
        h('div', { class: 'grupo-acoes' },
          h('button', { type: 'button', class: 'discreto', onclick: () => { itens.forEach((c) => marcados.add(c.id)); abertos.add(sigla); desenharCatalogo(); } }, 'Marcar todas'),
          selecionadas > 0 && h('button', { type: 'button', class: 'discreto', onclick: () => { itens.forEach((c) => marcados.delete(c.id)); abertos.add(sigla); desenharCatalogo(); } }, 'Desmarcar')));
      let esfera = null;
      for (const c of itens) {
        if (c.esfera !== esfera) { esfera = c.esfera; bloco.append(h('div', { class: 'subgrupo' }, ESFERAS[esfera] || esfera)); }
        bloco.append(linhaCertidao(c));
      }
      caixa.append(bloco);
    }
    if (!caixa.children.length) caixa.append(h('p', { class: 'vazio' }, 'Nenhuma certidão para esta busca. Cadastre o portal abaixo.'));
    contar();
  }
  const contar = () => { $('#contagem').textContent = marcados.size ? `${marcados.size} selecionada(s)` : ''; };

  async function carregarCatalogo() {
    catalogo = await (await api('GET', '/api/catalogo')).json();
    const ufs = [...new Set(catalogo.flatMap(ufsDe))].sort();
    const sel = $('#filtro-uf');
    const atual = sel.value;
    sel.replaceChildren(h('option', { value: '' }, 'Todos'), ...ufs.map((u) => h('option', { value: u }, `${u} — ${ESTADOS[u] || u}`)));
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
  $('#filtro-texto').addEventListener('input', desenharCatalogo);

  $('#form-pedido').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#pedido-erro');
    erro.textContent = '';
    const f = new FormData(e.target);
    const pessoa = Object.fromEntries(f.entries());
    try {
      await api('POST', '/api/pedidos', { pessoa, certidoes: [...marcados] });
      const tipo = tipoAtual();
      e.target.reset(); // os dados do pesquisado não ficam na tela
      document.querySelector(`input[name=tipo][value=${tipo}]`).checked = true;
      marcados.clear();
      desenharCatalogo();
      await atualizar();
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

  // ---------- Pedidos e certidões guardadas ----------
  const ROTULOS = { fila: 'Na fila', executando: 'Em andamento', concluido: 'Concluído', erro: 'Não concluído', cancelado: 'Cancelado' };
  const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  async function baixar(a, abrir) {
    const blob = await (await api('GET', `/api/arquivos/${a.id}`)).blob();
    const url = URL.createObjectURL(blob);
    if (abrir) window.open(url, '_blank', 'noopener');
    else h('a', { href: url, download: a.nomeArquivo }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function acao(texto, fn, classe = 'discreto') {
    return h('button', { type: 'button', class: classe, onclick: async (e) => {
      e.target.disabled = true;
      try { await fn(); ultimo = ''; await atualizar(); await carregarUsuarios(); } catch (ex) { alert(ex.message); } finally { e.target.disabled = false; }
    } }, texto);
  }

  function cartaoPedido(p) {
    const botoes = [];
    if (p.status === 'executando') botoes.push(acao('Salvar a página aberta como certidão', () => api('POST', `/api/pedidos/${p.id}/capturar`)));
    if (p.status === 'executando' || p.status === 'fila') botoes.push(acao('Cancelar', () => api('POST', `/api/pedidos/${p.id}/cancelar`)));
    else botoes.push(acao('Dispensar', () => api('DELETE', `/api/pedidos/${p.id}`)));
    return h('article', { class: 'pedido ' + p.status },
      h('div', { class: 'pedido-topo' },
        h('div', {}, h('strong', {}, p.orgao), ' — ' + p.certidao),
        h('span', { class: 'selo ' + p.status }, ROTULOS[p.status])),
      h('p', {}, `${p.pessoa} · pedido em ${quando(p.criadoEm)}`),
      h('p', { class: 'msg' }, p.mensagem),
      h('div', { class: 'acoes' }, ...botoes));
  }

  function cartaoArquivo(a) {
    const dias = Math.max(0, Math.ceil((new Date(a.expiraEm) - Date.now()) / 86400000));
    return h('article', { class: 'pedido' },
      h('div', { class: 'pedido-topo' },
        h('div', {}, h('strong', {}, a.nomeArquivo)),
        h('span', { class: 'selo ' + (dias <= 1 ? 'erro' : 'fila') }, dias <= 1 ? 'Apaga em menos de 1 dia' : `Apaga em ${dias} dias`)),
      h('p', {}, `${a.orgao} — ${a.certidao} · emitida em ${quando(a.criadoEm)}${eu.perfil === 'admin' ? ' · por ' + a.dono : ''}`),
      a.origem === 'captura-de-pagina' && h('p', { class: 'alerta' }, 'Arquivo gerado por captura da página exibida, não pelo PDF do portal. Confira o conteúdo antes de usar.'),
      h('p', {}, `SHA-256 ${a.sha256} · ${(a.tamanho / 1024).toFixed(0)} KB`),
      h('div', { class: 'acoes' },
        acao('Abrir', () => baixar(a, true)), acao('Baixar', () => baixar(a, false)),
        acao('Excluir agora', async () => { if (confirm('Excluir esta certidão em definitivo?')) await api('DELETE', `/api/arquivos/${a.id}`); }, 'discreto perigo')));
  }

  async function atualizar() {
    const [pedidos, arquivos] = await Promise.all([api('GET', '/api/pedidos').then((r) => r.json()), api('GET', '/api/arquivos').then((r) => r.json())]);
    const assinatura = JSON.stringify([pedidos, arquivos]);
    if (assinatura === ultimo) return; // evita redesenhar (e perder o foco) sem mudança
    ultimo = assinatura;
    $('#pedidos').replaceChildren(...(pedidos.length ? pedidos.map(cartaoPedido) : [h('p', { class: 'vazio' }, 'Nenhum pedido nesta sessão.')]));
    $('#arquivos').replaceChildren(...(arquivos.length ? arquivos.map(cartaoArquivo) : [h('p', { class: 'vazio' }, 'Nenhuma certidão guardada.')]));
  }

  async function abrirApp(usuario) {
    eu = usuario;
    $('#tela-login').hidden = true;
    $('#tela-app').hidden = false;
    $('#barra-usuario').hidden = false;
    $('#quem').textContent = `${eu.nome} (${eu.perfil === 'admin' ? 'administrador' : 'operador'})`;
    $('#painel-usuarios').hidden = eu.perfil !== 'admin';
    ultimo = '';
    await carregarCatalogo();
    ajustarTipo();
    await carregarUsuarios();
    await atualizar();
    clearInterval(relogio);
    relogio = setInterval(() => atualizar().catch(() => {}), 2000);
  }

  (async () => {
    const estado = await (await fetch('/api/estado', { headers: { 'X-Sessao': sessao } })).json();
    document.querySelectorAll('.dias').forEach((el) => { el.textContent = estado.diasRetencao; });
    if (estado.usuario) await abrirApp(estado.usuario); else mostrarLogin(estado.configurado);
  })();
})();
