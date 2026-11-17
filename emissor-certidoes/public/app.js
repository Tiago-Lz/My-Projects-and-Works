'use strict';
(() => {
  const $ = (s, raiz = document) => raiz.querySelector(s);
  const $$ = (s, raiz = document) => [...raiz.querySelectorAll(s)];
  let sessao = sessionStorage.getItem('sessao') || '';
  let eu = null;
  let catalogo = [];
  let ultimo = '';
  let relogio = null;
  const marcados = new Set();

  // Cria elementos sem innerHTML: dados do usuário e dos portais nunca viram HTML.
  function h(tag, props = {}, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // via CSSOM: permitido pela política de segurança
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...filhos.flat().filter((f) => f != null && f !== false));
    return el;
  }

  async function api(metodo, rota, corpo) {
    const r = await fetch(rota, {
      method: metodo,
      headers: { 'X-Sessao': sessao, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const publica = rota === '/api/entrar' || rota.startsWith('/api/cadastro/') || rota === '/api/senha';
    if (r.status === 401 && !publica) { sair(true); throw new Error('Sessão encerrada. Entre novamente.'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || 'Não foi possível concluir a operação.');
    return r;
  }

  let avisoTimer;
  function avisar(texto, erro = false) {
    const t = $('#aviso');
    t.textContent = texto;
    t.className = 'toast' + (erro ? ' erro' : '');
    t.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dia = (iso) => new Date(iso).toLocaleDateString('pt-BR');
  const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const iniciais = (nome) => String(nome).split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const PAPEL = { dono: 'Administrador do sistema', admin: 'Administrador do escritório', usuario: 'Usuário' };
  const SITUACAO = { 'em dia': ['Em dia', 'ok'], vencida: ['Mensalidade vencida', 'erro'], suspensa: ['Suspensa', 'erro'] };

  // Mostrar/ocultar senha
  $$('.ver-senha').forEach((b) => b.addEventListener('click', () => {
    const i = b.previousElementSibling;
    i.type = i.type === 'password' ? 'text' : 'password';
    b.setAttribute('aria-label', i.type === 'password' ? 'Mostrar senha' : 'Ocultar senha');
  }));

  // Botões que mostram estado de carregamento enquanto a ação roda.
  async function ocupado(botao, fn) {
    const texto = botao.textContent;
    botao.disabled = true;
    try { return await fn(); } finally { botao.disabled = false; botao.textContent = texto; }
  }

  // ======================= Rotas =======================
  const PAGINAS = {
    emitir: { titulo: 'Emitir certidões', sub: 'Informe o pesquisado, escolha as certidões e o sistema faz o pedido em cada portal.', para: 'cliente' },
    certidoes: { titulo: 'Minhas certidões', sub: 'Certidões emitidas, prontas para abrir ou baixar.', para: 'cliente' },
    conta: { titulo: 'Minha conta', sub: 'Seus dados, o plano do escritório e a equipe.', para: 'cliente' },
    painel: { titulo: 'Painel', sub: 'Escritórios, uso e mensalidades.', para: 'dono' },
    configuracoes: { titulo: 'Configurações', sub: 'Valores padrão, envio de e-mail e segurança.', para: 'dono' },
  };
  const paginaInicial = () => (eu && eu.perfil === 'dono' ? 'painel' : 'emitir');

  function ir(caminho, substituir = false) {
    if (location.pathname !== caminho) history[substituir ? 'replaceState' : 'pushState']({}, '', caminho);
    rotear();
  }
  window.addEventListener('popstate', rotear);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-rota]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    ir(a.getAttribute('href'));
  });

  function rotear() {
    const nome = location.pathname.replace(/^\/+|\/+$/g, '') || '';
    if (!eu) {
      if (nome !== 'cadastro') { if (nome !== 'entrar') history.replaceState({}, '', '/entrar'); mostrarAuth('entrar'); }
      else mostrarAuth('cadastro');
      return;
    }
    const pg = PAGINAS[nome];
    const permitida = pg && (pg.para === 'dono') === (eu.perfil === 'dono');
    if (!permitida) return ir('/' + paginaInicial(), true);
    $('#tela-auth').hidden = true;
    $('#tela-app').hidden = false;
    $$('.pagina').forEach((s) => { s.hidden = s.dataset.pagina !== nome; });
    $$('.lateral nav a').forEach((a) => a.classList.toggle('ativo', a.getAttribute('href') === '/' + nome));
    $('#titulo-pagina').textContent = pg.titulo;
    $('#subtitulo-pagina').textContent = pg.sub;
    document.title = `${pg.titulo} · Emissor de Certidões`;
    window.scrollTo(0, 0);
    ({ painel: carregarDono, configuracoes: carregarConfig, conta: carregarConta, certidoes: atualizar, emitir: atualizar })[nome]().catch((e) => avisar(e.message, true));
  }

  // ======================= Entrar =======================
  function mostrarAuth(qual) {
    $('#tela-app').hidden = true;
    $('#tela-auth').hidden = false;
    $('#vista-entrar').hidden = qual !== 'entrar';
    $('#vista-cadastro').hidden = qual !== 'cadastro';
    document.title = (qual === 'entrar' ? 'Entrar' : 'Criar conta') + ' · Emissor de Certidões';
    if (qual === 'cadastro' && !cad.id) etapa(1);
    setTimeout(() => $(qual === 'entrar' ? '#form-entrar [name=usuario]' : '#vista-cadastro .etapa:not([hidden]) input:not([type=radio])')?.focus(), 0);
  }

  $('#form-entrar').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const erro = $('.erro', f);
    erro.textContent = '';
    if (!f.usuario.value.trim() || !f.senha.value) { erro.textContent = 'Informe e-mail e senha.'; return; }
    await ocupado($('[type=submit]', f), async () => {
      try {
        const r = await (await api('POST', '/api/entrar', { usuario: f.usuario.value, senha: f.senha.value })).json();
        f.reset();
        entrou(r);
      } catch (ex) { erro.textContent = ex.message; }
    });
  });

  function entrou(r) {
    sessao = r.sessao;
    sessionStorage.setItem('sessao', sessao);
    abrirApp(r.usuario);
    ir('/' + paginaInicial(), true);
  }

  async function sair(expirou = false) {
    if (!expirou) await api('POST', '/api/sair').catch(() => {});
    clearInterval(relogio);
    sessao = '';
    eu = null;
    sessionStorage.removeItem('sessao');
    ultimo = '';
    marcados.clear();
    // Nada da sessão anterior pode aparecer para quem entrar em seguida.
    $('#selo-conta').hidden = true;
    $('#aviso-conta').hidden = true;
    ['#pedidos', '#arquivos', '#usuarios', '#convite-gerado', '#pagamentos', '#dono-contas', '#dono-totais'].forEach((id) => $(id).replaceChildren());
    $('#nav-qtd').hidden = true;
    ir('/entrar', true);
    if (expirou) avisar('Sua sessão terminou. Entre novamente.');
  }
  $('#btn-sair').addEventListener('click', () => sair());

  // ======================= Cadastro em etapas =======================
  const cad = { id: '', tipo: 'escritorio', reenvioEm: 0 };
  let reenvioTimer;

  function etapa(n) {
    $$('#vista-cadastro .etapa').forEach((f) => { f.hidden = Number(f.dataset.etapa) !== n; });
    $$('.etapas li').forEach((li) => {
      const k = Number(li.dataset.etapa);
      li.classList.toggle('feita', k < n);
      li.classList.toggle('atual', k === n);
    });
    $$('#vista-cadastro .erro').forEach((e) => { e.textContent = ''; });
    const primeiro = $(`#cad-${n} input:not([type=radio]):not([hidden])`);
    setTimeout(() => (n === 3 ? $('.codigo input') : primeiro)?.focus(), 0);
  }
  $$('[data-voltar]').forEach((b) => b.addEventListener('click', () => { cad.id = ''; etapa(1); }));

  $('#cad-1').addEventListener('submit', (e) => {
    e.preventDefault();
    cad.tipo = e.target.tipo.value;
    $$('.so-convite').forEach((el) => { el.hidden = cad.tipo !== 'convite'; });
    $$('.so-escritorio').forEach((el) => { el.hidden = cad.tipo !== 'escritorio'; });
    etapa(2);
  });

  // Chave: maiúsculas e hífens automáticos (XXXXX-XXXXX-XXXXX-XXXXX).
  $('#cad-2 [name=chave]').addEventListener('input', (e) => {
    const limpo = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    e.target.value = limpo.match(/.{1,5}/g)?.join('-') || '';
  });

  $('#cad-2').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const erro = $('.erro', f);
    erro.textContent = '';
    const dados = { tipo: cad.tipo, nome: f.nome.value, email: f.email.value, escritorio: f.escritorio.value, chave: f.chave.value };
    if (cad.tipo === 'convite' && dados.chave.length !== 23) { erro.textContent = 'Informe a chave de convite completa.'; return; }
    await ocupado($('[type=submit]', f), async () => {
      try {
        const r = await (await api('POST', '/api/cadastro/iniciar', dados)).json();
        cad.id = r.id;
        cad.nome = dados.nome.trim();
        cad.conta = r.conta || dados.escritorio.trim();
        $('#cad-email').textContent = r.email;
        $('#cad-console').hidden = r.modoEnvio !== 'console';
        $$('.codigo input').forEach((i) => { i.value = ''; });
        iniciarReenvio();
        etapa(3);
      } catch (ex) { erro.textContent = ex.message; }
    });
  });

  // Caixas do código: avança sozinho, aceita colar os 6 dígitos de uma vez.
  const caixas = $$('.codigo input');
  caixas.forEach((c, i) => {
    c.addEventListener('input', () => {
      const d = c.value.replace(/\D/g, '');
      if (d.length > 1) { colar(d, i); return; }
      c.value = d;
      if (d && i < 5) caixas[i + 1].focus();
      if (caixas.every((x) => x.value)) $('#cad-3').requestSubmit();
    });
    c.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !c.value && i > 0) caixas[i - 1].focus(); });
    c.addEventListener('paste', (e) => { e.preventDefault(); colar((e.clipboardData.getData('text') || '').replace(/\D/g, ''), i); });
  });
  function colar(digitos, de) {
    [...digitos].slice(0, 6 - de).forEach((d, k) => { caixas[de + k].value = d; });
    caixas[Math.min(de + digitos.length, 5)].focus();
    if (caixas.every((x) => x.value)) $('#cad-3').requestSubmit();
  }

  $('#cad-3').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('.erro', e.target);
    erro.textContent = '';
    const codigo = caixas.map((c) => c.value).join('');
    if (codigo.length !== 6) { erro.textContent = 'Digite os 6 dígitos.'; return; }
    await ocupado($('[type=submit]', e.target), async () => {
      try {
        await api('POST', '/api/cadastro/verificar', { id: cad.id, codigo });
        $('#cad-resumo').textContent = cad.tipo === 'convite' ? `Você vai entrar na conta de ${cad.conta}.` : `Último passo para criar a conta de ${cad.conta}.`;
        etapa(4);
      } catch (ex) {
        erro.textContent = ex.message;
        caixas.forEach((c) => { c.value = ''; });
        caixas[0].focus();
        if (/expirado|Recomece/.test(ex.message)) { cad.id = ''; setTimeout(() => etapa(1), 1500); }
      }
    });
  });

  function iniciarReenvio() {
    cad.reenvioEm = Date.now() + 30000;
    clearInterval(reenvioTimer);
    const b = $('#cad-reenviar');
    const tique = () => {
      const s = Math.ceil((cad.reenvioEm - Date.now()) / 1000);
      b.disabled = s > 0;
      b.textContent = s > 0 ? `Reenviar código (${s}s)` : 'Reenviar código';
      if (s <= 0) clearInterval(reenvioTimer);
    };
    tique();
    reenvioTimer = setInterval(tique, 500);
  }
  $('#cad-reenviar').addEventListener('click', async () => {
    const erro = $('#cad-3 .erro');
    try {
      const r = await (await api('POST', '/api/cadastro/reenviar', { id: cad.id })).json();
      $('#cad-console').hidden = r.modoEnvio !== 'console';
      iniciarReenvio();
      avisar('Enviamos um novo código.');
    } catch (ex) { erro.textContent = ex.message; }
  });

  // Regras da senha, conferidas enquanto a pessoa digita.
  const REGRAS = {
    tamanho: (s) => s.length >= 8,
    letra: (s) => /[A-Za-zÀ-ÿ]/.test(s),
    numero: (s) => /\d/.test(s),
    simbolo: (s) => /[^A-Za-zÀ-ÿ0-9]/.test(s),
  };
  const senhaForte = (s) => Object.values(REGRAS).every((r) => r(s));
  $('#cad-4 [name=senha]').addEventListener('input', (e) => {
    for (const [nome, regra] of Object.entries(REGRAS)) $(`#regras-senha [data-regra=${nome}]`).classList.toggle('ok', regra(e.target.value));
  });

  $('#cad-4').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const erro = $('.erro', f);
    erro.textContent = '';
    if (!senhaForte(f.senha.value)) { erro.textContent = 'A senha ainda não atende a todas as regras.'; return; }
    if (f.senha.value !== f.senha2.value) { erro.textContent = 'As senhas não conferem.'; return; }
    await ocupado($('[type=submit]', f), async () => {
      try {
        const r = await (await api('POST', '/api/cadastro/concluir', { id: cad.id, senha: f.senha.value })).json();
        $$('#vista-cadastro form').forEach((x) => x.reset());
        $$('#regras-senha li').forEach((li) => li.classList.remove('ok'));
        cad.id = '';
        entrou(r);
        avisar('Conta criada. Bem-vindo!');
      } catch (ex) { erro.textContent = ex.message; }
    });
  });

  // ======================= Aplicação =======================
  function abrirApp(usuario) {
    eu = usuario;
    const dono = eu.perfil === 'dono';
    $$('.lateral nav a').forEach((a) => { a.hidden = (a.dataset.para === 'dono') !== dono; });
    $('#quem-nome').textContent = eu.nome;
    $('#quem-papel').textContent = PAPEL[eu.perfil];
    $('#avatar').textContent = iniciais(eu.nome);
    clearInterval(relogio);
    if (dono) return;
    carregarCatalogo().then(ajustarTipo).catch((e) => avisar(e.message, true));
    carregarConta().catch(() => {});
    let voltas = 0;
    relogio = setInterval(() => {
      if (!eu) return;
      atualizar().catch(() => {});
      if (++voltas % 15 === 0) carregarConta().catch(() => {});
    }, 2000);
  }

  // Senha (cliente e dono)
  $$('.form-senha').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('.senha-msg', form);
    msg.textContent = '';
    msg.classList.remove('ok');
    const f = Object.fromEntries(new FormData(form).entries());
    if (!senhaForte(f.nova)) { msg.textContent = 'A nova senha precisa ter 8 caracteres, uma letra, um número e um símbolo.'; return; }
    if (f.nova !== f.nova2) { msg.textContent = 'As senhas não conferem.'; return; }
    try {
      await api('POST', '/api/senha', { atual: f.atual, nova: f.nova });
      form.reset();
      msg.textContent = 'Senha alterada.';
      msg.classList.add('ok');
    } catch (ex) { msg.textContent = ex.message; }
  }));

  function acao(texto, fn, classe = '') {
    return h('button', { type: 'button', class: 'botao pequeno ' + classe, onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await fn();
        if (eu.perfil === 'dono') await carregarDono();
        else { ultimo = ''; await atualizar(); await carregarConta(); }
      } catch (ex) { avisar(ex.message, true); } finally { b.disabled = false; }
    } }, texto);
  }

  // ---------- Minha conta ----------
  function barraUso(rotulo, usado, limite) {
    const p = limite ? Math.min(100, Math.round((usado / limite) * 100)) : 100;
    return h('div', { class: 'uso' },
      h('div', { class: 'uso-topo' }, h('span', {}, rotulo), h('strong', {}, `${usado} de ${limite}`)),
      h('div', { class: 'uso-barra' }, h('span', { class: p >= 100 ? 'cheio' : '', style: `width:${p}%` })));
  }

  async function carregarConta() {
    if (!eu || eu.perfil === 'dono') return;
    const c = await (await api('GET', '/api/conta')).json();
    const [rotSit, clsSit] = SITUACAO[c.situacao] || [c.situacao, 'aviso'];
    const aviso = c.situacao === 'vencida' ? 'Mensalidade vencida: a emissão está bloqueada até a regularização.' : c.situacao === 'suspensa' ? 'Conta suspensa: a emissão está bloqueada.' : '';
    $('#aviso-conta').textContent = aviso;
    $('#aviso-conta').hidden = !aviso;
    $('#selo-conta').textContent = c.nome;
    $('#selo-conta').hidden = false;

    $('#perfil-avatar').textContent = iniciais(eu.nome);
    $('#perfil-nome').textContent = eu.nome;
    $('#perfil-email').textContent = eu.email || eu.usuario;
    $('#perfil-papel').textContent = PAPEL[eu.perfil];
    $('#perfil-escritorio').textContent = c.nome;

    const estado = $('#plano-estado');
    estado.textContent = rotSit;
    estado.className = 'estado ' + clsSit;
    const admin = eu.perfil === 'admin';
    const dados = [[c.situacao === 'vencida' ? 'Venceu em' : 'Válido até', dia(c.vence_em)]];
    if (admin) dados.push(['Mensalidade', reais(c.valor_mensal_centavos)]);
    $('#plano-dados').replaceChildren(...dados.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
    $('#plano-uso').replaceChildren(
      barraUso('Certidões neste mês', c.certidoes_no_mes, c.limite_certidoes_mes),
      admin && barraUso('Usuários', c.usuarios_ativos, c.limite_usuarios));

    $('#painel-equipe').hidden = !admin;
    $('#painel-pagamentos').hidden = !admin;
    if (!admin) return;
    $('#usuarios').replaceChildren(...c.usuarios.map((u) => h('div', { class: 'linha usuario' },
      h('span', { class: 'avatar' }, iniciais(u.nome)),
      h('div', { class: 'principal' }, h('strong', {}, u.nome), h('small', {}, u.email || u.usuario)),
      h('span', {}, h('span', { class: 'etiqueta ' + (u.ativo ? 'neutra' : 'erro') }, u.ativo ? PAPEL[u.perfil] : 'Desativado')),
      h('div', { class: 'acoes' },
        u.perfil === 'usuario' && acao('Redefinir senha', async () => {
          const senha = prompt(`Nova senha para ${u.nome} (8 caracteres, com letra, número e símbolo):`);
          if (senha) await api('POST', `/api/conta/usuarios/${u.id}/senha`, { senha });
        }),
        u.perfil === 'usuario' && acao(u.ativo ? 'Desativar' : 'Reativar', () => api('POST', `/api/conta/usuarios/${u.id}/ativo`, { ativo: !u.ativo }), u.ativo ? 'perigo' : '')))));
    $('#pagamentos').replaceChildren(...(c.pagamentos.length
      ? c.pagamentos.map((p) => h('p', {}, h('span', {}, dia(p.registrado_em)), h('strong', {}, reais(p.valor_centavos))))
      : [h('p', { class: 'apoio' }, 'Nenhum pagamento registrado ainda.')]));
  }

  $('#btn-convite').addEventListener('click', async (e) => {
    await ocupado(e.currentTarget, async () => {
      try {
        const r = await (await api('POST', '/api/conta/convites')).json();
        $('#convite-gerado').replaceChildren(h('div', { class: 'convite-caixa' },
          h('p', {}, 'Envie esta chave para a pessoa. Ela escolhe “Tenho uma chave de convite” ao criar a conta.'),
          h('code', {}, r.chave),
          h('p', {}, `Uso único, válida até ${dia(r.expiraEm)}. Ela não será exibida de novo.`),
          h('div', {}, h('button', { type: 'button', class: 'botao pequeno', onclick: () => navigator.clipboard?.writeText(r.chave).then(() => avisar('Chave copiada.')) }, 'Copiar chave'))));
        await carregarConta();
      } catch (ex) { avisar(ex.message, true); }
    });
  });

  // ---------- Painel do dono ----------
  const numero = (v) => Number(String(v).replace(',', '.'));
  const abertasDono = new Set();
  async function carregarDono() {
    const r = await (await api('GET', '/api/dono/resumo')).json();
    const t = r.totais;
    $('#dono-totais').replaceChildren(...[
      ['Escritórios', t.contas], ['Em dia', t.em_dia], ['Vencidos', t.vencidas], ['Suspensos', t.suspensas],
      ['Usuários ativos', t.usuarios], ['Certidões no mês', t.certidoes_no_mes], ['Receita mensal prevista', reais(t.receita_mensal_prevista_centavos)], ['Recebido no mês', reais(t.recebido_no_mes_centavos)],
    ].map(([rotulo, valor]) => h('div', { class: 'indicador' }, h('span', {}, rotulo), h('strong', {}, String(valor)))));

    $('#dono-contas').replaceChildren(...(r.contas.length ? r.contas.map((c) => {
      const [rotSit, clsSit] = SITUACAO[c.situacao] || [c.situacao, 'aviso'];
      const campo = (rotulo, nome, valor, tipo = 'number') => h('label', { class: 'campo' }, rotulo, h('input', { name: nome, type: tipo, value: valor, min: 0, step: nome === 'valor' ? '0.01' : '1' }));
      const form = h('form', { class: 'grade', onsubmit: async (e) => {
        e.preventDefault();
        const d = e.target;
        try {
          await api('POST', `/api/dono/contas/${c.id}`, { valor_mensal_centavos: Math.round(numero(d.valor.value) * 100), limite_usuarios: Number(d.usuarios.value), limite_certidoes_mes: Number(d.certidoes.value), vence_em: d.vence.value + 'T23:59:59' });
          avisar('Alterações salvas.');
          await carregarDono();
        } catch (ex) { avisar(ex.message, true); }
      } },
        campo('Mensalidade (R$)', 'valor', (c.valor_mensal_centavos / 100).toFixed(2)),
        campo('Limite de usuários', 'usuarios', c.limite_usuarios),
        campo('Certidões por mês', 'certidoes', c.limite_certidoes_mes),
        campo('Vencimento', 'vence', c.vence_em.slice(0, 10), 'date'),
        h('div', { class: 'col-2' }, h('button', { type: 'submit', class: 'botao primario' }, 'Salvar alterações')));
      return h('details', { class: 'conta', open: abertasDono.has(c.id), ontoggle: (e) => { e.target.open ? abertasDono.add(c.id) : abertasDono.delete(c.id); } },
        h('summary', {},
          h('div', {}, h('strong', {}, c.nome), h('small', {}, `${reais(c.valor_mensal_centavos)}/mês · ${c.usuarios_ativos}/${c.limite_usuarios} usuários · ${c.certidoes_no_mes}/${c.limite_certidoes_mes} certidões no mês`)),
          h('small', { class: 'apoio' }, `${c.vencida ? 'Venceu' : 'Vence'} em ${dia(c.vence_em)}`),
          h('span', { class: 'etiqueta ' + clsSit }, rotSit)),
        h('div', { class: 'conta-corpo' },
          form,
          h('div', { class: 'acoes' },
            acao(`Registrar pagamento de ${reais(c.valor_mensal_centavos)}`, () => api('POST', `/api/dono/contas/${c.id}/pagamentos`, {}), 'primario'),
            acao(c.status === 'suspensa' ? 'Reativar conta' : 'Suspender conta', () => api('POST', `/api/dono/contas/${c.id}`, { status: c.status === 'suspensa' ? 'ativa' : 'suspensa' }), c.status === 'suspensa' ? '' : 'perigo')),
          h('div', {}, h('h3', {}, 'Usuários'), ...c.usuarios.map((u) => h('p', {}, `${u.nome} · ${u.email || u.usuario} · ${PAPEL[u.perfil]}${u.ativo ? '' : ' · desativado'} · desde ${dia(u.criado_em)}`))),
          h('div', {}, h('h3', {}, 'Pagamentos'), ...(c.pagamentos.length ? c.pagamentos.map((p) => h('p', {}, `${dia(p.registrado_em)} · ${reais(p.valor_centavos)}`)) : [h('p', { class: 'apoio' }, 'Nenhum pagamento registrado.')]))));
    }) : [h('p', { class: 'vazio' }, 'Nenhum escritório cadastrado ainda. Eles aparecem aqui assim que criarem a conta.')]));
  }

  async function carregarConfig() {
    const r = await (await api('GET', '/api/dono/resumo')).json();
    const f = $('#form-config');
    f.valor.value = (r.config.valor_mensal_centavos / 100).toFixed(2);
    f.usuarios.value = r.config.limite_usuarios;
    f.certidoes.value = r.config.limite_certidoes_mes;
    f.teste.value = r.config.dias_teste;
    const m = await (await api('GET', '/api/dono/email')).json();
    const fe = $('#form-email');
    for (const k of ['smtp_host', 'smtp_porta', 'smtp_usuario', 'smtp_remetente']) fe[k].value = m[k];
    fe.smtp_seguro.value = m.smtp_seguro === '1' ? '1' : '0';
    fe.smtp_senha.value = '';
    fe.smtp_senha.placeholder = m.senha_definida ? '•••••••• (mantida)' : '';
    const est = $('#email-estado');
    est.textContent = m.configurado ? 'Configurado' : 'Não configurado';
    est.className = 'estado ' + (m.configurado ? 'ok' : 'aviso');
  }

  $('#form-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = e.target;
    const msg = $('#config-msg');
    msg.classList.remove('ok');
    try {
      await api('POST', '/api/dono/config', { valor_mensal_centavos: Math.round(numero(d.valor.value) * 100), limite_usuarios: Number(d.usuarios.value), limite_certidoes_mes: Number(d.certidoes.value), dias_teste: Number(d.teste.value) });
      msg.textContent = 'Padrões salvos. Valem para os próximos escritórios cadastrados.';
      msg.classList.add('ok');
    } catch (ex) { msg.textContent = ex.message; }
  });

  $('#form-email').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#email-msg');
    msg.classList.remove('ok');
    try {
      await api('POST', '/api/dono/email', Object.fromEntries(new FormData(e.target).entries()));
      msg.textContent = 'Configuração de e-mail salva.';
      msg.classList.add('ok');
      await carregarConfig();
    } catch (ex) { msg.textContent = ex.message; }
  });
  $('#btn-email-teste').addEventListener('click', async (e) => {
    const para = prompt('Enviar o e-mail de teste para qual endereço?');
    if (!para) return;
    const msg = $('#email-msg');
    msg.classList.remove('ok');
    await ocupado(e.currentTarget, async () => {
      try {
        await api('POST', '/api/dono/email/teste', { para });
        msg.textContent = `E-mail de teste enviado para ${para}.`;
        msg.classList.add('ok');
      } catch (ex) { msg.textContent = ex.message; }
    });
  });

  // ======================= Catálogo =======================
  const ESFERAS = { federal: 'Justiça Federal', estadual: 'Justiça Estadual', trabalho: 'Justiça do Trabalho', superior: 'Tribunais superiores', mp: 'Ministério Público', policia: 'Polícia', fiscal: 'Fazenda e dívida ativa', controle: 'Órgãos de controle', registro: 'Juntas comerciais e protestos' };
  const ESTADOS = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
  const semAcento = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Estados a que um portal se aplica; vazio = âmbito nacional. Um TRF aparece em cada estado da sua região.
  const ufsDe = (c) => (c.uf ? [c.uf] : c.ufs || []);
  const tipoAtual = () => $('#form-pedido input[name=tipo]:checked').value;
  const abertos = new Set();

  function linhaCertidao(c) {
    const caixinha = h('input', { type: 'checkbox', 'data-id': c.id, checked: marcados.has(c.id), onchange: (e) => {
      e.target.checked ? marcados.add(c.id) : marcados.delete(c.id);
      $$(`#catalogo input[data-id="${c.id}"]`).forEach((x) => { x.checked = e.target.checked; });
      contar();
    } });
    return h('label', { class: 'item' }, caixinha,
      h('span', { class: 'texto' }, h('strong', {}, c.orgao), h('span', {}, ' — ' + c.nome),
        c.ufs && h('small', {}, `Abrange ${c.ufs.join(', ')}`),
        c.conferir && h('small', { class: 'alerta' }, 'Abre o site do órgão: navegue até o formulário e o sistema preenche e envia.')),
      c.personalizado && h('button', { type: 'button', class: 'botao pequeno perigo', onclick: async (e) => { e.preventDefault(); await api('DELETE', '/api/catalogo/' + c.id); await carregarCatalogo(); } }, 'Remover'));
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
    for (const id of [...marcados]) if (!catalogo.some((c) => c.id === id && c.pessoas.includes(tipo))) marcados.delete(id);

    const grupos = [['', 'Âmbito nacional', visiveis.filter((c) => !ufsDe(c).length)]];
    for (const sigla of Object.keys(ESTADOS).sort((x, y) => ESTADOS[x].localeCompare(ESTADOS[y], 'pt-BR'))) {
      grupos.push([sigla, `${ESTADOS[sigla]} (${sigla})`, visiveis.filter((c) => ufsDe(c).includes(sigla))]);
    }
    const caixa = $('#catalogo');
    const rolagem = caixa.scrollTop;
    caixa.replaceChildren();
    for (const [sigla, titulo, itens] of grupos) {
      if (!itens.length || (uf && sigla && sigla !== uf)) continue;
      itens.sort((x, y) => Object.keys(ESFERAS).indexOf(x.esfera) - Object.keys(ESFERAS).indexOf(y.esfera));
      const aberto = Boolean(termos.length) || (uf ? sigla === uf : abertos.has(sigla));
      const selecionadas = itens.filter((c) => marcados.has(c.id)).length;
      const bloco = h('details', { class: 'grupo', open: aberto, ontoggle: (e) => { if (termos.length || uf) return; e.target.open ? abertos.add(sigla) : abertos.delete(sigla); } },
        h('summary', { class: 'grupo-titulo' }, titulo, selecionadas > 0 && h('span', { class: 'marcadas' }, `${selecionadas} marcada${selecionadas > 1 ? 's' : ''}`), h('span', { class: 'qtd' }, `${itens.length} ${itens.length === 1 ? 'certidão' : 'certidões'}`)),
        h('div', { class: 'grupo-acoes' },
          h('button', { type: 'button', class: 'botao pequeno', onclick: () => { itens.forEach((c) => marcados.add(c.id)); abertos.add(sigla); desenharCatalogo(); } }, 'Marcar todas'),
          selecionadas > 0 && h('button', { type: 'button', class: 'botao pequeno', onclick: () => { itens.forEach((c) => marcados.delete(c.id)); abertos.add(sigla); desenharCatalogo(); } }, 'Desmarcar')));
      let esfera = null;
      for (const c of itens) {
        if (c.esfera !== esfera) { esfera = c.esfera; bloco.append(h('div', { class: 'subgrupo' }, ESFERAS[esfera] || esfera)); }
        bloco.append(linhaCertidao(c));
      }
      caixa.append(bloco);
    }
    if (!caixa.children.length) caixa.append(h('p', { class: 'vazio' }, 'Nenhuma certidão para esta busca.'));
    caixa.scrollTop = rolagem;
    contar();
  }
  function contar() {
    const n = marcados.size;
    $('#contagem').textContent = n ? `${n} selecionada${n > 1 ? 's' : ''}` : '';
    $('#resumo-envio').textContent = n ? `${n} certidão${n > 1 ? 'ões' : ''} selecionada${n > 1 ? 's' : ''}` : 'Nenhuma certidão selecionada';
    $('#btn-solicitar').disabled = !n;
  }

  async function carregarCatalogo() {
    catalogo = await (await api('GET', '/api/catalogo')).json();
    const ufs = [...new Set(catalogo.flatMap(ufsDe))].sort((x, y) => (ESTADOS[x] || x).localeCompare(ESTADOS[y] || y, 'pt-BR'));
    const sel = $('#filtro-uf');
    const atual = sel.value;
    sel.replaceChildren(h('option', { value: '' }, 'Todos'), ...ufs.map((u) => h('option', { value: u }, ESTADOS[u] || u)));
    sel.value = ufs.includes(atual) ? atual : '';
    desenharCatalogo();
  }

  function ajustarTipo() {
    const pj = tipoAtual() === 'PJ';
    $('#rotulo-nome').textContent = pj ? 'Razão social' : 'Nome completo';
    $('#rotulo-doc').textContent = pj ? 'CNPJ' : 'CPF';
    $('#form-pedido [name=documento]').placeholder = pj ? '00.000.000/0000-00' : '000.000.000-00';
    $$('.so-pf').forEach((el) => { el.hidden = pj; });
    desenharCatalogo();
  }
  $$('#form-pedido input[name=tipo]').forEach((r) => r.addEventListener('change', ajustarTipo));
  $('#filtro-natureza').addEventListener('change', desenharCatalogo);
  $('#filtro-uf').addEventListener('change', desenharCatalogo);
  $('#filtro-texto').addEventListener('input', desenharCatalogo);

  // Máscara de CPF/CNPJ enquanto digita.
  $('#form-pedido [name=documento]').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, tipoAtual() === 'PJ' ? 14 : 11);
    e.target.value = tipoAtual() === 'PJ'
      ? d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2')
      : d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  });

  $('#form-pedido').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#pedido-erro');
    erro.textContent = '';
    const f = e.target;
    const pessoa = Object.fromEntries(['tipo', 'nome', 'documento', 'dataNascimento', 'nomeMae', 'nomePai', 'rg', 'email'].map((k) => [k, k === 'tipo' ? tipoAtual() : f[k].value]));
    await ocupado($('#btn-solicitar'), async () => {
      try {
        await api('POST', '/api/pedidos', { pessoa, certidoes: [...marcados] });
        const tipo = tipoAtual();
        f.reset(); // os dados do pesquisado não ficam na tela
        $(`#form-pedido input[name=tipo][value=${tipo}]`).checked = true;
        marcados.clear();
        ajustarTipo();
        ultimo = '';
        await atualizar();
        carregarConta().catch(() => {});
        avisar('Pedidos enviados. Acompanhe em “Em andamento”.');
      } catch (ex) { erro.textContent = ex.message; }
    });
    contar();
  });

  $('#btn-portal').addEventListener('click', async () => {
    const caixa = $('#form-portal');
    const erro = $('#portal-erro');
    erro.textContent = '';
    const v = (n) => $(`[name=${n}]`, caixa).value;
    try {
      await api('POST', '/api/catalogo', { orgao: v('orgao'), uf: v('uf'), nome: v('portal_nome'), url: v('url'), esfera: v('esfera'), natureza: $$('[name=natureza]:checked', caixa).map((x) => x.value) });
      $$('input', caixa).forEach((i) => { if (i.type === 'checkbox') i.checked = false; else i.value = ''; });
      $('#novo-portal').open = false;
      avisar('Portal adicionado ao catálogo.');
      await carregarCatalogo();
    } catch (ex) { erro.textContent = ex.message; }
  });

  // ======================= Pedidos e certidões =======================
  const ROTULOS = { fila: ['Na fila', 'neutra'], executando: ['Em andamento', 'andamento'], concluido: ['Concluído', 'ok'], erro: ['Não concluído', 'erro'], cancelado: ['Cancelado', 'neutra'] };

  async function baixar(a, abrir) {
    const blob = await (await api('GET', `/api/arquivos/${a.id}`)).blob();
    const url = URL.createObjectURL(blob);
    if (abrir) window.open(url, '_blank', 'noopener');
    else h('a', { href: url, download: a.nomeArquivo }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function cartaoPedido(p) {
    const [rot, cls] = ROTULOS[p.status];
    const botoes = [];
    if (p.status === 'executando') botoes.push(acao('Salvar página como certidão', () => api('POST', `/api/pedidos/${p.id}/capturar`)));
    if (p.status === 'executando' || p.status === 'fila') botoes.push(acao('Cancelar', () => api('POST', `/api/pedidos/${p.id}/cancelar`), 'perigo'));
    else botoes.push(acao('Dispensar', () => api('DELETE', `/api/pedidos/${p.id}`)));
    if (p.arquivoId) botoes.unshift(h('a', { href: '/certidoes', 'data-rota': '', class: 'botao pequeno' }, 'Ver certidão'));
    return h('article', { class: 'pedido ' + p.status },
      h('div', { class: 'pedido-topo' }, h('strong', {}, p.orgao), h('span', { class: 'etiqueta ' + cls }, rot)),
      h('p', {}, p.certidao),
      h('p', {}, `${p.pessoa} · ${quando(p.criadoEm)}`),
      h('p', { class: 'msg' }, p.mensagem),
      h('div', { class: 'acoes' }, ...botoes));
  }

  function linhaArquivo(a) {
    const dias = Math.max(0, Math.ceil((new Date(a.expiraEm) - Date.now()) / 86400000));
    return h('div', { class: 'linha' },
      h('div', { class: 'principal' }, h('strong', {}, a.nomeArquivo), h('small', {}, `${a.orgao} — ${a.certidao}`),
        a.origem === 'captura-de-pagina' && h('small', { class: 'alerta', style: 'display:block;color:var(--aviso)' }, 'Gerada a partir da página exibida pelo portal. Confira antes de usar.')),
      h('div', { class: 'sec' }, `Emitida em ${quando(a.criadoEm)}`, eu.perfil === 'admin' ? h('div', {}, `por ${a.dono}`) : null),
      h('span', { class: 'etiqueta ' + (dias <= 1 ? 'erro' : dias <= 3 ? 'aviso' : 'neutra') }, dias <= 1 ? 'Apaga hoje' : `Apaga em ${dias} dias`),
      h('div', { class: 'acoes' },
        acao('Abrir', () => baixar(a, true)), acao('Baixar', () => baixar(a, false), 'primario'),
        acao('Excluir', async () => { if (confirm('Excluir esta certidão em definitivo?')) await api('DELETE', `/api/arquivos/${a.id}`); }, 'perigo')));
  }

  async function atualizar() {
    if (!eu || eu.perfil === 'dono') return;
    const [pedidos, arquivos] = await Promise.all([api('GET', '/api/pedidos').then((r) => r.json()), api('GET', '/api/arquivos').then((r) => r.json())]);
    const assinatura = JSON.stringify([pedidos, arquivos]);
    if (assinatura === ultimo) return; // evita redesenhar (e perder o foco) sem mudança
    ultimo = assinatura;
    $('#pedidos').replaceChildren(...(pedidos.length ? pedidos.map(cartaoPedido) : [h('p', { class: 'vazio' }, 'Nenhum pedido nesta sessão.')]));
    $('#arquivos').replaceChildren(...(arquivos.length ? arquivos.map(linhaArquivo) : [h('p', { class: 'vazio' }, 'Nenhuma certidão guardada. As emitidas aparecem aqui.')]));
    $('#nav-qtd').textContent = arquivos.length;
    $('#nav-qtd').hidden = !arquivos.length;
  }

  // ======================= Início =======================
  (async () => {
    const estado = await (await fetch('/api/estado', { headers: { 'X-Sessao': sessao } })).json();
    $$('.dias').forEach((el) => { el.textContent = estado.diasRetencao; });
    if (estado.usuario) abrirApp(estado.usuario);
    rotear();
  })();
})();
