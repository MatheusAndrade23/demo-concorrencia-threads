/**
 * Tipos compartilhados entre os casos de uso, o runner de benchmark e os
 * gráficos. Todo caso devolve o MESMO formato, para que "baseline sequencial" e
 * "corrida em SharedArrayBuffer" caiam na mesma tabela e no mesmo eixo.
 */

/**
 * A invariante do projeto.
 *
 * Um saque diminui a soma dos saldos DE PROPÓSITO, então comparar o total final
 * com o total inicial cru acusaria perda onde não houve. A âncora é o razão: a
 * tabela `movimentos` registra tudo o que o banco de fato movimentou.
 *
 *     esperado    = saldoInicial + SUM(movimentos.valor)
 *     divergência = observado - esperado
 *
 * Funciona para os três formatos de caso:
 *   saque         -> um movimento negativo por operação, esperado cai
 *   transferência -> um movimento negativo e um positivo, esperado não muda
 *   contador SAB  -> "movimentos" é a soma dos incrementos que as threads dizem
 *                    ter feito, "observado" é o valor final do Int32Array
 *
 * divergência > 0  o banco pagou e não debitou (o clássico do lost update)
 * divergência < 0  dinheiro sumiu das contas
 */
export interface Invariante {
  /** soma dos saldos logo após o seed */
  saldoInicial: number;
  /** SUM(movimentos.valor): negativo quando saiu dinheiro */
  movimentos: number;
  /** saldoInicial + movimentos, o que a contabilidade manda */
  esperado: number;
  /** SUM(saldo) de verdade, no fim do caso */
  observado: number;
  /** observado - esperado. Diferente de zero = invariante quebrada. */
  divergencia: number;
  /** módulo da divergência. É a métrica principal dos gráficos. */
  perdido: number;
}

/** Uma amostra da série temporal do caso 05 (leitura suja). */
export interface Amostra {
  /** milissegundos desde o início do caso */
  t: number;
  valor: number;
}

export interface ResultadoCaso {
  caso: string;
  /**
   * Threads de trabalho usadas nesta execução.
   *
   * Em todo caso com `worker_threads` é o número de workers. No baseline
   * sequencial é 1, porque o trabalho inteiro acontece na thread principal.
   * É o eixo x de quase todo gráfico deste projeto.
   */
  threads: number;
  /** operações pedidas */
  operacoes: number;
  /** operações que terminaram sem exceção */
  concluidas: number;

  /** tempo de parede da fase medida, em ms (perf_hooks) */
  ms: number;
  /** operações concluídas por segundo */
  throughput: number;

  invariante: Invariante;

  /** contagem de erros por SQLSTATE (ou pseudo-código, ver classificarErro) */
  erros: Record<string, number>;

  /** operações concluídas por thread, na ordem dos índices */
  porThread: number[];

  /** série temporal, usada pelo caso 05 */
  serie?: Amostra[];

  /** campos de um caso só, que viram colunas extras no CSV */
  extra?: Record<string, number | string | boolean>;
}

/** Opções que o benchmark passa para qualquer caso. */
export interface OpcoesCaso {
  operacoes: number;
  /** quantas threads de trabalho subir nesta execução */
  threads: number;
  /**
   * O maior valor da varredura de threads desta série.
   *
   * Só o caso 05 usa: ele precisa de um par de contas por thread, e semear
   * `threads * 2` contas faria cada ponto da varredura medir um sistema com
   * outro tanto de dinheiro, o que tornaria as séries temporais incomparáveis
   * entre si. Com o teto, o seed é idêntico em toda a varredura e a única
   * variável é o número de threads.
   */
  threadsMaximas?: number;
  valorSaque: number;
  /** caso 06: liga o console.error dentro da seção crítica */
  logNaSecaoCritica?: boolean;
}
