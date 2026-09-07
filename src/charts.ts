/**
 * Lê os CSV de resultados/ e gera os gráficos em SVG, mais um relatório HTML
 * que junta tudo numa página só.
 *
 *   npm run charts                (lê resultados/, escreve resultados/*.svg)
 *
 * Todo gráfico daqui é uma comparação, e o eixo x de quase todos é o número de
 * threads. A linha vertical tracejada marca quantas threads de hardware a
 * máquina que produziu os números tem: é ela que explica por que as curvas de
 * tempo param de cair num ponto e não em outro.
 *
 * Nenhum gráfico é inventado: se o CSV não tiver dados para um deles, ele é
 * pulado com um aviso, em vez de sair um eixo vazio.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ambiente } from './ambiente.js';
import { ehPrincipal, media, secao, titulo } from './relatorio.js';

const SAIDA = process.argv[2] ?? 'resultados';
const VL2SVG = join('node_modules', '.bin', 'vl2svg');

type Linha = Record<string, string>;

/** Parser de CSV pequeno o bastante para caber aqui e certo o bastante para o
 *  que este projeto grava (campos entre aspas com vírgula e aspas dobradas). */
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

/**
 * O nome do caso é um identificador: vive no CSV, nos filtros deste arquivo e no
 * nome do arquivo em src/casos/. Por isso continua sem acento e com hífen. Para
 * a tela, porém, "03-worker-sab-corrida" é ruim. Este mapa traduz identificador
 * em rótulo, e a tradução acontece depois de todo filtro, nunca antes.
 */
const ROTULO: Record<string, string> = {
  '01-baseline-sequencial': '01 baseline sem worker',
  '02-worker-cpu': '02 CPU entre threads',
  '03-worker-sab-corrida': '03 corrida em memória',
  '04-worker-banco': '04 corrida no banco',
  '05-worker-leitura-suja': '05 leitura suja',
  '06-worker-heisenbug-sem-log': '06 heisenbug sem log',
  '06-worker-heisenbug-com-log': '06 heisenbug com log',
};

/** Identificador do caso -> rótulo legível. Sem entrada no mapa, devolve o id. */
function rotulo(caso: string | undefined): string {
  const id = caso ?? '';
  return ROTULO[id] ?? id;
}

interface Grafico {
  arquivo: string;
  titulo: string;
  /** o que este gráfico responde, uma frase. Vai para o relatório HTML. */
  leitura: string;
  spec: Record<string, unknown>;
}

const CONFIG_BASE = {
  background: 'white',
  config: {
    axis: { labelFontSize: 12, titleFontSize: 13 },
    legend: { labelFontSize: 12, titleFontSize: 13 },
    title: { fontSize: 16, anchor: 'start' as const, subtitleFontSize: 12, subtitleColor: '#555' },
    view: { stroke: 'transparent' },
  },
};

const ESQUEMA = 'https://vega.github.io/schema/vega-lite/v6.json';

function lerAmbienteGravado(): Ambiente | undefined {
  const caminho = join(SAIDA, 'ambiente.json');
  if (!existsSync(caminho)) return undefined;
  return JSON.parse(readFileSync(caminho, 'utf8')) as Ambiente;
}

/**
 * As duas camadas que marcam o limite de paralelismo da máquina: uma régua
 * vertical no número de threads de hardware e o texto que diz o que ela é.
 * Entram em todo gráfico cujo eixo x é número de threads.
 */
function camadasDoLimiteDaMaquina(threadsDaMaquina: number, comTexto = true): unknown[] {
  const dados = { values: [{ threads: threadsDaMaquina }] };
  const regua = {
    data: dados,
    mark: { type: 'rule', color: '#c0392b', strokeDash: [5, 4], strokeWidth: 1.5 },
    encoding: { x: { field: 'threads', type: 'quantitative' } },
  };
  if (!comTexto) return [regua];
  return [
    regua,
    {
      data: dados,
      mark: {
        type: 'text',
        align: 'left',
        baseline: 'top',
        dx: 6,
        dy: 4,
        color: '#c0392b',
        fontSize: 11,
        text: `${threadsDaMaquina} threads da máquina`,
      },
      // y em pixel: gruda no topo do painel, longe dos rótulos do eixo x
      encoding: { x: { field: 'threads', type: 'quantitative' }, y: { value: 0 } },
    },
  ];
}

