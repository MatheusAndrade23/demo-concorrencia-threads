/**
 * Runner de benchmark.
 *
 *   npx tsx src/benchmark.ts --scenarios 02,08 --concurrency 1,2,4,8,16,32,64 \
 *                            --repetitions 10 --operations 200
 *
 * Regras da medição:
 *   - uma execução de warm-up é descartada antes de cada série
 *   - o estado do banco é recriado antes de CADA repetição (cada cenário chama
 *     resetar() no início do próprio executar)
 *   - grava UMA LINHA POR REPETIÇÃO em resultados/resultados.csv, nunca só a
 *     média: a dispersão entre repetições é metade do que este projeto mostra
 *   - nenhum cenário aborta o benchmark; erro vira linha com a coluna `falhou`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criarPool, fecharPool, lerConfig, verificarConexao } from './db.js';
import { ehPrincipal, secao, titulo } from './relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from './tipos.js';

interface Modulo {
  executar: (o: OpcoesCenario) => Promise<ResultadoCenario>;
}

interface Definicao {
  nome: string;
  bloco: 'A' | 'B';
  carregar: () => Promise<Modulo>;
  /** concorrências que fazem sentido para este cenário */
  concorrenciasPadrao: number[];
  /** valor de `operações` quando --operations não é passado */
  operacoesPadrao: number;
  /**
   * true quando `operações` não é "número de saques" e sim outra escala
   * (rodadas de hash, incrementos por worker). Estes ignoram --operations.
   */
  escalaPropria: boolean;
  valorSaque?: number;
  logNaSecaoCritica?: boolean;
}

const CENARIOS: Definicao[] = [
  {
    nome: '01-sequencial',
    bloco: 'A',
    carregar: () => import('./cenarios/01-sequencial.js'),
    concorrenciasPadrao: [1],
    operacoesPadrao: 200,
    escalaPropria: false,
  },
  {
    nome: '02-corrida-sem-thread',
    bloco: 'A',
    carregar: () => import('./cenarios/02-corrida-sem-thread.js'),
    concorrenciasPadrao: [1, 2, 4, 8, 16, 32, 64],
    operacoesPadrao: 200,
    escalaPropria: false,
  },
  {
    nome: '03-promise-orfa',
    bloco: 'A',
    carregar: () => import('./cenarios/03-promise-orfa.js'),
    concorrenciasPadrao: [1],
    operacoesPadrao: 10,
    escalaPropria: false,
  },
  {
    nome: '04-event-loop-travado',
    bloco: 'A',
    carregar: () => import('./cenarios/04-event-loop-travado.js'),
    concorrenciasPadrao: [1],
    operacoesPadrao: 700_000_000,
    escalaPropria: true,
  },
  {
    nome: '05-conexao-compartilhada',
    bloco: 'A',
    carregar: () => import('./cenarios/05-conexao-compartilhada.js'),
    concorrenciasPadrao: [1, 2, 4, 8, 16, 32],
    operacoesPadrao: 60,
    escalaPropria: false,
  },
  {
    nome: '06-worker-sab-corrida',
    bloco: 'B',
    carregar: () => import('./cenarios/06-worker-sab-corrida.js'),
    concorrenciasPadrao: [2, 4, 8],
    operacoesPadrao: 2_000_000,
    escalaPropria: true,
  },
  {
    nome: '07-worker-cpu',
    bloco: 'B',
    carregar: () => import('./cenarios/07-worker-cpu.js'),
    concorrenciasPadrao: [1, 2, 4, 8],
    operacoesPadrao: 700_000_000,
    escalaPropria: true,
  },
  {
    nome: '08-worker-banco',
    bloco: 'B',
    carregar: () => import('./cenarios/08-worker-banco.js'),
    concorrenciasPadrao: [1, 2, 4, 8, 16],
    operacoesPadrao: 200,
    escalaPropria: false,
  },
  {
    nome: '09-deadlock',
    bloco: 'B',
    carregar: () => import('./cenarios/09-deadlock.js'),
    concorrenciasPadrao: [2, 4, 8],
    operacoesPadrao: 40,
    escalaPropria: false,
    valorSaque: 10,
  },
  {
    nome: '10-leitura-suja',
    bloco: 'B',
    carregar: () => import('./cenarios/10-leitura-suja.js'),
    concorrenciasPadrao: [2, 5],
    operacoesPadrao: 40,
    escalaPropria: false,
  },
  {
    nome: '11-heisenbug-sem-log',
    bloco: 'B',
    carregar: () => import('./cenarios/11-heisenbug.js'),
    concorrenciasPadrao: [2, 4, 8, 16, 32],
    operacoesPadrao: 100,
    escalaPropria: false,
    logNaSecaoCritica: false,
  },
  {
    nome: '11-heisenbug-com-log',
    bloco: 'B',
    carregar: () => import('./cenarios/11-heisenbug.js'),
    concorrenciasPadrao: [2, 4, 8, 16, 32],
    operacoesPadrao: 100,
    escalaPropria: false,
    logNaSecaoCritica: true,
  },
];

