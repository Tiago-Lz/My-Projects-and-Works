# Emissor de Certidões

Sistema **local** para solicitar certidões cíveis, criminais e fiscais de pessoas
físicas e jurídicas nos **portais oficiais** dos órgãos e arquivar os documentos expedidos.

> O sistema não fabrica certidões. Ele abre o portal do órgão, preenche o pedido com os
> dados informados e guarda o PDF que o próprio órgão expediu. A validade do documento
> continua sendo conferida no site do emissor, pelo código de autenticação da certidão.

## Como funciona

1. Você faz login, informa os dados do pesquisado (PF ou PJ) e marca as certidões desejadas.
2. Para cada uma, o sistema abre o portal oficial em uma janela do navegador e
   preenche os campos que reconhece (nome, CPF/CNPJ, mãe, pai, nascimento, RG, e-mail).
3. Você confere, resolve o CAPTCHA (o sistema **não** burla CAPTCHA) e envia.
4. O PDF expedido é capturado automaticamente e fica em **Certidões guardadas** por
   7 dias. Se o portal mostrar a certidão em HTML, use *Salvar a página aberta como
   certidão* (o arquivo fica marcado como captura).

Os pedidos rodam em fila, um portal por vez.

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

## Login e usuários

O banco de dados (`emissor.db`, SQLite) guarda as contas. No primeiro acesso é criada a
conta do administrador, que cadastra os demais usuários, redefine senhas e desativa contas.
Operadores veem apenas as próprias certidões; administradores veem as de todos.
As senhas são guardadas como hash scrypt com sal. A sessão expira após 30 minutos sem uso.

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

`catalogo.json` traz TRFs 1 a 6 e a certidão unificada do CJF, Polícia Federal, STF, STJ,
TST (CNDT), STM, TSE, 12 Tribunais de Justiça, Receita/PGFN e Sefaz/dívida ativa de SP e MG.
Para São Paulo há o conjunto completo de diligência: TJSP por modelo (cíveis, cíveis 10 anos,
falências, inventários, criminais, execuções criminais), TRF3 (cível, criminal, fins
eleitorais), TRT2 (CEAT, eletrônicos, físicos), MPF, MPT e JUCESP.

Os endereços mudam com frequência e **não foram testados contra os portais reais** neste
desenvolvimento: confira cada um no primeiro uso. Para outros tribunais ou estados, use
*Cadastrar outro portal oficial* na tela, ou edite `catalogo.json`. Campos opcionais por portal:

| Campo | Uso |
|---|---|
| `seletores` | Seletor CSS por campo quando o reconhecimento automático falhar, ex.: `{ "cpf": "#nuCpf" }` |
| `opcoes` | Termos para escolher o modelo da certidão em listas e botões de opção, ex.: `["falencia"]` |
| `rotulo` | Prefixo do nome do arquivo baixado, ex.: `TRF3 CIVIL` gera `TRF3 CIVIL ADALTO CPF.pdf` |
| `enviar` | Seletor do botão de envio, para portais **sem** CAPTCHA (envio automático) |

Campos aceitos em `seletores`: `nome`, `documento`, `cpf`, `cnpj`, `nomeMae`, `nomePai`,
`dataNascimento`, `rg`, `email`.

## Testes

```bash
npm test
```

Cobrem validação de CPF/CNPJ, o banco (login, usuários, retenção) e o fluxo completo contra um portal simulado.