function eixoDeThreads(varredura: number[], titulo: string): Record<string, unknown> {
  return {
    field: 'threads',
    type: 'quantitative',
    scale: { type: 'log', base: 2 },
    axis: { title: titulo, values: varredura, grid: false },
  };
}

export function construirGraficos(): Grafico[] {
  const resultados = lerCsv(join(SAIDA, 'resultados.csv')).filter((l) => l.falhou === 'nao');
  const resumo = lerCsv(join(SAIDA, 'resumo.csv'));
  const serie = lerCsv(join(SAIDA, 'serie-leitura-suja.csv'));
  const ambiente = lerAmbienteGravado();
  const threadsDaMaquina = ambiente?.threadsDaMaquina ?? 0;
  const graficos: Grafico[] = [];

  const varredura = [...new Set(resultados.map((l) => num(l.threads)))].sort((a, b) => a - b);
  const casos = [...new Set(resultados.map((l) => l.caso ?? ''))].sort();
  const subtitulo =
    ambiente === undefined
      ? ''
      : `${ambiente.modeloCpu} · ${ambiente.threadsDaMaquina} threads de hardware · node ${ambiente.node}`;
  const limite = threadsDaMaquina > 0 ? camadasDoLimiteDaMaquina(threadsDaMaquina) : [];
  // nos painéis facetados a régua entra sem texto: repetir a mesma legenda em
  // sete painéis é ruído, e o subtítulo já diz o que ela é
  const limiteSemTexto = threadsDaMaquina > 0 ? camadasDoLimiteDaMaquina(threadsDaMaquina, false) : [];

  const pontos = resultados.map((l) => ({
    caso: rotulo(l.caso),
    threads: num(l.threads),
    perdido: num(l.perdido),
    percentual: num(l.percentual_perdido),
    ms: num(l.ms),
    throughput: num(l.throughput),
  }));

  // ---------------------------------------------- 1. perda x threads, por caso
  // O gráfico que o trabalho pede para TODOS os casos. Um painel por caso, com
  // escala de y própria, porque perder milhões de incrementos e perder algumas
  // centenas de unidades de saldo não cabem no mesmo eixo.
  if (pontos.length > 0) {
    graficos.push({
      arquivo: 'perdido-x-threads-por-caso',
      titulo: 'Dinheiro perdido por número de threads, caso a caso',
      leitura:
        'Cada painel é um caso de uso. Os pontos são repetições individuais, a linha é a média, ' +
        'e a régua vermelha marca o número de threads de hardware da máquina. Onde a linha fica ' +
        'no zero, o caso não perde nada em nenhum número de threads.',
      spec: {
        ...CONFIG_BASE,
        $schema: ESQUEMA,
        title: {
          text: 'Dinheiro perdido por número de threads, caso a caso',
          subtitle: [
            subtitulo,
            'cada ponto é uma repetição, a linha é a média, escala de y própria por painel',
            `a régua vermelha marca as ${threadsDaMaquina} threads de hardware da máquina`,
          ],
        },
        data: { values: pontos },
        facet: { field: 'caso', type: 'nominal', header: { title: null, labelFontSize: 12 } },
        columns: 3,
        spec: {
          width: 240,
          height: 190,
          layer: [
            {
              mark: { type: 'point', size: 26, opacity: 0.4, filled: true, color: '#2c3e6b' },
              encoding: {
                x: eixoDeThreads(varredura, 'threads'),
                y: {
                  field: 'perdido',
                  type: 'quantitative',
                  // notação SI, senão 11460443 vira uma parede de dígitos. O
                  // caso do zero é explícito porque um domínio [0,0] degenera o
                  // passo dos ticks e o formato SI devolve NaN nos painéis dos
                  // casos que não perdem nada
                  axis: {
                    title: 'perdido',
                    labelExpr: "datum.value == 0 ? '0' : format(datum.value, '~s')",
                  },
                },
              },
            },
            {
              mark: { type: 'line', strokeWidth: 2.5, point: true, color: '#2c3e6b' },
              encoding: {
                x: eixoDeThreads(varredura, 'threads'),
                y: { aggregate: 'mean', field: 'perdido', type: 'quantitative' },
              },
            },
            ...limiteSemTexto,
          ],
        },
        resolve: { scale: { y: 'independent' } },
      },
    });
  }

  // ------------------------------------ 2. perda x threads, todos os casos
  // Aqui a métrica é relativa (perdido / movimentado), que é a única forma
  // honesta de pôr casos de escalas diferentes na mesma régua.
  if (pontos.length > 0) {
    graficos.push({
      arquivo: 'perdido-x-threads-comparado',
      titulo: 'Perda relativa por número de threads, todos os casos',
      leitura:
        'A mesma perda do gráfico anterior, agora como percentual do que foi movimentado, que é o ' +
        'que permite comparar casos de escalas diferentes no mesmo eixo. As curvas que ficam ' +
        'coladas no zero são os casos em que as threads não disputam o mesmo estado.',
      spec: {
        ...CONFIG_BASE,
        $schema: ESQUEMA,
        title: {
          text: 'Perda relativa por número de threads',
          subtitle: [subtitulo, 'perdido dividido pelo total movimentado, média das repetições'],
        },
        width: 640,
        height: 400,
        data: { values: pontos },
        layer: [
          {
            mark: { type: 'line', strokeWidth: 2.5, point: true },
            encoding: {
              x: eixoDeThreads(varredura, 'threads de trabalho'),
              y: {
                aggregate: 'mean',
                field: 'percentual',
                type: 'quantitative',
                axis: { title: 'perda relativa (% do movimentado)' },
              },
              color: { field: 'caso', type: 'nominal', legend: { title: 'caso de uso' } },
            },
          },
          ...limite,
        ],
      },
    });
  }

  // ------------------------------------- 3. tempo x threads, todos os casos
  // O baseline roda com uma thread só, então é um ponto solto no meio de seis
  // curvas. Vira uma régua horizontal, que é como ele deve ser lido: o tempo da
  // MESMA carga do caso 04 feita sem worker nenhum.
  const msDoBaseline = media(
    pontos.filter((p) => p.caso === rotulo('01-baseline-sequencial')).map((p) => p.ms),
  );
  const referenciaDoBaseline =
    msDoBaseline > 0
      ? [
          {
            data: { values: [{ ms: msDoBaseline }] },
            mark: { type: 'rule', color: '#2c3e6b', strokeDash: [2, 3], strokeWidth: 1.5 },
            encoding: { y: { field: 'ms', type: 'quantitative' } },
          },
          {
            data: { values: [{ ms: msDoBaseline }] },
            mark: {
              type: 'text',
              align: 'left',
              baseline: 'bottom',
              dx: 4,
              dy: -4,
              color: '#2c3e6b',
              fontSize: 11,
              text: `baseline sem worker: ${msDoBaseline.toFixed(0)} ms (mesma carga do caso 04)`,
            },
            encoding: { y: { field: 'ms', type: 'quantitative' }, x: { value: 0 } },
          },
        ]
      : [];

  if (pontos.length > 0) {
    graficos.push({
      arquivo: 'tempo-x-threads-comparado',
      titulo: 'Tempo por número de threads, todos os casos',
      leitura:
        'Tempo de parede em escala logarítmica, porque as cargas dos casos têm ordens de grandeza ' +
        'diferentes. O que se compara aqui é o formato de cada curva, não a altura: cair até a ' +
        'régua vermelha e achatar depois dela é o comportamento esperado de trabalho paralelizável.',
      spec: {
        ...CONFIG_BASE,
        $schema: ESQUEMA,
        title: {
          text: 'Tempo por número de threads',
          subtitle: [subtitulo, 'média das repetições, eixo y em escala logarítmica'],
        },
        width: 640,
        height: 400,
        layer: [
          {
            data: { values: pontos },
            mark: { type: 'line', strokeWidth: 2.5, point: true },
            encoding: {
              x: eixoDeThreads(varredura, 'threads de trabalho'),
              y: {
                aggregate: 'mean',
                field: 'ms',
                type: 'quantitative',
                scale: { type: 'log' },
                axis: { title: 'tempo total (ms, escala log)' },
              },
              color: { field: 'caso', type: 'nominal', legend: { title: 'caso de uso' } },
            },
          },
          ...referenciaDoBaseline,
          ...limite,
        ],
      },
    });
  }

  // -------------------------------------------- 4. tempo x threads, por caso
  if (pontos.length > 0) {
    graficos.push({
      arquivo: 'tempo-x-threads-por-caso',
      titulo: 'Tempo por número de threads, caso a caso',
      leitura:
        'O mesmo tempo, um painel por caso e escala de y própria, para ver a dispersão entre ' +
        'repetições que a média do gráfico anterior esconde.',
      spec: {
        ...CONFIG_BASE,
        $schema: ESQUEMA,
        title: {
          text: 'Tempo por número de threads, caso a caso',
          subtitle: [
            subtitulo,
            'cada ponto é uma repetição, a linha é a média',
            `a régua vermelha marca as ${threadsDaMaquina} threads de hardware da máquina`,
          ],
        },
        data: { values: pontos },
        facet: { field: 'caso', type: 'nominal', header: { title: null, labelFontSize: 12 } },
        columns: 3,
        spec: {
          width: 240,
          height: 190,
          layer: [
            {
              mark: { type: 'point', size: 26, opacity: 0.4, filled: true, color: '#1d6f5c' },
              encoding: {
                x: eixoDeThreads(varredura, 'threads'),
                y: { field: 'ms', type: 'quantitative', axis: { title: 'tempo (ms)' } },
              },
            },
            {
              mark: { type: 'line', strokeWidth: 2.5, point: true, color: '#1d6f5c' },
              encoding: {
                x: eixoDeThreads(varredura, 'threads'),
                y: { aggregate: 'mean', field: 'ms', type: 'quantitative' },
              },
            },
            ...limiteSemTexto,
          ],
        },
        resolve: { scale: { y: 'independent' } },
      },
    });
  }

  // ------------------------------------------------- 5. ganho de velocidade
  // tempo com 1 thread dividido pelo tempo com N threads, contra a reta ideal.
  // É a comparação de tempo entre casos que não depende da carga de cada um.
  const mediaPorCasoThreads = new Map<string, number>();
  for (const l of resumo) {
    mediaPorCasoThreads.set(`${l.caso}|${num(l.threads)}`, num(l.ms_medio));
  }
  const ganho: { caso: string; threads: number; ganho: number }[] = [];
  for (const caso of casos) {
    const comUma = mediaPorCasoThreads.get(`${caso}|1`);
    if (comUma === undefined || comUma === 0) continue;
    const desteCaso = varredura
      .filter((t) => mediaPorCasoThreads.has(`${caso}|${t}`))
      .map((t) => ({ caso: rotulo(caso), threads: t, ganho: comUma / mediaPorCasoThreads.get(`${caso}|${t}`)! }));
    // uma medida só não desenha curva de escalabilidade
    if (desteCaso.length > 1) ganho.push(...desteCaso);
  }
  if (ganho.length > 0) {
    const ideal = varredura.map((t) => ({ threads: t, ganho: t }));
    // a reta ideal chega ao número de threads da varredura; deixá-la mandar no
    // eixo achataria as curvas reais contra o chão. O teto é o maior ganho
    // medido com folga, e a reta ideal sai cortada, que é a informação certa:
    // ela some para cima porque nenhum caso chegou perto dela
    const tetoDoGanho = Math.max(...ganho.map((g) => g.ganho)) * 1.25;
    graficos.push({
      arquivo: 'ganho-x-threads',
      titulo: 'Ganho de velocidade por número de threads',
      leitura:
        'Tempo com uma thread dividido pelo tempo com N threads. A reta cinza é o ganho ideal ' +
        '(dobrar as threads, dobrar a velocidade). Curvas que se descolam dela antes da régua ' +
        'vermelha estão limitadas por outra coisa que não o número de núcleos: disputa pela mesma ' +
        'linha do banco, custo de subir worker, ou espera de I/O.',
      spec: {
        ...CONFIG_BASE,
        $schema: ESQUEMA,
        title: {
          text: 'Ganho de velocidade por número de threads',
          subtitle: [subtitulo, 'tempo com 1 thread / tempo com N threads, contra o ganho ideal'],
        },
        width: 640,
        height: 400,
        layer: [
          {
            data: { values: ideal },
            mark: { type: 'line', color: '#999', strokeDash: [4, 4], strokeWidth: 1.5, clip: true },
            encoding: {
              x: eixoDeThreads(varredura, 'threads de trabalho'),
              y: {
                field: 'ganho',
                type: 'quantitative',
                scale: { domainMin: 0, domainMax: tetoDoGanho },
                axis: { title: 'ganho sobre 1 thread (x)' },
              },
            },
          },
          {
            data: { values: ganho },
            mark: { type: 'line', strokeWidth: 2.5, point: true },
            encoding: {
              x: eixoDeThreads(varredura, 'threads de trabalho'),
              y: { field: 'ganho', type: 'quantitative' },
              color: { field: 'caso', type: 'nominal', legend: { title: 'caso de uso' } },
            },
          },
          ...limite,
        ],
      },
    });
  }

  // ---------------------------------------- 6. série temporal da leitura suja
  const primeiraSerie = serie.filter((l) => l.repeticao === '1');
  if (primeiraSerie.length > 0) {
    // o eixo é o DESVIO em relação ao total real, não o total cru: assim as
    // sete séries partem da mesma linha do zero e dá para comparar profundidade
    // e frequência dos buracos entre números de threads
    const esperadoPorThreads = new Map<number, number>();
    for (const l of resultados) {
      if ((l.caso ?? '').startsWith('05-')) esperadoPorThreads.set(num(l.threads), num(l.esperado));
    }
    graficos.push({
      arquivo: 'serie-leitura-suja',
      titulo: 'O total lido durante as transferências',
      leitura:
        'Caso 05: um SELECT SUM(saldo) em laço enquanto as threads transferem sem transação. A ' +
        'linha vermelha no zero é o total real, que nunca muda: no fim nenhum centavo se perde. ' +
        'Cada degrau abaixo dela é uma leitura que caiu entre o débito e o crédito de uma ' +
        'transferência. Quanto mais threads transferindo, mais fundos e mais frequentes os degraus.',
      spec: {
        ...CONFIG_BASE,
        $schema: ESQUEMA,
        title: {
          text: 'SELECT SUM(saldo) durante transferências sem transação',
          subtitle: [
            subtitulo,
            'uma execução por número de threads, eixo y como desvio do total real',
          ],
        },
        width: 700,
        height: 360,
        layer: [
          {
            data: {
              values: primeiraSerie.map((l) => ({
                t: num(l.t_ms),
                desvio: num(l.total) - (esperadoPorThreads.get(num(l.threads)) ?? 0),
                threads: Number(l.threads),
              })),
            },
            mark: { type: 'line', strokeWidth: 1, interpolate: 'step-after' },
            encoding: {
              x: { field: 't', type: 'quantitative', axis: { title: 'tempo desde o início (ms)' } },
              y: {
                field: 'desvio',
                type: 'quantitative',
                axis: { title: 'desvio do total real (unidades de saldo)' },
              },
              color: {
                field: 'threads',
                type: 'ordinal',
                sort: 'ascending',
                // viridis em vez do azul ordinal padrão: o tom mais claro da
                // escala padrão some no fundo branco, e a série de 1 thread é
                // justamente a que precisa aparecer, porque é a linha reta
                scale: { scheme: 'viridis' },
                legend: { title: 'threads' },
              },
            },
          },
          {
            data: { values: [{ zero: 0 }] },
            mark: { type: 'rule', color: '#c0392b', strokeDash: [6, 4], strokeWidth: 2 },
            encoding: { y: { field: 'zero', type: 'quantitative' } },
          },
        ],
      },
    });
  }

  return graficos;
}

