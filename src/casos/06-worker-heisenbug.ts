/**
 * CASO 06 - o heisenbug: o log que muda a medida
 *
 * O caso 03 inteiro, com uma única diferença: uma flag que insere um
 * `console.error` dentro da seção crítica, entre ler e escrever o Int32Array.
 *
 * O log não corrige nada. Ele só muda o tempo. E como a corrida depende de duas
 * threads caírem na mesma janela, mudar o tempo muda a frequência com que ela
 * acontece. A janela entre ler e escrever uma posição de memória é de
 * nanossegundos, e uma escrita em stderr custa microssegundos: a perturbação é
 * milhares de vezes maior do que a janela que ela deveria observar, e a perda
 * medida despenca.
 *
 * A conclusão não é "log esconde bug". É que o log esconde o bug quando ele é
 * grande perto da janela da corrida. Como ninguém sabe de cabeça o tamanho dessa
 * janela, um print nunca é prova de nada.
 *
 * O benchmark roda este caso duas vezes por número de threads, com e sem log, e
 * as duas curvas entram nos gráficos como casos distintos. Reaproveitar o
 * `executar` do caso 03 não é economia de código: é a garantia de que a única
 * variável entre as duas curvas é a linha de log.
 *
 * Os logs vão para stderr, porque o custo da escrita é o próprio experimento.
 * Rode a medição com `2>/dev/null` para não afogar o terminal.
 */
import type { OpcoesCaso, ResultadoCaso } from '../tipos.js';
import { executar as executarCorridaSab } from './03-worker-sab-corrida.js';

export const NOME = '06-worker-heisenbug';

/**
 * Bem menor que o do caso 03: com log, cada incremento vira uma escrita em
 * stderr, e dezesseis milhões delas levariam horas por repetição. Como no caso
 * 03, o total é fixo e dividido entre as threads.
 */
export const INCREMENTOS_TOTAIS = 200_000;

export async function executar(opts: OpcoesCaso): Promise<ResultadoCaso> {
  const comLog = opts.logNaSecaoCritica === true;
  const r = await executarCorridaSab(opts);
  return {
    ...r,
    caso: comLog ? `${NOME}-com-log` : `${NOME}-sem-log`,
    extra: { ...r.extra, logNaSecaoCritica: comLog },
  };
}
