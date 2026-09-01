/**
 * Worker do cenario 09. Faz transferencias dentro de uma transacao.
 *
 * Nao ha lock nenhum escrito no codigo. Quem trava e o proprio UPDATE: no
 * Postgres, um UPDATE segura a linha ate o fim da transacao. Duas transacoes que
 * atualizam as mesmas duas linhas em ordens opostas ficam cada uma esperando a
 * outra, e o Postgres mata uma delas com SQLSTATE 40P01.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ContadorDeErros, classificarErro, criarPool, fecharPool, paraNumero } from '../db.js';
import type { EntradaWorker, SaidaWorker } from './protocolo.js';

export interface ParamsDeadlock {
  de: number;
  para: number;
  valor: number;
  transferencias: number;
  /** pausa entre os dois UPDATE, para a janela do deadlock ficar visivel */
  pausaMs: number;
  origem: string;
}
export interface ResultadoDeadlock {
  concluidas: number;
  deadlocks: number;
  erros: Record<string, number>;
}

const entrada = workerData as EntradaWorker<ParamsDeadlock>;
const { de, para, valor, transferencias, pausaMs, origem } = entrada.params;

const pool = criarPool(2, entrada.config);
const erros = new ContadorDeErros();
let concluidas = 0;
let deadlocks = 0;

for (let i = 0; i < transferencias; i++) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // BUG INTENCIONAL: a ordem em que as linhas sao travadas depende da direcao
    // da transferencia. Ordenar as contas por id evitaria o deadlock, e por isso
    // mesmo nao esta aqui.
    const origemLinha = await client.query('SELECT saldo FROM contas WHERE id = $1', [de]);
    await client.query('UPDATE contas SET saldo = $1 WHERE id = $2', [
      paraNumero(origemLinha.rows[0].saldo) - valor,
      de,
    ]);

    // segura a primeira linha por um instante, para a outra transacao chegar
    await client.query('SELECT pg_sleep($1)', [pausaMs / 1000]);

    const destinoLinha = await client.query('SELECT saldo FROM contas WHERE id = $1', [para]);
    await client.query('UPDATE contas SET saldo = $1 WHERE id = $2', [
      paraNumero(destinoLinha.rows[0].saldo) + valor,
      para,
    ]);

    await client.query(
      'INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3), ($4, $5, $3)',
      [de, -valor, origem, para, valor],
    );

    await client.query('COMMIT');
    concluidas++;
  } catch (erro) {
    // ROLLBACK e limpeza, nao correcao: nao ha retry nenhum aqui.
    await client.query('ROLLBACK').catch(() => undefined);
    const c = classificarErro(erro);
    if (c.sqlstate === '40P01') deadlocks++;
    erros.registrar(erro);
  } finally {
    client.release();
  }
}

await fecharPool(pool);

const saida: SaidaWorker<ResultadoDeadlock> = {
  ok: true,
  id: entrada.id,
  resultado: { concluidas, deadlocks, erros: erros.porSqlstate() },
};
parentPort!.postMessage(saida);
