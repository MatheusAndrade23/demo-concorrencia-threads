/**
 * Worker do cenario 10. Transferencias SEM transacao.
 *
 * Cada worker tem o proprio par de contas, entao nao ha disputa por linha e nada
 * se perde no fim. O problema e outro: entre o debito e o credito existe um
 * intervalo em que o dinheiro nao esta em conta nenhuma, e qualquer relatorio
 * que passar por ali enxerga um total que nunca foi verdade.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ContadorDeErros, criarPool, fecharPool, paraNumero } from '../db.js';
import type { EntradaWorker, SaidaWorker } from './protocolo.js';

export interface ParamsTransferencia {
  de: number;
  para: number;
  valor: number;
  transferencias: number;
  /** quanto tempo o dinheiro fica "no ar" entre o debito e o credito */
  pausaMs: number;
  origem: string;
}
export interface ResultadoTransferencia {
  concluidas: number;
  erros: Record<string, number>;
}

const entrada = workerData as EntradaWorker<ParamsTransferencia>;
const { de, para, valor, transferencias, pausaMs, origem } = entrada.params;

const pool = criarPool(2, entrada.config);
const erros = new ContadorDeErros();
let concluidas = 0;

for (let i = 0; i < transferencias; i++) {
  try {
    // BUG INTENCIONAL: sem BEGIN/COMMIT. Sao duas transacoes independentes, e
    // entre elas o sistema fica com menos dinheiro do que deveria.
    const linhaOrigem = await pool.query('SELECT saldo FROM contas WHERE id = $1', [de]);
    await pool.query('UPDATE contas SET saldo = $1 WHERE id = $2', [
      paraNumero(linhaOrigem.rows[0].saldo) - valor,
      de,
    ]);
    await pool.query('INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3)', [
      de,
      -valor,
      origem,
    ]);

    // o dinheiro esta no ar exatamente aqui
    await pool.query('SELECT pg_sleep($1)', [pausaMs / 1000]);

    const linhaDestino = await pool.query('SELECT saldo FROM contas WHERE id = $1', [para]);
    await pool.query('UPDATE contas SET saldo = $1 WHERE id = $2', [
      paraNumero(linhaDestino.rows[0].saldo) + valor,
      para,
    ]);
    await pool.query('INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3)', [
      para,
      valor,
      origem,
    ]);
    concluidas++;
  } catch (erro) {
    erros.registrar(erro);
  }
}

await fecharPool(pool);

const saida: SaidaWorker<ResultadoTransferencia> = {
  ok: true,
  id: entrada.id,
  resultado: { concluidas, erros: erros.porSqlstate() },
};
parentPort!.postMessage(saida);
