'use strict';
// Gera o executável para o sistema operacional em que este script roda:
//   dist/EmissorCertidoes/
//     EmissorCertidoes(.exe)   Node + código do sistema em um único arquivo
//     recursos/                tela (public/) e catálogo de portais
//     node_modules/            playwright-core, que controla o navegador
// No Windows, rode em um Windows; a pasta inteira é o programa (pode ser compactada).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const raiz = __dirname;
const saida = path.join(raiz, 'dist', 'EmissorCertidoes');
const tmp = path.join(raiz, 'dist', 'tmp');
const exe = path.join(saida, 'EmissorCertidoes' + (process.platform === 'win32' ? '.exe' : ''));

fs.rmSync(path.join(raiz, 'dist'), { recursive: true, force: true });
fs.mkdirSync(saida, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });

// 1. Um único arquivo JS com todo o código do sistema.
require('esbuild').buildSync({
  entryPoints: [path.join(raiz, 'server.js')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outfile: path.join(tmp, 'app.cjs'), logLevel: 'warning',
});

// 2. Empacota esse arquivo dentro de uma cópia do Node (Single Executable Application).
const blob = path.join(tmp, 'app.blob');
fs.writeFileSync(path.join(tmp, 'sea.json'), JSON.stringify({ main: path.join(tmp, 'app.cjs'), output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(tmp, 'sea.json')], { stdio: 'inherit' });
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
const postject = require.resolve('postject/dist/cli.js');
execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])], { stdio: 'inherit' });

// 3. Arquivos que ficam ao lado do executável.
fs.cpSync(path.join(raiz, 'public'), path.join(saida, 'recursos', 'public'), { recursive: true });
fs.copyFileSync(path.join(raiz, 'catalogo.json'), path.join(saida, 'recursos', 'catalogo.json'));
const pw = path.dirname(require.resolve('playwright-core/package.json'));
fs.cpSync(pw, path.join(saida, 'node_modules', 'playwright-core'), { recursive: true });
fs.writeFileSync(path.join(saida, 'LEIA-ME.txt'), [
  'Emissor de Certidões',
  '',
  'Abra EmissorCertidoes' + (process.platform === 'win32' ? '.exe' : '') + '. Uma janela de console fica aberta e o sistema',
  'abre no navegador. Para encerrar, feche a janela de console.',
  '',
  'Mantenha esta pasta inteira junta: o executável precisa de "recursos" e "node_modules".',
  'Requer Microsoft Edge ou Google Chrome instalado.',
  '',
].join('\r\n'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Pronto: ' + saida);
