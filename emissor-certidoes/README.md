# Emissor de Certidões

Sistema **local** para solicitar certidões cíveis, criminais e fiscais de pessoas
físicas e jurídicas nos **portais oficiais** dos órgãos e arquivar os documentos expedidos.

> O sistema não fabrica certidões. Ele abre o portal do órgão, preenche o pedido com os
> dados informados e guarda o PDF que o próprio órgão expediu. A validade do documento
> continua sendo conferida no site do emissor, pelo código de autenticação da certidão.

## Como funciona

1. Você faz login, informa os dados do pesquisado (PF ou PJ) e marca as certidões desejadas.
2. Para cada uma, o sistema abre o portal oficial em uma janela do navegador, escolhe o
   modelo da certidão, preenche os campos e **envia o pedido sozinho**.
3. Se o portal tiver CAPTCHA, o sistema espera você resolvê-lo e então envia. Ele **não**
   burla CAPTCHA. Essa é a única ação manual.
4. A certidão é reconhecida onde quer que apareça: download, PDF aberto em outra aba ou
   janela, PDF gerado no navegador, PDF embutido na página, ou página HTML (que é salva em
   PDF e marcada como captura). Ela fica em **Certidões guardadas** por 7 dias.

Os pedidos rodam em fila, um portal por vez. Se o sistema não reconhecer a certidão, há o
botão *Salvar a página aberta como certidão*.

## Executável (Windows)

O executável é gerado pelo GitHub Actions a cada alteração: na aba **Actions** do
repositório, abra a execução mais recente de *Emissor de Certidões* e baixe o artefato
`EmissorCertidoes-windows`. Descompacte e abra `EmissorCertidoes.exe`.

- A pasta inteira é o programa: mantenha `recursos` e `node_modules` ao lado do `.exe`.
- Não precisa instalar Node. Precisa de Microsoft Edge (já vem no Windows) ou Chrome.
- Uma janela de console fica aberta e o sistema abre no navegador; fechar a janela encerra.
- O executável não é assinado: o Windows pode exibir o aviso do SmartScreen na primeira vez.
- Os dados ficam em `%LOCALAPPDATA%\EmissorCertidoes`.

Para gerar você mesmo, em um Windows com Node.js 22.13 ou mais recente:

```bash
cd emissor-certidoes
npm install
npm run build        # gera dist/EmissorCertidoes/
```

