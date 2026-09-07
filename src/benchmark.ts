/**
 * Runner de medição.
 *
 *   npx tsx src/benchmark.ts --cases 03,04 --threads 1,2,4,8 --repetitions 10
 *
 * Regras da medição:
 *   - uma execução de warm-up é descartada antes de cada série
 *   - o estado do banco é recriado antes de CADA repetição (cada caso chama
 *     resetar() no início do próprio executar)
 *   - grava UMA LINHA POR REPETIÇÃO em resultados/resultados.csv, nunca só a
 *     média: a dispersão entre repetições é metade do que este projeto mostra
 *   - nenhum caso aborta o benchmark; erro vira linha com a coluna `falhou`
 *   - a varredura de threads é derivada da máquina, e a máquina vai junto para
 *     resultados/ambiente.json, porque uma curva de threads sem saber quantas
 *     threads a máquina tem não quer dizer nada
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lerAmbiente, varreduraDeThreads } from './ambiente.js';
import { criarPool, fecharPool, lerConfig, verificarConexao } from './db.js';
import { desvio, ehPrincipal, media, secao, titulo } from './relatorio.js';
import type { Amostra, OpcoesCaso, ResultadoCaso } from './tipos.js';

interface Modulo {
  executar: (o: OpcoesCaso) => Promise<ResultadoCaso>;
}

interface Definicao {
  /** prefixo usado em --cases e nome da série no CSV */
  nome: string;
  /** uma linha, para o cabeçalho da medição e para o relatório HTML */
  resumo: string;
  carregar: () => Promise<Modulo>;
  /**
   * `'maquina'` usa a varredura derivada de os.availableParallelism().
   * Uma lista fixa é para o caso que não escala em threads (o baseline).
   */
  varredura: 'maquina' | number[];
  /** carga total por repetição, dividida entre as threads */
  operacoesPadrao: number;
  /**
   * true quando `operações` não é "número de saques" e sim outra escala
   * (rodadas de mistura, incrementos). Estes ignoram --operations.
   */
  escalaPropria: boolean;
  valorSaque?: number;
  logNaSecaoCritica?: boolean;
}

const CASOS: Definicao[] = [
  {
    nome: '01-baseline-sequencial',
    resumo: 'saques um a um na thread principal, sem worker nenhum',
    carregar: () => import('./casos/01-baseline-sequencial.js'),
    varredura: [1],
    operacoesPadrao: 200,
    escalaPropria: false,
  },
  {
    nome: '02-worker-cpu',
    resumo: 'trabalho de CPU dividido entre threads, sem estado compartilhado',
    carregar: () => import('./casos/02-worker-cpu.js'),
    varredura: 'maquina',
    operacoesPadrao: 400_000_000,
    escalaPropria: true,
  },
  {
    nome: '03-worker-sab-corrida',
    resumo: 'threads incrementando o mesmo Int32Array, sem Atomics',
    carregar: () => import('./casos/03-worker-sab-corrida.js'),
    varredura: 'maquina',
    operacoesPadrao: 16_000_000,
    escalaPropria: true,
  },
  {
    nome: '04-worker-banco',
    resumo: 'threads sacando da mesma conta, read-modify-write sem lock',
    carregar: () => import('./casos/04-worker-banco.js'),
    varredura: 'maquina',
    operacoesPadrao: 200,
    escalaPropria: false,
  },
  {
    nome: '05-worker-leitura-suja',
    resumo: 'threads transferindo sem transação, com um dashboard olhando',
    carregar: () => import('./casos/05-worker-leitura-suja.js'),
    varredura: 'maquina',
    operacoesPadrao: 40,
    escalaPropria: false,
  },
  {
    nome: '06-worker-heisenbug-sem-log',
    resumo: 'a corrida do caso 03 medida sem observador',
    carregar: () => import('./casos/06-worker-heisenbug.js'),
    varredura: 'maquina',
    operacoesPadrao: 200_000,
    escalaPropria: true,
    logNaSecaoCritica: false,
  },
  {
    nome: '06-worker-heisenbug-com-log',
    resumo: 'a mesma corrida com um console.error dentro da seção crítica',
    carregar: () => import('./casos/06-worker-heisenbug.js'),
    varredura: 'maquina',
    operacoesPadrao: 200_000,
    escalaPropria: true,
    logNaSecaoCritica: true,
  },
];

