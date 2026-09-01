/**
 * Le os CSV de resultados/ e gera os graficos em SVG com o vega-lite CLI.
 *
 *   npm run graficos              (le resultados/, escreve resultados/*.svg)
 *
 * Nenhum grafico e inventado: se o CSV nao tiver dados para um deles, ele e
 * pulado com um aviso, em vez de sair um eixo vazio.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ehPrincipal, secao, titulo } from './relatorio.js';

const SAIDA = process.argv[2] ?? 'resultados';
const VL2SVG = join('node_modules', '.bin', 'vl2svg');

type Linha = Record<string, string>;

/** Parser de CSV pequeno o bastante para caber aqui e certo o bastante para o
 *  que este projeto grava (campos entre aspas com virgula e aspas dobradas). */
function lerCsv(caminho: string): Linha[] {
  if (!existsSync(caminho)) return [];
  const texto = readFileSync(caminho, 'utf8').trim();
  if (texto === '') return [];

  const linhas: string[][] = [];
  let campo = '';
  let atual: string[] = [];
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroDeAspas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') {
        dentroDeAspas = false;
      } else {
        campo += c;
      }
    } else if (c === '"') {
      dentroDeAspas = true;
    } else if (c === ',') {
      atual.push(campo);
      campo = '';
    } else if (c === '\n') {
      atual.push(campo);
      linhas.push(atual);
      atual = [];
      campo = '';
    } else if (c !== '\r') {
      campo += c;
    }
  }
  atual.push(campo);
  linhas.push(atual);

  const cabecalho = linhas[0] ?? [];
  return linhas.slice(1).map((valores) => {
    const obj: Linha = {};
    cabecalho.forEach((chave, i) => {
      obj[chave] = valores[i] ?? '';
    });
    return obj;
  });
}

const num = (v: string | undefined): number => Number(v ?? 0);

interface Grafico {
  arquivo: string;
  titulo: string;
  spec: Record<string, unknown>;
}

const CONFIG_BASE = {
  background: 'white',
  config: {
    axis: { labelFontSize: 12, titleFontSize: 13 },
    legend: { labelFontSize: 12, titleFontSize: 13 },
    title: { fontSize: 16, anchor: 'start' as const },
    view: { stroke: 'transparent' },
  },
};

function gerar(graficos: Grafico[]): void {
  for (const g of graficos) {
    const caminhoSpec = join(SAIDA, `${g.arquivo}.vl.json`);
    const caminhoSvg = join(SAIDA, `${g.arquivo}.svg`);
    writeFileSync(caminhoSpec, JSON.stringify(g.spec, null, 2));
    try {
      execFileSync(VL2SVG, [caminhoSpec, caminhoSvg], { stdio: ['ignore', 'ignore', 'pipe'] });
      console.log(`  ok   ${caminhoSvg}`);
    } catch (erro) {
      const detalhe = erro instanceof Error ? erro.message.split('\n')[0] : String(erro);
      console.log(`  FALHOU  ${caminhoSvg}   ${detalhe}`);
    }
  }
}

