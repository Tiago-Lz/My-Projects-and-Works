# Emissor de Certidões

Sistema **local** para solicitar certidões cíveis, criminais e fiscais de pessoas
físicas e jurídicas nos **portais oficiais** dos órgãos e arquivar os documentos expedidos.

> O sistema não fabrica certidões. Ele abre o portal do órgão, preenche o pedido com os
> dados informados e guarda o PDF que o próprio órgão expediu. A validade do documento
> continua sendo conferida no site do emissor, pelo código de autenticação da certidão.

## Como funciona

1. Você informa os dados do pesquisado (PF ou PJ) e marca as certidões desejadas.
2. Para cada uma, o sistema abre o portal oficial em uma janela do navegador e
   preenche os campos que reconhece (nome, CPF/CNPJ, mãe, pai, nascimento, RG, e-mail).
3. Você confere, resolve o CAPTCHA (o sistema **não** burla CAPTCHA) e envia.
4. O PDF expedido é capturado automaticamente, cifrado e listado em **Pedidos**,
   com o SHA-256 do arquivo. Se o portal mostrar a certidão em HTML, use
   *Salvar a página aberta como certidão* (o registro fica marcado como captura).

Os pedidos rodam em fila, um portal por vez.

## Instalação

Requer Node.js 20 ou mais recente.

```bash
cd emissor-certidoes
npm install
npx playwright install chromium
npm start            # abre em http://127.0.0.1:8787
```

Variáveis opcionais: `PORTA` (padrão 8787) e `CERTIDOES_DADOS` (pasta dos dados, padrão `./dados`).

## Dados sensíveis

- O servidor escuta apenas em `127.0.0.1` e recusa requisições de outras origens.
- Dados pessoais e certidões ficam em `dados/`, cifrados com AES-256-GCM. A chave é
  derivada da senha mestra (scrypt) e só existe em memória enquanto o cofre está aberto.
- **Não há recuperação da senha mestra.** Sem ela os dados não podem ser lidos.
- A única saída de dados é a do próprio navegador ao enviar o pedido ao portal oficial.
- `dados/` está no `.gitignore`. Faça backup dessa pasta inteira (incluindo `cofre.json`).
- Emita certidões de terceiros apenas com base legal para tratar esses dados (LGPD).

## Catálogo de portais

`catalogo.json` traz TRFs 1 a 6 e a certidão unificada do CJF, Polícia Federal, STF, STJ,
TST (CNDT), STM, TSE, 13 Tribunais de Justiça, Receita/PGFN e Sefaz/dívida ativa de SP e MG.

Os endereços mudam com frequência e **não foram testados contra os portais reais** neste
desenvolvimento: confira cada um no primeiro uso. Para outros tribunais ou estados, use
*Cadastrar outro portal oficial* na tela, ou edite `catalogo.json`. Campos opcionais por portal:

| Campo | Uso |
|---|---|
| `seletores` | Seletor CSS por campo quando o reconhecimento automático falhar, ex.: `{ "cpf": "#nuCpf" }` |
| `enviar` | Seletor do botão de envio, para portais **sem** CAPTCHA (envio automático) |

Campos aceitos em `seletores`: `nome`, `documento`, `cpf`, `cnpj`, `nomeMae`, `nomePai`,
`dataNascimento`, `rg`, `email`.

## Testes

```bash
npm test
```

Cobrem validação de CPF/CNPJ, o cofre e o fluxo completo contra um portal simulado.