// ---------------------------------------------------------------------------
// argumentos
// ---------------------------------------------------------------------------
interface Argumentos {
  casos: Definicao[];
  threads?: number[];
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

function selecionarCasos(bruto: string): Definicao[] {
  const chave = bruto.trim().toLowerCase();
  if (chave === 'all' || chave === '') return CASOS;

  const pedidos = chave.split(',').map((p) => p.trim());
  const escolhidos: Definicao[] = [];
  for (const pedido of pedidos) {
    const achados = CASOS.filter((c) => c.nome === pedido || c.nome.startsWith(`${pedido}-`));
    if (achados.length === 0) {
      console.error(`\n[ERRO] Caso "${pedido}" não existe. Disponíveis:`);
      for (const c of CASOS) console.error(`       ${c.nome}`);
      process.exit(1);
    }
    escolhidos.push(...achados);
  }
  return escolhidos;
}

const AJUDA = `
Uso: npx tsx src/benchmark.ts [opções]

  --cases LISTA        nomes separados por vírgula, ou "all". Aceita prefixo:
                       --cases 03,04  |  --cases 06
  --threads LISTA      ex: 1,2,4,8,16 (padrão: a varredura derivada da máquina)
  --repetitions N      padrão 10, uma linha no CSV por repetição
  --operations N       carga total por repetição, dividida entre as threads.
                       Casos de CPU e de memória ignoram, porque a escala deles
                       é outra
  --no-warmup          não descarta a primeira execução de cada série
  --output DIR         padrão: resultados

O caso 06-com-log escreve em stderr de propósito, porque o custo dessa escrita é
o experimento. Rode com 2>/dev/null para não afogar o terminal.
`;

function lerArgumentos(argv: string[]): Argumentos {
  const args: Argumentos = {
    casos: CASOS,
    repeticoes: 10,
    warmup: true,
    saida: 'resultados',
  };
  for (let i = 0; i < argv.length; i++) {
    const chave = argv[i];
    const valor = argv[i + 1];
    switch (chave) {
      case '--cases':
        args.casos = selecionarCasos(valor ?? 'all');
        i++;
        break;
      case '--threads':
        args.threads = listaDeNumeros(valor ?? '');
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

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function csv(valor: unknown): string {
  const s = String(valor ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUNAS = [
  'caso',
  'threads',
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
  'percentual_perdido',
  'erros_total',
  'erros_por_sqlstate',
  'ops_por_thread',
  'extra',
  'falhou',
  'erro',
] as const;

/**
 * Perda relativa ao que foi movimentado.
 *
 * Sem isto, comparar casos no mesmo eixo seria desonesto: o caso 03 perde
 * milhões de incrementos e o caso 04 perde algumas centenas de unidades de
 * saldo. O percentual põe os dois na mesma régua. Quando nada se movimentou, a
 * perda relativa é zero por definição, e não uma divisão por zero.
 */
export function percentualPerdido(movimentos: number, perdido: number): number {
  if (movimentos === 0) return 0;
  return Number(((perdido / Math.abs(movimentos)) * 100).toFixed(4));
}

/**
 * Guarda só os pontos em que o total observado mudou.
 *
 * O observador do caso 05 lê o total tão rápido quanto o Postgres responde, e
 * 97% das amostras repetem o valor da anterior. O gráfico é uma linha
 * `step-after`, que precisa dos pontos de mudança e de mais nada: a última
 * amostra entra junto para o degrau final ter onde terminar. Sem isto o CSV
 * passa de meio megabyte para desenhar exatamente a mesma figura.
 */
export function comprimirSerie(serie: Amostra[]): Amostra[] {
  if (serie.length === 0) return [];
  const guardadas: Amostra[] = [serie[0]!];
  for (let i = 1; i < serie.length; i++) {
    if (serie[i]!.valor !== serie[i - 1]!.valor) guardadas.push(serie[i]!);
  }
  const ultima = serie[serie.length - 1]!;
  if (guardadas[guardadas.length - 1] !== ultima) guardadas.push(ultima);
  return guardadas;
}

function linhaDoResultado(repeticao: number, r: ResultadoCaso): string {
  const errosTotal = Object.values(r.erros).reduce((a, b) => a + b, 0);
  return [
    r.caso,
    r.threads,
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
    percentualPerdido(r.invariante.movimentos, r.invariante.perdido),
    errosTotal,
    JSON.stringify(r.erros),
    JSON.stringify(r.porThread),
    JSON.stringify(r.extra ?? {}),
    'nao',
    '',
  ]
    .map(csv)
    .join(',');
}

function linhaDeFalha(def: Definicao, threads: number, repeticao: number, erro: unknown): string {
  const vazio = COLUNAS.length - 5;
  return [
    def.nome,
    threads,
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
  const ambiente = lerAmbiente();
  const pool = criarPool(2, cfg);
  await verificarConexao(pool);
  await fecharPool(pool);

  mkdirSync(args.saida, { recursive: true });

  const linhas: string[] = [COLUNAS.join(',')];
  const resumo: string[] = [
    'caso,threads,repeticoes,ms_medio,ms_desvio,throughput_medio,perdido_medio,perdido_desvio,percentual_perdido_medio',
  ];
  const serie: string[] = ['caso,threads,repeticao,t_ms,total'];

  let falhas = 0;

  for (const def of args.casos) {
    const modulo = await def.carregar();
    const varredura =
      def.varredura === 'maquina'
        ? args.threads ?? varreduraDeThreads(ambiente.threadsDaMaquina)
        : def.varredura;
    const operacoes = def.escalaPropria
      ? def.operacoesPadrao
      : args.operacoes ?? def.operacoesPadrao;

    secao(`${def.nome}   carga=${operacoes.toLocaleString('pt-BR')}   ${def.resumo}`);

    for (const threads of varredura) {
      const opts: OpcoesCaso = {
        operacoes,
        threads,
        threadsMaximas: Math.max(...varredura),
        valorSaque: def.valorSaque ?? cfg.valorSaque,
        logNaSecaoCritica: def.logNaSecaoCritica,
      };

      if (args.warmup) {
        process.stdout.write(`  threads=${String(threads).padStart(3)}  warm-up... `);
        try {
          await modulo.executar(opts);
        } catch {
          // warm-up não entra no CSV nem interrompe nada
        }
      } else {
        process.stdout.write(`  threads=${String(threads).padStart(3)}  `);
      }

      const tempos: number[] = [];
      const perdas: number[] = [];
      const percentuais: number[] = [];
      const vazoes: number[] = [];
      let nome = def.nome;

      for (let rep = 1; rep <= args.repeticoes; rep++) {
        try {
          const r = await modulo.executar(opts);
          nome = r.caso;
          linhas.push(linhaDoResultado(rep, r));
          tempos.push(r.ms);
          perdas.push(r.invariante.perdido);
          percentuais.push(percentualPerdido(r.invariante.movimentos, r.invariante.perdido));
          vazoes.push(r.throughput);

          // a série temporal só da primeira repetição, e só nos pontos em que o
          // valor mudou: as dez repetições juntas explodiriam o CSV sem
          // acrescentar nada ao gráfico, que mostra uma execução
          if (rep === 1) {
            for (const a of comprimirSerie(r.serie ?? [])) {
              serie.push([r.caso, r.threads, rep, a.t, a.valor].map(csv).join(','));
            }
          }
          process.stdout.write('.');
        } catch (erro) {
          falhas++;
          linhas.push(linhaDeFalha(def, threads, rep, erro));
          process.stdout.write('x');
        }
      }

      resumo.push(
        [
          nome,
          threads,
          tempos.length,
          media(tempos).toFixed(3),
          desvio(tempos).toFixed(3),
          media(vazoes).toFixed(3),
          media(perdas).toFixed(3),
          desvio(perdas).toFixed(3),
          media(percentuais).toFixed(4),
        ]
          .map(csv)
          .join(','),
      );

      console.log(
        `  ${media(tempos).toFixed(0).padStart(7)} ms médio   ` +
          `perdido ${media(perdas).toFixed(1).padStart(10)} ` +
          `(${media(percentuais).toFixed(1).padStart(5)}% do movimentado)`,
      );
    }
  }

  writeFileSync(join(args.saida, 'resultados.csv'), linhas.join('\n') + '\n');
  writeFileSync(join(args.saida, 'resumo.csv'), resumo.join('\n') + '\n');
  writeFileSync(join(args.saida, 'serie-leitura-suja.csv'), serie.join('\n') + '\n');
  writeFileSync(join(args.saida, 'ambiente.json'), JSON.stringify(ambiente, null, 2) + '\n');

  secao('arquivos gravados');
  console.log(`  ${join(args.saida, 'resultados.csv')}          ${linhas.length - 1} linhas`);
  console.log(`  ${join(args.saida, 'resumo.csv')}              ${resumo.length - 1} linhas`);
  console.log(`  ${join(args.saida, 'serie-leitura-suja.csv')}  ${serie.length - 1} linhas`);
  console.log(`  ${join(args.saida, 'ambiente.json')}`);
  if (falhas > 0) {
    console.log(`\n  ${falhas} repetições falharam e estão marcadas com falhou=sim no CSV.`);
  }
  console.log('\n  Gere os gráficos e o relatório com:  npm run charts\n');
}

if (ehPrincipal(import.meta.url)) {
  const args = lerArgumentos(process.argv.slice(2));
  const ambiente = lerAmbiente();
  titulo('MEDIÇÃO');
  console.log(`  máquina: ${ambiente.modeloCpu}, ${ambiente.threadsDaMaquina} threads de hardware`);
  console.log(`  node ${ambiente.node} em ${ambiente.plataforma}/${ambiente.arquitetura}`);
  console.log(`  casos: ${args.casos.map((c) => c.nome).join(', ')}`);
  console.log(`  repetições: ${args.repeticoes}   warm-up: ${args.warmup ? 'sim' : 'não'}`);
  console.log(
    `  varredura de threads: ` +
      (args.threads ?? varreduraDeThreads(ambiente.threadsDaMaquina)).join(', '),
  );
  await rodar(args);
}