export function construirGraficos(): Grafico[] {
  const resultados = lerCsv(join(SAIDA, 'resultados.csv')).filter((l) => l.falhou === 'nao');
  const distribuicao = lerCsv(join(SAIDA, 'distribuicao.csv'));
  const serie = lerCsv(join(SAIDA, 'serie-leitura-suja.csv'));
  const graficos: Grafico[] = [];

  /** cenarios cuja unidade de `operacoes` e saque, e nao rodada de hash. */
  const deBanco = (l: Linha): boolean =>
    !['04-event-loop-travado', '06-worker-sab-corrida', '07-worker-cpu'].includes(l.cenario ?? '');

  // ------------------------------------------------------ 1. throughput
  const throughput = resultados.filter(deBanco).map((l) => ({
    cenario: l.cenario,
    concorrencia: num(l.concorrencia),
    throughput: num(l.throughput),
  }));
  if (throughput.length > 0) {
    graficos.push({
      arquivo: 'throughput-x-concorrencia',
      titulo: 'throughput x concorrencia',
      spec: {
        ...CONFIG_BASE,
        $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
        title: 'Throughput por concorrencia (media das repeticoes)',
        width: 620,
        height: 380,
        data: { values: throughput },
        mark: { type: 'line', point: true, strokeWidth: 2 },
        encoding: {
          x: {
            field: 'concorrencia',
            type: 'quantitative',
            scale: { type: 'log', base: 2 },
            axis: { title: 'concorrencia (promises ou workers)', values: [1, 2, 4, 8, 16, 32, 64] },
          },
          y: { aggregate: 'mean', field: 'throughput', type: 'quantitative', axis: { title: 'operacoes por segundo' } },
          color: { field: 'cenario', type: 'nominal', legend: { title: 'cenario' } },
        },
      },
    });
  }

  // -------------------------------------------- 2. dinheiro perdido + dispersao
  const perdido = resultados.filter(deBanco).map((l) => ({
    cenario: l.cenario,
    concorrencia: num(l.concorrencia),
    perdido: num(l.perdido),
  }));
  if (perdido.length > 0) {
    graficos.push({
      arquivo: 'dinheiro-perdido-x-concorrencia',
      titulo: 'dinheiro perdido x concorrencia',
      spec: {
        ...CONFIG_BASE,
        $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
        title: 'Dinheiro perdido por concorrencia (cada ponto e uma repeticao)',
        width: 620,
        height: 380,
        data: { values: perdido },
        layer: [
          {
            mark: { type: 'point', size: 34, opacity: 0.45, filled: true },
            encoding: {
              x: { field: 'concorrencia', type: 'quantitative', scale: { type: 'log', base: 2 } },
              y: { field: 'perdido', type: 'quantitative' },
              color: { field: 'cenario', type: 'nominal' },
            },
          },
          {
            mark: { type: 'line', strokeWidth: 2.5 },
            encoding: {
              x: { field: 'concorrencia', type: 'quantitative', scale: { type: 'log', base: 2 } },
              y: { aggregate: 'mean', field: 'perdido', type: 'quantitative' },
              color: { field: 'cenario', type: 'nominal' },
            },
          },
        ],
        encoding: {
          x: { axis: { title: 'concorrencia', values: [1, 2, 4, 8, 16, 32, 64] } },
          y: { axis: { title: 'dinheiro perdido (unidades de saldo)' } },
        },
        resolve: { scale: { color: 'shared' } },
      },
    });
  }

  // --------------------------------------- 3. distribuicao por trabalhador
  const alvosDistribuicao = ['02-corrida-sem-thread', '08-worker-banco'];
  const dist = distribuicao.filter((l) => alvosDistribuicao.includes(l.cenario ?? ''));
  if (dist.length > 0) {
    // usa, de cada cenario, a maior concorrencia medida e a primeira repeticao
    const maiorPorCenario = new Map<string, number>();
    for (const l of dist) {
      const c = num(l.concorrencia);
      const cenario = l.cenario ?? '';
      if (c > (maiorPorCenario.get(cenario) ?? 0)) maiorPorCenario.set(cenario, c);
    }
    const valores = dist
      .filter((l) => num(l.concorrencia) === maiorPorCenario.get(l.cenario ?? '') && l.repeticao === '1')
      .map((l) => ({
        cenario: l.cenario,
        trabalhador: num(l.trabalhador),
        operacoes: num(l.operacoes),
      }));
    if (valores.length > 0) {
      graficos.push({
        arquivo: 'distribuicao-por-trabalhador',
        titulo: 'distribuicao de operacoes por trabalhador',
        spec: {
          ...CONFIG_BASE,
          $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
          title: 'Operacoes concluidas por trabalhador (uma repeticao, maior concorrencia)',
          width: 300,
          height: 340,
          data: { values: valores },
          mark: { type: 'bar' },
          encoding: {
            x: { field: 'trabalhador', type: 'ordinal', axis: { title: 'indice do trabalhador', labelAngle: 0 } },
            y: { field: 'operacoes', type: 'quantitative', axis: { title: 'operacoes concluidas' } },
            color: { field: 'cenario', type: 'nominal', legend: null },
            column: { field: 'cenario', type: 'nominal', header: { title: null } },
          },
        },
      });
    }
  }

  // ------------------------------- 4. CPU: event loop unico vs worker_threads
  const cpuWorkers = resultados
    .filter((l) => l.cenario === '07-worker-cpu')
    .map((l) => ({ abordagem: 'worker_threads', workers: num(l.concorrencia), ms: num(l.ms) }));
  const cpuLoop = resultados
    .filter((l) => l.cenario === '04-event-loop-travado')
    .map((l) => ({ abordagem: 'event loop unico (async)', workers: 1, ms: num(l.ms) }));
  if (cpuWorkers.length > 0) {
    const valores = [...cpuWorkers, ...cpuLoop];
    const maxWorkers = Math.max(...cpuWorkers.map((v) => v.workers));
    // o event loop unico nao melhora com "mais concorrencia": vira uma reta
    const loopEstendido = cpuLoop.flatMap((v) =>
      [1, 2, 4, 8, 16].filter((w) => w <= maxWorkers).map((w) => ({ ...v, workers: w })),
    );
    graficos.push({
      arquivo: 'cpu-loop-vs-workers',
      titulo: 'CPU: event loop unico vs worker_threads',
      spec: {
        ...CONFIG_BASE,
        $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
        title: 'Mesmo trabalho de CPU: event loop unico contra worker_threads',
        width: 560,
        height: 360,
        data: { values: [...valores, ...loopEstendido] },
        mark: { type: 'line', point: true, strokeWidth: 2.5 },
        encoding: {
          x: {
            field: 'workers',
            type: 'quantitative',
            scale: { type: 'log', base: 2 },
            axis: { title: 'numero de workers', values: [1, 2, 4, 8, 16] },
          },
          y: { aggregate: 'mean', field: 'ms', type: 'quantitative', axis: { title: 'tempo total (ms)' } },
          color: { field: 'abordagem', type: 'nominal', legend: { title: null, orient: 'top-right' } },
          strokeDash: { field: 'abordagem', type: 'nominal', legend: null },
        },
      },
    });
  }

  // ------------------------------------------- 5. serie temporal da leitura suja
  const primeiraSerie = serie.filter((l) => l.repeticao === '1');
  if (primeiraSerie.length > 0) {
    const esperado = num(
      resultados.find((l) => l.cenario === '10-leitura-suja')?.esperado ?? '0',
    );
    graficos.push({
      arquivo: 'serie-leitura-suja',
      titulo: 'serie temporal da leitura suja',
      spec: {
        ...CONFIG_BASE,
        $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
        title: 'SELECT SUM(saldo) durante transferencias sem transacao',
        width: 700,
        height: 340,
        layer: [
          {
            data: {
              values: primeiraSerie.map((l) => ({
                t: num(l.t_ms),
                total: num(l.total),
                concorrencia: l.concorrencia,
              })),
            },
            mark: { type: 'line', strokeWidth: 1, interpolate: 'step-after' },
            encoding: {
              x: { field: 't', type: 'quantitative', axis: { title: 'tempo desde o inicio (ms)' } },
              y: {
                field: 'total',
                type: 'quantitative',
                scale: { zero: false },
                axis: { title: 'SUM(saldo) observado' },
              },
              color: { field: 'concorrencia', type: 'nominal', legend: { title: 'workers' } },
            },
          },
          {
            data: { values: [{ esperado }] },
            mark: { type: 'rule', color: '#c0392b', strokeDash: [6, 4], strokeWidth: 2 },
            encoding: { y: { field: 'esperado', type: 'quantitative' } },
          },
        ],
      },
    });
  }

  return graficos;
}

if (ehPrincipal(import.meta.url)) {
  titulo('GRAFICOS');
  if (!existsSync(join(SAIDA, 'resultados.csv'))) {
    console.error(`\n[ERRO] Nao achei ${join(SAIDA, 'resultados.csv')}.`);
    console.error('       Rode o benchmark antes:  npm run bench -- --cenarios todos\n');
    process.exit(1);
  }
  const graficos = construirGraficos();
  if (graficos.length === 0) {
    console.error('\n[ERRO] O CSV existe mas nao tem dados suficientes para nenhum grafico.\n');
    process.exit(1);
  }
  secao(`${graficos.length} graficos`);
  gerar(graficos);
  console.log('');
}