function gerar(graficos: Grafico[]): string[] {
  const prontos: string[] = [];
  for (const g of graficos) {
    const caminhoSpec = join(SAIDA, `${g.arquivo}.vl.json`);
    const caminhoSvg = join(SAIDA, `${g.arquivo}.svg`);
    writeFileSync(caminhoSpec, JSON.stringify(g.spec, null, 2));
    try {
      execFileSync(VL2SVG, [caminhoSpec, caminhoSvg], { stdio: ['ignore', 'ignore', 'pipe'] });
      console.log(`  ok      ${caminhoSvg}`);
      prontos.push(g.arquivo);
    } catch (erro) {
      const detalhe = erro instanceof Error ? erro.message.split('\n').slice(0, 3).join(' ') : String(erro);
      console.log(`  FALHOU  ${caminhoSvg}   ${detalhe}`);
    }
  }
  return prontos;
}

// ---------------------------------------------------------------------------
// relatório HTML: os gráficos, o ambiente e a tabela do resumo numa página só
// ---------------------------------------------------------------------------
function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tabelaDoResumo(resumo: Linha[]): string {
  if (resumo.length === 0) return '<p>sem resumo.csv</p>';
  const colunas: [string, string][] = [
    ['caso', 'caso'],
    ['threads', 'threads'],
    ['ms_medio', 'tempo médio (ms)'],
    ['ms_desvio', 'desvio (ms)'],
    ['perdido_medio', 'perdido médio'],
    ['perdido_desvio', 'desvio'],
    ['percentual_perdido_medio', 'perda relativa (%)'],
  ];
  const cabecalho = colunas.map(([, t]) => `<th>${escapar(t)}</th>`).join('');
  const corpo = resumo
    .map((l) => {
      const celulas = colunas
        .map(([chave]) => {
          const bruto = l[chave] ?? '';
          const valor = chave === 'caso' ? rotulo(bruto) : bruto;
          const numerico = chave !== 'caso';
          return `<td${numerico ? ' class="n"' : ''}>${escapar(valor)}</td>`;
        })
        .join('');
      return `<tr>${celulas}</tr>`;
    })
    .join('\n');
  return `<table><thead><tr>${cabecalho}</tr></thead><tbody>\n${corpo}\n</tbody></table>`;
}

