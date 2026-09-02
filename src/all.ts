/**
 * Roda os 11 cenários em sequência, com a saída de apresentação de cada um.
 *
 *   npm run all                     todos, na ordem
 *   npm run all -- --only 02,06     só os cenários pedidos
 *   npm run all -- --block A        só o bloco A (1 a 5) ou B (6 a 11)
 *   npm run all -- --fail-fast
 *
 * Cada cenário roda num processo separado, com stdio herdado, exatamente como
 * se você tivesse chamado `npx tsx src/cenários/02-corrida-sem-thread.ts` na
 * mao. Isso mantém a saída idêntica à do cenário isolado e garante que um
 * cenário não contamine o próximo com estado de módulo ou worker vivo.
 *
 * Para medir e gerar gráficos, o comando é outro: `npm run bench`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { criarPool, fecharPool, lerConfig, verificarConexao } from './db.js';
import { secao, titulo } from './relatorio.js';

const PASTA = join('src', 'cenarios');
const TSX = join('node_modules', '.bin', 'tsx');

/** Os cenários 1 a 5 são o bloco A, 6 a 11 são o bloco B. */
function blocoDe(arquivo: string): 'A' | 'B' {
  return Number(arquivo.slice(0, 2)) <= 5 ? 'A' : 'B';
}

interface Argumentos {
  apenas?: string[];
  bloco?: 'A' | 'B';
  pararNoErro: boolean;
}

function lerArgumentos(argv: string[]): Argumentos {
  const args: Argumentos = { pararNoErro: false };
  for (let i = 0; i < argv.length; i++) {
    const chave = argv[i];
    const valor = argv[i + 1];
    switch (chave) {
      case '--only':
        args.apenas = (valor ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '');
        i++;
        break;
      case '--block': {
        const b = (valor ?? '').trim().toUpperCase();
        if (b !== 'A' && b !== 'B') {
          console.error(`[ERRO] --block aceita A ou B, veio "${valor}".`);
          process.exit(1);
        }
        args.bloco = b;
        i++;
        break;
      }
      case '--fail-fast':
        args.pararNoErro = true;
        break;
      case '--help':
      case '-h':
        console.log(AJUDA);
        process.exit(0);
        break;
      default:
        if (chave !== undefined && chave.startsWith('--')) {
          console.error(`[ERRO] Opção desconhecida: ${chave}\n${AJUDA}`);
          process.exit(1);
        }
    }
  }
  return args;
}

const AJUDA = `
Uso: npm run all -- [opções]

  --only LISTA    só estes cenários, por prefixo. ex: --only 02,06,11
  --block A|B     só o bloco A (sem thread) ou B (worker_threads)
  --fail-fast     interrompe no primeiro cenário que falhar
                  (o padrão e seguir e reportar no resumo do fim)
`;

/** Concordância de número, para não sair "1 cenários" na tela. */
function plural(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

interface Execucao {
  arquivo: string;
  bloco: 'A' | 'B';
  ms: number;
  codigo: number;
}

const args = lerArgumentos(process.argv.slice(2));

let arquivos = readdirSync(PASTA)
  .filter((f) => f.endsWith('.ts'))
  .sort();

if (args.bloco !== undefined) arquivos = arquivos.filter((f) => blocoDe(f) === args.bloco);
if (args.apenas !== undefined) {
  const pedidos = args.apenas;
  const filtrados = arquivos.filter((f) => pedidos.some((p) => f.startsWith(p)));
  const semCorrespondencia = pedidos.filter((p) => !arquivos.some((f) => f.startsWith(p)));
  if (semCorrespondencia.length > 0) {
    console.error(`\n[ERRO] Não achei cenário para: ${semCorrespondencia.join(', ')}`);
    console.error('       Disponíveis:');
    for (const f of arquivos) console.error(`       ${f.replace(/\.ts$/, '')}`);
    console.error('');
    process.exit(1);
  }
  arquivos = filtrados;
}

if (arquivos.length === 0) {
  console.error('\n[ERRO] Nenhum cenário selecionado.\n');
  process.exit(1);
}

// checa o banco uma vez, aqui, para não repetir a mesma falha 11 vezes
const cfg = lerConfig();
const pool = criarPool(2, cfg);
await verificarConexao(pool);
await fecharPool(pool);

titulo(`RODANDO ${plural(arquivos.length, 'CENÁRIO', 'CENÁRIOS')}`);
console.log(`  banco: ${cfg.host}:${cfg.port}/${cfg.database}`);
console.log(`  ${cfg.contas} contas x ${cfg.saldoInicial} de saldo inicial`);
console.log('');
console.log('  O cenário 11 escreve os logs de depuração em stderr, porque o barulho');
console.log('  dele é o próprio experimento. Para ver só os resumos:');
console.log('    npm run all 2>/dev/null');

const execucoes: Execucao[] = [];
const inicioGeral = performance.now();

for (const [indice, arquivo] of arquivos.entries()) {
  const nome = arquivo.replace(/\.ts$/, '');
  const bloco = blocoDe(arquivo);
  secao(`[${indice + 1}/${arquivos.length}]  bloco ${bloco}  ${nome}`);

  const inicio = performance.now();
  const r = spawnSync(TSX, [join(PASTA, arquivo)], { stdio: 'inherit' });
  const ms = performance.now() - inicio;
  const codigo = r.status ?? 1;

  execucoes.push({ arquivo: nome, bloco, ms, codigo });

  if (codigo !== 0) {
    console.error(`\n  [FALHOU] ${nome} saiu com código ${codigo}.`);
    if (args.pararNoErro) {
      console.error('  --fail-fast ligado, interrompendo aqui.\n');
      break;
    }
    console.error('  Seguindo para o próximo. Use --fail-fast para interromper.\n');
  }
}

const msGeral = performance.now() - inicioGeral;
const falhas = execucoes.filter((e) => e.codigo !== 0);

titulo('RESUMO');
console.log(`  ${'cenário'.padEnd(28)}${'bloco'.padEnd(8)}${'tempo'.padStart(10)}   status`);
console.log('  ' + '-'.repeat(62));
for (const e of execucoes) {
  console.log(
    `  ${e.arquivo.padEnd(28)}${e.bloco.padEnd(8)}${`${(e.ms / 1000).toFixed(1)} s`.padStart(10)}   ` +
      (e.codigo === 0 ? 'ok' : `FALHOU (código ${e.codigo})`),
  );
}
console.log('');
console.log(`  ${plural(execucoes.length, 'cenário', 'cenários')} em ${(msGeral / 1000).toFixed(1)} s`);
if (falhas.length > 0) {
  console.log(`  ${plural(falhas.length, 'falhou', 'falharam')}: ${falhas.map((f) => f.arquivo).join(', ')}`);
}
console.log('');
console.log('  Para medir com repetições e gerar os gráficos:');
console.log('    caffeinate -i npm run bench -- --scenarios all --repetitions 10');
console.log('    npm run charts');
console.log('');

process.exit(falhas.length > 0 ? 1 : 0);