// ---------------------------------------------------------------------------
// argumentos
// ---------------------------------------------------------------------------
interface Argumentos {
  cenarios: Definicao[];
  concorrencia?: number[];
  repeticoes: number;
  operacoes?: number;
  warmup: boolean;
  saida: string;
}

function listaDeNumeros(bruto: string): number[] {
  return bruto
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function selecionarCenarios(bruto: string): Definicao[] {
  const chave = bruto.trim().toLowerCase();
  if (chave === 'all') return CENARIOS;
  if (chave === 'a') return CENARIOS.filter((c) => c.bloco === 'A');
  if (chave === 'b') return CENARIOS.filter((c) => c.bloco === 'B');

  const pedidos = chave.split(',').map((p) => p.trim());
  const escolhidos: Definicao[] = [];
  for (const pedido of pedidos) {
    const achados = CENARIOS.filter((c) => c.nome === pedido || c.nome.startsWith(`${pedido}-`));
    if (achados.length === 0) {
      console.error(`\n[ERRO] Cenário "${pedido}" não existe. Disponíveis:`);
      for (const c of CENARIOS) console.error(`       ${c.nome}`);
      process.exit(1);
    }
    escolhidos.push(...achados);
  }
  return escolhidos;
}

function lerArgumentos(argv: string[]): Argumentos {
  const args: Argumentos = {
    cenarios: CENARIOS,
    repeticoes: 10,
    warmup: true,
    saida: 'resultados',
  };
  for (let i = 0; i < argv.length; i++) {
    const chave = argv[i];
    const valor = argv[i + 1];
    switch (chave) {
      case '--scenarios':
        args.cenarios = selecionarCenarios(valor ?? 'all');
        i++;
        break;
      case '--concurrency':
        args.concorrencia = listaDeNumeros(valor ?? '');
        i++;
        break;
      case '--repetitions':
        args.repeticoes = Math.max(1, Number(valor ?? 10));
        i++;
        break;
      case '--operations':
        args.operacoes = Math.max(1, Number(valor ?? 200));
        i++;
        break;
      case '--output':
        args.saida = valor ?? 'resultados';
        i++;
        break;
      case '--no-warmup':
        args.warmup = false;
        break;
      case '--help':
      case '-h':
        console.log(AJUDA);
        process.exit(0);
        break;
      default:
        if (chave !== undefined && chave.startsWith('--')) {
          console.error(`[ERRO] Opção desconhecida: ${chave}\n`);
          console.log(AJUDA);
          process.exit(1);
        }
    }
  }
  return args;
}

const AJUDA = `
Uso: npx tsx src/benchmark.ts [opções]

  --scenarios LISTA    nomes separados por virgula, ou "all", "A", "B"
                       exemplos: 02  |  02,08  |  01,02,05  |  B
  --concurrency LISTA  ex: 1,2,4,8,16,32,64 (padrão: o que cada cenário define)
  --repetitions N      padrão 10, uma linha no CSV por repetição
  --operations N       número de saques por repetição; cenários de CPU e de
                       memória ignoram, porque a escala deles e outra
  --no-warmup          não descarta a primeira execução de cada série
  --output DIR         padrão: resultados
`;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function csv(valor: unknown): string {
  const s = String(valor ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUNAS = [
  'cenario',
  'bloco',
  'concorrencia',
  'repeticao',
  'operacoes',
  'concluidas',
  'ms',
  'throughput',
  'saldo_inicial',
  'movimentos',
  'esperado',
  'observado',
  'divergencia',
  'perdido',
  'erros_total',
  'erros_por_sqlstate',
  'ops_por_trabalhador',
  'maior_lacuna_event_loop_ms',
  'extra',
  'falhou',
  'erro',
] as const;

function linhaDoResultado(
  def: Definicao,
  repeticao: number,
  r: ResultadoCenario,
): string {
  const errosTotal = Object.values(r.erros).reduce((a, b) => a + b, 0);
  return [
    r.cenario,
    def.bloco,
    r.concorrencia,
    repeticao,
    r.operacoes,
    r.concluidas,
    r.ms.toFixed(3),
    r.throughput.toFixed(3),
    r.invariante.saldoInicial,
    r.invariante.movimentos,
    r.invariante.esperado,
    r.invariante.observado,
    r.invariante.divergencia,
    r.invariante.perdido,
    errosTotal,
    JSON.stringify(r.erros),
    JSON.stringify(r.porTrabalhador),
    r.maiorLacunaEventLoopMs?.toFixed(3) ?? '',
    JSON.stringify(r.extra ?? {}),
    'nao',
    '',
  ]
    .map(csv)
    .join(',');
}

function linhaDeFalha(
  def: Definicao,
  concorrencia: number,
  repeticao: number,
  erro: unknown,
): string {
  const vazio = COLUNAS.length - 6;
  return [
    def.nome,
    def.bloco,
    concorrencia,
    repeticao,
    ...new Array<string>(vazio).fill(''),
    'sim',
    erro instanceof Error ? erro.message : String(erro),
  ]
    .map(csv)
    .join(',');
}

// ---------------------------------------------------------------------------
// execução
// ---------------------------------------------------------------------------
export async function rodar(args: Argumentos): Promise<void> {
  const cfg = lerConfig();
  const pool = criarPool(2, cfg);
  await verificarConexao(pool);
  await fecharPool(pool);

  mkdirSync(args.saida, { recursive: true });

  const linhas: string[] = [COLUNAS.join(',')];
  const distribuicao: string[] = ['cenario,concorrencia,repeticao,trabalhador,operacoes'];
  const serie: string[] = ['cenario,concorrencia,repeticao,t_ms,total'];

  let falhas = 0;

  for (const def of args.cenarios) {
    const modulo = await def.carregar();
    const concorrencias = args.concorrencia ?? def.concorrenciasPadrao;
    const operacoes = def.escalaPropria ? def.operacoesPadrao : args.operacoes ?? def.operacoesPadrao;

    secao(`${def.nome}   bloco ${def.bloco}   operações=${operacoes.toLocaleString('pt-BR')}`);

    for (const concorrencia of concorrencias) {
      const opts: OpcoesCenario = {
        operacoes,
        concorrencia,
        valorSaque: def.valorSaque ?? cfg.valorSaque,
        logNaSecaoCritica: def.logNaSecaoCritica,
        silencioso: true,
      };

      if (args.warmup) {
        process.stdout.write(`  c=${String(concorrencia).padStart(3)}  warm-up... `);
        try {
          await modulo.executar(opts);
        } catch {
          // warm-up não entra no CSV nem interrompe nada
        }
      } else {
        process.stdout.write(`  c=${String(concorrencia).padStart(3)}  `);
      }

      const tempos: number[] = [];
      const perdas: number[] = [];

      for (let rep = 1; rep <= args.repeticoes; rep++) {
        try {
          const r = await modulo.executar(opts);
          linhas.push(linhaDoResultado(def, rep, r));
          tempos.push(r.ms);
          perdas.push(r.invariante.perdido);

          r.porTrabalhador.forEach((n, i) => {
            distribuicao.push([r.cenario, r.concorrencia, rep, i, n].map(csv).join(','));
          });
          for (const a of r.serie ?? []) {
            serie.push([r.cenario, r.concorrencia, rep, a.t, a.valor].map(csv).join(','));
          }
          process.stdout.write('.');
        } catch (erro) {
          falhas++;
          linhas.push(linhaDeFalha(def, concorrencia, rep, erro));
          process.stdout.write('x');
        }
      }

      const media = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
      const min = (v: number[]): number => (v.length === 0 ? 0 : Math.min(...v));
      const max = (v: number[]): number => (v.length === 0 ? 0 : Math.max(...v));
      console.log(
        `  ${media(tempos).toFixed(0).padStart(6)} ms médio   ` +
          `perdido ${media(perdas).toFixed(1).padStart(8)} ` +
          `(min ${min(perdas)} / max ${max(perdas)})`,
      );
    }
  }

  writeFileSync(join(args.saida, 'resultados.csv'), linhas.join('\n') + '\n');
  writeFileSync(join(args.saida, 'distribuicao.csv'), distribuicao.join('\n') + '\n');
  writeFileSync(join(args.saida, 'serie-leitura-suja.csv'), serie.join('\n') + '\n');

  secao('arquivos gravados');
  console.log(`  ${join(args.saida, 'resultados.csv')}          ${linhas.length - 1} linhas`);
  console.log(`  ${join(args.saida, 'distribuicao.csv')}        ${distribuicao.length - 1} linhas`);
  console.log(`  ${join(args.saida, 'serie-leitura-suja.csv')}  ${serie.length - 1} linhas`);
  if (falhas > 0) console.log(`\n  ${falhas} repetições falharam e estão marcadas com falhou=sim no CSV.`);
  console.log('\n  Gere os gráficos com:  npm run charts\n');
}

if (ehPrincipal(import.meta.url)) {
  const args = lerArgumentos(process.argv.slice(2));
  titulo('BENCHMARK');
  console.log(`  cenários: ${args.cenarios.map((c) => c.nome).join(', ')}`);
  console.log(`  repetições: ${args.repeticoes}   warm-up: ${args.warmup ? 'sim' : 'não'}`);
  if (args.concorrencia) console.log(`  concorrência: ${args.concorrencia.join(', ')}`);
  await rodar(args);
}