function escreverRelatorio(graficos: Grafico[], prontos: string[], resumo: Linha[]): void {
  const ambiente = lerAmbienteGravado();
  const svgs = graficos
    .filter((g) => prontos.includes(g.arquivo))
    .map((g) => {
      const svg = readFileSync(join(SAIDA, `${g.arquivo}.svg`), 'utf8');
      return `<section>
  <h2>${escapar(g.titulo)}</h2>
  <p class="leitura">${escapar(g.leitura)}</p>
  <figure>${svg}</figure>
  <p class="fonte">arquivo: <code>${escapar(g.arquivo)}.svg</code></p>
</section>`;
    })
    .join('\n');

  const blocoAmbiente =
    ambiente === undefined
      ? ''
      : `<dl>
  <dt>CPU</dt><dd>${escapar(ambiente.modeloCpu)}</dd>
  <dt>threads de hardware</dt><dd><strong>${ambiente.threadsDaMaquina}</strong></dd>
  <dt>memória</dt><dd>${ambiente.memoriaGb} GB</dd>
  <dt>sistema</dt><dd>${escapar(ambiente.plataforma)}/${escapar(ambiente.arquitetura)}</dd>
  <dt>node</dt><dd>${escapar(ambiente.node)}</dd>
  <dt>medido em</dt><dd>${escapar(ambiente.medidoEm)}</dd>
</dl>`;

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Concorrência com worker_threads: resultados</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0 auto; padding: 32px 24px 64px; max-width: 960px;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         color: #1a1a1a; background: #fff; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 40px 0 6px; padding-top: 24px; border-top: 1px solid #e5e5e5; }
  p.sub { color: #555; margin: 0 0 28px; }
  p.leitura { color: #444; margin: 0 0 14px; max-width: 72ch; }
  p.fonte { color: #888; font-size: 12px; margin: 6px 0 0; }
  figure { margin: 0; overflow-x: auto; }
  figure svg { max-width: 100%; height: auto; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 0 0 8px; }
  dt { color: #666; }
  dd { margin: 0; }
  table { border-collapse: collapse; font-size: 13px; width: 100%; }
  th, td { border-bottom: 1px solid #eee; padding: 5px 8px; text-align: left; }
  th { background: #f6f6f6; font-weight: 600; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
</style>
</head>
<body>
<h1>Concorrência com worker_threads</h1>
<p class="sub">Dinheiro perdido e tempo, por caso de uso e por número de threads.</p>

<h2>A máquina que produziu os números</h2>
<p class="leitura">Toda curva deste relatório tem o número de threads no eixo x, e a régua vermelha
vertical dos gráficos marca o número de threads de hardware desta máquina. É o ponto onde o
paralelismo real acaba: passado ele, mais worker não é mais núcleo, é revezamento.</p>
${blocoAmbiente}

${svgs}

<h2>Resumo numérico</h2>
<p class="leitura">Média e desvio padrão das repetições, por caso e número de threads. A fonte é
<code>resumo.csv</code>; as repetições individuais estão em <code>resultados.csv</code>.</p>
${tabelaDoResumo(resumo)}
</body>
</html>
`;
  const caminho = join(SAIDA, 'relatorio.html');
  writeFileSync(caminho, html);
  console.log(`  ok      ${caminho}`);
}

if (ehPrincipal(import.meta.url)) {
  titulo('GRÁFICOS');
  if (!existsSync(join(SAIDA, 'resultados.csv'))) {
    console.error(`\n[ERRO] Não achei ${join(SAIDA, 'resultados.csv')}.`);
    console.error('       Rode a medição antes:  npm run bench\n');
    process.exit(1);
  }
  const graficos = construirGraficos();
  if (graficos.length === 0) {
    console.error('\n[ERRO] O CSV existe mas não tem dados suficientes para nenhum gráfico.\n');
    process.exit(1);
  }
  secao(`${graficos.length} gráficos`);
  const prontos = gerar(graficos);
  escreverRelatorio(graficos, prontos, lerCsv(join(SAIDA, 'resumo.csv')));
  console.log('');
}
