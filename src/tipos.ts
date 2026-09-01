/**
 * Tipos compartilhados entre os cenarios, o runner de benchmark e os graficos.
 * Todo cenario devolve o MESMO formato, para que o benchmark trate "sequencial"
 * e "worker-sab-corrida" pela mesma porta.
 */

/**
 * A invariante do projeto.
 *
 * Um saque diminui a soma dos saldos DE PROPOSITO, entao comparar o total final
 * com o total inicial cru acusaria perda onde nao houve. A ancora e o razao: a
 * tabela `movimentos` registra tudo o que o banco de fato movimentou.
 *
 *     esperado    = saldoInicial + SUM(movimentos.valor)
 *     divergencia = observado - esperado
 *
 * Funciona para os tres formatos de cenario:
 *   saque         -> um movimento negativo por operacao, esperado cai
 *   transferencia -> um movimento negativo e um positivo, esperado nao muda
 *   contador SAB  -> "movimentos" e a soma dos incrementos que os workers dizem
 *                    ter feito, "observado" e o valor final do Int32Array
 *
 * divergencia > 0  o banco pagou e nao debitou (o classico do lost update)
 * divergencia < 0  dinheiro sumiu das contas
 */
export interface Invariante {
  /** soma dos saldos logo apos o seed */
  saldoInicial: number;
  /** SUM(movimentos.valor): negativo quando saiu dinheiro */
  movimentos: number;
  /** saldoInicial + movimentos, o que a contabilidade manda */
  esperado: number;
  /** SUM(saldo) de verdade, no fim do cenario */
  observado: number;
  /** observado - esperado. Diferente de zero = invariante quebrada. */
  divergencia: number;
  /** modulo da divergencia. E a metrica principal dos graficos. */
  perdido: number;
}

/** Uma amostra da serie temporal do cenario 10 (leitura suja). */
export interface Amostra {
  /** milissegundos desde o inicio do cenario */
  t: number;
  valor: number;
}

export interface ResultadoCenario {
  cenario: string;
  concorrencia: number;
  /** operacoes pedidas */
  operacoes: number;
  /** operacoes que terminaram sem excecao */
  concluidas: number;

  /** tempo de parede da fase medida, em ms (perf_hooks) */
  ms: number;
  /** operacoes concluidas por segundo */
  throughput: number;

  invariante: Invariante;

  /** contagem de erros por SQLSTATE (ou pseudo-codigo, ver classificarErro) */
  erros: Record<string, number>;

  /** operacoes concluidas por promise/worker, na ordem dos indices */
  porTrabalhador: number[];

  /** maior intervalo entre duas batidas do heartbeat, onde faz sentido medir */
  maiorLacunaEventLoopMs?: number;

  /** serie temporal, usada pelo cenario 10 */
  serie?: Amostra[];

  /** campos de um cenario so, que viram colunas extras no CSV */
  extra?: Record<string, number | string | boolean>;
}

/** Opcoes que o benchmark passa para qualquer cenario. */
export interface OpcoesCenario {
  operacoes: number;
  concorrencia: number;
  valorSaque: number;
  /** cenario 11: liga o console.log dentro da secao critica */
  logNaSecaoCritica?: boolean;
  /** silencia a saida propria do cenario quando ele roda dentro do benchmark */
  silencioso?: boolean;
}
