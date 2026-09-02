/**
 * Tipos compartilhados entre os cenários, o runner de benchmark e os gráficos.
 * Todo cenário devolve o MESMO formato, para que o benchmark trate "sequencial"
 * e "worker-sab-corrida" pela mesma porta.
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
 * Funciona para os tres formatos de cenário:
 *   saque         -> um movimento negativo por operação, esperado cai
 *   transferência -> um movimento negativo e um positivo, esperado não muda
 *   contador SAB  -> "movimentos" é a soma dos incrementos que os workers dizem
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
  /** SUM(saldo) de verdade, no fim do cenário */
  observado: number;
  /** observado - esperado. Diferente de zero = invariante quebrada. */
  divergencia: number;
  /** módulo da divergência. E a métrica principal dos gráficos. */
  perdido: number;
}

/** Uma amostra da série temporal do cenário 10 (leitura suja). */
export interface Amostra {
  /** milissegundos desde o início do cenário */
  t: number;
  valor: number;
}

export interface ResultadoCenario {
  cenario: string;
  concorrencia: number;
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

  /** operações concluídas por promise/worker, na ordem dos índices */
  porTrabalhador: number[];

  /** maior intervalo entre duas batidas do heartbeat, onde faz sentido medir */
  maiorLacunaEventLoopMs?: number;

  /** série temporal, usada pelo cenário 10 */
  serie?: Amostra[];

  /** campos de um cenário só, que viram colunas extras no CSV */
  extra?: Record<string, number | string | boolean>;
}

/** Opções que o benchmark passa para qualquer cenário. */
export interface OpcoesCenario {
  operacoes: number;
  concorrencia: number;
  valorSaque: number;
  /** cenário 11: liga o console.log dentro da seção crítica */
  logNaSecaoCritica?: boolean;
  /** silencia a saída própria do cenário quando ele roda dentro do benchmark */
  silencioso?: boolean;
}