Para rodar sem empacotar: `npm install` e `npm start` (abre em http://127.0.0.1:8787).

Variáveis opcionais: `PORTA` (padrão 8787), `CERTIDOES_DADOS` (pasta dos dados) e
`CERTIDOES_NAVEGADOR` (`msedge` ou `chrome`).

## Telas

| Endereço | Para quem | Conteúdo |
|---|---|---|
| `/entrar` | Todos | Login por e-mail (ou `adm` para o responsável) |
| `/cadastro` | Novos usuários | Cadastro em 4 etapas: tipo de conta → dados → código no e-mail → senha |
| `/emitir` | Escritórios | Pesquisado, catálogo por estado e pedidos em andamento |
| `/certidoes` | Escritórios | Certidões guardadas, com abrir, baixar e excluir |
| `/conta` | Escritórios | Perfil, plano e uso, equipe e chaves de convite, pagamentos, senha |
| `/painel` | Responsável | Indicadores e gestão dos escritórios |
| `/configuracoes` | Responsável | Valores padrão, envio de e-mail (SMTP) e senha |

## Perfis de acesso

| Perfil | Como entra | O que faz |
|---|---|---|
| **Responsável pelo sistema** | Acesso único e fixo: usuário `adm` | Vê escritórios, usuários, uso e mensalidades; altera valores e limites; registra pagamentos; suspende contas; configura o envio de e-mail. Não emite certidões e não consegue abrir as dos clientes. |
| **Administrador pagante** | *Criar conta → Sou um escritório* | Tem a conta do escritório (com período de teste), emite certidões, gera chaves de convite, gerencia a equipe e vê as certidões de todos dela. |
| **Usuário** | *Criar conta → Tenho uma chave de convite* | Emite certidões na conta do escritório e vê apenas as suas. |

O cadastro confirma o e-mail com um código de 6 dígitos (vale 10 minutos, 5 tentativas,
reenvio após 30 segundos). Para enviar o código por e-mail, o responsável preenche o
servidor SMTP em **Configurações**; enquanto isso não for feito, o código aparece apenas
na janela de console do sistema. A senha precisa de 8 caracteres, uma letra, um número e
um símbolo. A senha do servidor SMTP fica gravada sem cifra no banco local.

A emissão é bloqueada quando a mensalidade vence, a conta é suspensa ou o limite mensal de
certidões é atingido. A chave de convite é aleatória, de uso único e vale 7 dias.

**Limitação importante:** as contas ficam no banco local (`emissor.db`) desta instalação.
O responsável só enxerga escritórios cadastrados na mesma máquina. Para vender a
escritórios diferentes, cada um na sua máquina, o cadastro de contas e mensalidades precisa
ir para um servidor central; o pagamento hoje é registrado manualmente.

## O que é e o que não é armazenado

- **Dados do pesquisado** (nome completo, CPF/CNPJ, filiação, nascimento, RG, e-mail):
  **não são gravados**. Existem só em memória, do envio do formulário até o fim da
  emissão, e são descartados em seguida. Sair ou fechar o sistema descarta os pedidos pendentes.
- **Certidões emitidas**: ficam 7 dias, cifradas em disco (AES-256-GCM), e são apagadas
  automaticamente depois disso. Podem ser excluídas antes pela tela.
- **Índice das certidões** no banco: órgão, tipo, data, hash e o nome do arquivo, que
  segue o padrão `TRF3 CIVIL ADALTO CPF.pdf` e por isso contém o **primeiro nome** do pesquisado.
- A chave que cifra as certidões é protegida pela senha de cada usuário: sem login,
  os arquivos em disco não podem ser lidos. Se todos os usuários perderem a senha, as
  certidões guardadas ficam inacessíveis.
- O servidor escuta apenas em `127.0.0.1` e recusa requisições de outras origens. A única
  saída de dados é a do navegador ao enviar o pedido ao portal oficial.
- Emita certidões de terceiros apenas com base legal para tratar esses dados (LGPD).

## Catálogo de portais

`catalogo.json` traz 169 certidões: os 6 TRFs e a certidão unificada do CJF, os 27 Tribunais
de Justiça, os 24 TRTs, STF, STJ, TST, STM, TSE, CNJ, Polícia Federal, MPF, MPT, MPM e os 27
Ministérios Públicos estaduais, Receita/PGFN, FGTS, as 27 fazendas estaduais, TCU, CGU, IBAMA,
as 27 juntas comerciais e a central de protestos.

Cerca de metade das entradas (marcadas com `"conferir": true`) aponta para o **site do
órgão**, não para o formulário da certidão: nesses casos navegue até o formulário e o sistema
preenche e envia a partir dali. Substitua o endereço pelo do formulário quando o conhecer.

Os endereços mudam com frequência e **não foram testados contra os portais reais** neste
desenvolvimento: confira cada um no primeiro uso. Para outros tribunais ou estados, use
*Cadastrar outro portal oficial* na tela, ou edite `catalogo.json`. Campos opcionais por portal:

| Campo | Uso |
|---|---|
| `seletores` | Seletor CSS por campo quando o reconhecimento automático falhar, ex.: `{ "cpf": "#nuCpf" }` |
| `opcoes` | Termos para escolher o modelo da certidão em listas e botões de opção, ex.: `["falencia"]` |
| `rotulo` | Prefixo do nome do arquivo baixado, ex.: `TRF3 CIVIL` gera `TRF3 CIVIL ADALTO CPF.pdf` |
| `enviar` | Seletor do botão de envio, quando o reconhecimento automático do botão falhar |

Campos aceitos em `seletores`: `nome`, `documento`, `cpf`, `cnpj`, `nomeMae`, `nomePai`,
`dataNascimento`, `rg`, `email`.

## Testes

```bash
npm test
```

Cobrem validação de CPF/CNPJ, o banco (perfis, convites, limites, mensalidades, retenção), o motor (envio automático, CAPTCHA, certidão em outra aba) e o fluxo completo, sempre contra portais simulados.
