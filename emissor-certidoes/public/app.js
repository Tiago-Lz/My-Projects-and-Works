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

  const PUBLICAS = ['/api/entrar', '/api/configurar', '/api/contas', '/api/convites/usar', '/api/senha'];
  async function api(metodo, rota, corpo) {
    const r = await fetch(rota, {
      method: metodo,
      headers: { 'X-Sessao': sessao, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401 && !PUBLICAS.includes(rota)) { mostrarLogin(); throw new Error('Sessão encerrada. Faça login novamente.'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || 'Falha na operação.');
    return r;
  }

  const reais = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dia = (iso) => new Date(iso).toLocaleDateString('pt-BR');
  const PERFIS = { dono: 'responsável pelo sistema', admin: 'administrador', usuario: 'usuário' };

  // ---------- Entrada: login, novo escritório ou chave de convite ----------
  const MODOS = {
    entrar: { titulo: 'Entrar', texto: '', rota: '/api/entrar', botao: 'Entrar', campos: [] },
    escritorio: { titulo: 'Cadastrar escritório', texto: 'Cria a conta do escritório e o seu acesso de administrador. Depois você convida os demais usuários.', rota: '/api/contas', botao: 'Criar conta', campos: ['escritorio', 'nome', 'senha2'] },
    convite: { titulo: 'Entrar com chave de convite', texto: 'Use a chave gerada pelo administrador do seu escritório.', rota: '/api/convites/usar', botao: 'Criar meu acesso', campos: ['chave', 'nome', 'senha2'] },
    configurar: { titulo: 'Primeiro acesso', texto: 'Crie a conta do responsável pelo sistema. Ela gerencia escritórios, valores e mensalidades.', rota: '/api/configurar', botao: 'Criar conta', campos: ['nome', 'senha2'] },
  };
  let modo = 'entrar';
  let configurado = true;

  function definirModo(novo) {
    modo = novo;
    const m = MODOS[modo];
    $('#login-titulo').textContent = m.titulo;
    $('#login-texto').textContent = m.texto;
    $('#login-botao').textContent = m.botao;
    document.querySelectorAll('#form-login [data-campo]').forEach((el) => {
      const ativo = m.campos.includes(el.dataset.campo);
      el.hidden = !ativo;
      el.querySelector('input').required = ativo;
    });
    $('#login-modos').hidden = !configurado;
    document.querySelectorAll('#login-modos button').forEach((b) => { b.hidden = b.dataset.modo === modo; });
    $('#login-erro').textContent = '';
  }
  document.querySelectorAll('#login-modos button').forEach((b) => b.addEventListener('click', () => definirModo(b.dataset.modo)));

  function mostrarLogin() {
    clearInterval(relogio);
    sessao = '';
    eu = null;
    sessionStorage.removeItem('sessao');
    $('#tela-app').hidden = true;
    $('#tela-dono').hidden = true;
    $('#barra-usuario').hidden = true;
    $('#tela-login').hidden = false;
    $('#form-login').reset();
    definirModo(configurado ? 'entrar' : 'configurar');
    $('#login-usuario').focus();
  }

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#login-erro');
    erro.textContent = '';
    const f = Object.fromEntries(new FormData(e.target).entries());
    if (MODOS[modo].campos.includes('senha2') && f.senha !== f.senha2) { erro.textContent = 'As senhas não conferem.'; return; }
    try {
      const r = await (await api('POST', MODOS[modo].rota, f)).json();
      sessao = r.sessao;
      sessionStorage.setItem('sessao', sessao);
      configurado = true;
      e.target.reset();
      await abrir(r.usuario);
    } catch (ex) { erro.textContent = ex.message; }
  });

  $('#btn-sair').addEventListener('click', async () => {
    await api('POST', '/api/sair').catch(() => {});
    mostrarLogin();
  });

  document.querySelectorAll('.form-senha').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = form.querySelector('.senha-msg');
    msg.textContent = '';
    const f = Object.fromEntries(new FormData(form).entries());
    if (f.nova !== f.nova2) { msg.textContent = 'As senhas não conferem.'; return; }
    try {
      await api('POST', '/api/senha', { atual: f.atual, nova: f.nova });
      form.reset();
      msg.textContent = 'Senha alterada.';
    } catch (ex) { msg.textContent = ex.message; }
  }));

  // ---------- Conta do escritório (administrador e usuários) ----------
  async function carregarConta() {
    if (!eu || eu.perfil === 'dono') return;
    const c = await (await api('GET', '/api/conta')).json();
    const aviso = c.situacao === 'em dia' ? '' : c.situacao === 'vencida' ? 'Mensalidade vencida: a emissão está bloqueada até a regularização.' : 'Conta suspensa: a emissão está bloqueada.';
    $('#aviso-conta').textContent = aviso;
    $('#aviso-conta').hidden = !aviso;
    const linhas = [
      `${c.nome} · situação: ${c.situacao} · ${c.situacao === 'em dia' ? 'válida até' : 'venceu em'} ${dia(c.vence_em)}`,
      `Certidões neste mês: ${c.certidoes_no_mes} de ${c.limite_certidoes_mes}`,
    ];
    const admin = eu.perfil === 'admin';
    if (admin) linhas.push(`Mensalidade: ${reais(c.valor_mensal_centavos)} · usuários: ${c.usuarios_ativos} de ${c.limite_usuarios}${c.convites_pendentes ? ` · ${c.convites_pendentes} convite(s) aguardando uso` : ''}`);
    $('#conta-resumo').replaceChildren(...linhas.map((t) => h('p', {}, t)));
    $('#painel-equipe').hidden = !admin;
    if (!admin) return;
    $('#usuarios').replaceChildren(...c.usuarios.map((u) => h('div', { class: 'linha-usuario' },
      h('span', { class: 'texto' }, h('strong', {}, u.nome), ` · ${u.usuario} · ${PERFIS[u.perfil]}${u.ativo ? '' : ' · desativado'}`),
      u.perfil === 'usuario' && acao('Redefinir senha', async () => {
        const senha = prompt(`Nova senha para ${u.usuario} (mínimo 8 caracteres):`);
        if (senha) await api('POST', `/api/conta/usuarios/${u.id}/senha`, { senha });
      }),
      u.perfil === 'usuario' && acao(u.ativo ? 'Desativar' : 'Reativar', () => api('POST', `/api/conta/usuarios/${u.id}/ativo`, { ativo: !u.ativo }), 'discreto' + (u.ativo ? ' perigo' : '')))));
    $('#pagamentos').replaceChildren(...(c.pagamentos.length
      ? c.pagamentos.map((p) => h('p', {}, `${dia(p.registrado_em)} · ${reais(p.valor_centavos)}`))
      : [h('p', { class: 'apoio' }, 'Nenhum pagamento registrado ainda.')]));
  }

  $('#btn-convite').addEventListener('click', async () => {
    const caixa = $('#convite-gerado');
    try {
      const r = await (await api('POST', '/api/conta/convites')).json();
      caixa.replaceChildren(h('p', {}, 'Chave de convite (uso único, válida até ' + dia(r.expiraEm) + '). Ela não será exibida de novo:'), h('code', {}, r.chave));
      await carregarConta();
    } catch (ex) { caixa.replaceChildren(h('p', { class: 'erro' }, ex.message)); }
  });

  // ---------- Painel do dono do sistema ----------
  const numero = (v) => Number(String(v).replace(',', '.'));
  async function carregarDono() {
    const r = await (await api('GET', '/api/dono/resumo')).json();
    const t = r.totais;
    $('#dono-totais').replaceChildren(...[
      ['Escritórios', t.contas], ['Em dia', t.em_dia], ['Vencidos', t.vencidas], ['Suspensos', t.suspensas], ['Usuários ativos', t.usuarios],
      ['Certidões no mês', t.certidoes_no_mes], ['Receita mensal prevista', reais(t.receita_mensal_prevista_centavos)], ['Recebido no mês', reais(t.recebido_no_mes_centavos)],
    ].map(([rotulo, valor]) => h('div', { class: 'indicador' }, h('strong', {}, String(valor)), h('span', {}, rotulo))));

    const f = $('#form-config');
    if (document.activeElement?.form !== f) {
      f.valor.value = (r.config.valor_mensal_centavos / 100).toFixed(2);
      f.usuarios.value = r.config.limite_usuarios;
      f.certidoes.value = r.config.limite_certidoes_mes;
      f.teste.value = r.config.dias_teste;
    }

    $('#dono-contas').replaceChildren(...(r.contas.length ? r.contas.map((c) => {
      const campo = (rotulo, nome, valor, tipo = 'number') => h('label', {}, rotulo, h('input', { name: nome, type: tipo, value: valor, min: 0, step: nome === 'valor' ? '0.01' : '1', required: true }));
      const form = h('form', { class: 'grade', onsubmit: async (e) => {
        e.preventDefault();
        const d = e.target;
        try {
          await api('POST', `/api/dono/contas/${c.id}`, { valor_mensal_centavos: Math.round(numero(d.valor.value) * 100), limite_usuarios: Number(d.usuarios.value), limite_certidoes_mes: Number(d.certidoes.value), vence_em: d.vence.value + 'T23:59:59' });
          await carregarDono();
        } catch (ex) { alert(ex.message); }
      } },
        campo('Mensalidade (R$)', 'valor', (c.valor_mensal_centavos / 100).toFixed(2)),
        campo('Limite de usuários', 'usuarios', c.limite_usuarios),
        campo('Certidões por mês', 'certidoes', c.limite_certidoes_mes),
        campo('Vencimento', 'vence', c.vence_em.slice(0, 10), 'date'),
        h('button', { type: 'submit', class: 'secundario' }, 'Salvar alterações'));
      return h('details', { class: 'conta', open: abertasDono.has(c.id), ontoggle: (e) => { e.target.open ? abertasDono.add(c.id) : abertasDono.delete(c.id); } },
        h('summary', {}, c.nome, h('span', { class: 'selo ' + ({ 'em dia': 'concluido', vencida: 'erro', suspensa: 'cancelado' })[c.situacao] }, c.situacao)),
        h('p', { class: 'apoio' }, `${reais(c.valor_mensal_centavos)}/mês · ${c.usuarios_ativos} de ${c.limite_usuarios} usuários · ${c.certidoes_no_mes} de ${c.limite_certidoes_mes} certidões neste mês · ${c.vencida ? 'venceu em' : 'vence em'} ${dia(c.vence_em)} · cliente desde ${dia(c.criado_em)}`),
        form,
        h('div', { class: 'acoes' },
          acao(`Registrar pagamento de ${reais(c.valor_mensal_centavos)}`, () => api('POST', `/api/dono/contas/${c.id}/pagamentos`, {})),
          acao(c.status === 'suspensa' ? 'Reativar conta' : 'Suspender conta', () => api('POST', `/api/dono/contas/${c.id}`, { status: c.status === 'suspensa' ? 'ativa' : 'suspensa' }), 'discreto' + (c.status === 'suspensa' ? '' : ' perigo'))),
        h('h3', {}, 'Usuários'),
        ...c.usuarios.map((u) => h('p', {}, `${u.nome} · ${u.usuario} · ${PERFIS[u.perfil]}${u.ativo ? '' : ' · desativado'} · desde ${dia(u.criado_em)}`)),
        h('h3', {}, 'Pagamentos'),
        ...(c.pagamentos.length ? c.pagamentos.map((p) => h('p', {}, `${dia(p.registrado_em)} · ${reais(p.valor_centavos)}`)) : [h('p', { class: 'apoio' }, 'Nenhum pagamento registrado.')]));
    }) : [h('p', { class: 'vazio' }, 'Nenhum escritório cadastrado ainda.')]));
  }
  const abertasDono = new Set();

  $('#form-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = e.target;
    const msg = $('#config-msg');
    try {
      await api('POST', '/api/dono/config', { valor_mensal_centavos: Math.round(numero(d.valor.value) * 100), limite_usuarios: Number(d.usuarios.value), limite_certidoes_mes: Number(d.certidoes.value), dias_teste: Number(d.teste.value) });
      msg.textContent = 'Padrões salvos. Valem para os próximos escritórios cadastrados.';
    } catch (ex) { msg.textContent = ex.message; }
  });

  // ---------- Catálogo ----------
  const ESFERAS = { federal: 'Justiça Federal', estadual: 'Justiça Estadual', trabalho: 'Justiça do Trabalho', superior: 'Tribunais superiores', mp: 'Ministério Público', policia: 'Polícia', fiscal: 'Fazenda e dívida ativa', controle: 'Órgãos de controle', registro: 'Juntas comerciais e protestos' };
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
        h('small', {}, (c.ufs ? `Abrange ${c.ufs.join(', ')} · ` : '') + c.url),
        c.conferir && h('small', { class: 'alerta' }, 'Abre o site do órgão: navegue até o formulário da certidão e o sistema preenche e envia.')),
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
      await carregarConta();
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
      try { await fn(); if (eu.perfil === 'dono') await carregarDono(); else { ultimo = ''; await atualizar(); await carregarConta(); } } catch (ex) { alert(ex.message); } finally { e.target.disabled = false; }
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

  async function abrir(usuario) {
    eu = usuario;
    clearInterval(relogio);
    $('#tela-login').hidden = true;
    $('#barra-usuario').hidden = false;
    $('#quem').textContent = `${eu.nome} (${PERFIS[eu.perfil]})`;
    const dono = eu.perfil === 'dono';
    $('#tela-dono').hidden = !dono;
    $('#tela-app').hidden = dono;
    if (dono) return carregarDono();
    ultimo = '';
    await carregarCatalogo();
    ajustarTipo();
    await carregarConta();
    await atualizar();
    let voltas = 0;
    relogio = setInterval(() => { atualizar().catch(() => {}); if (++voltas % 15 === 0) carregarConta().catch(() => {}); }, 2000);
  }

  (async () => {
    const estado = await (await fetch('/api/estado', { headers: { 'X-Sessao': sessao } })).json();
    configurado = estado.configurado;
    document.querySelectorAll('.dias').forEach((el) => { el.textContent = estado.diasRetencao; });
    if (estado.usuario) await abrir(estado.usuario); else mostrarLogin();
  })();
})();
