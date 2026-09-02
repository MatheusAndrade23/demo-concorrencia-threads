/**
 * Worker do cenário 08. Abre o PRÓPRIO Pool e faz saques read-modify-write.
 *
 * Cada worker roda seus saques em série. A única concorrência deste cenário é
 * entre os workers, ou seja, entre threads do sistema operacional de verdade.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ContadorDeErros, criarPool, fecharPool, paraNumero } from '../db.js';
import type { EntradaWorker, SaidaWorker } from './protocolo.js';

export interface ParamsBanco {
  contaId: number;
  operacoes: number;
  valor: number;
  origem: string;
}
export interface ResultadoBanco {
  concluidas: number;
  erros: Record<string, number>;
}

const entrada = workerData as EntradaWorker<ParamsBanco>;
const { contaId, operacoes, valor, origem } = entrada.params;

// cada worker com o próprio Pool: é o oposto do cenário 05
const pool = criarPool(2, entrada.config);
const erros = new ContadorDeErros();
let concluidas = 0;

for (let i = 0; i < operacoes; i++) {
  try {
    const { rows } = await pool.query('SELECT saldo FROM contas WHERE id = $1', [contaId]);
    const saldo = paraNumero(rows[0].saldo);

    // BUG INTENCIONAL: mesmo read-modify-write do cenário 02, só que agora a
    // janela entre a leitura e a escrita é disputada por núcleos de verdade.
    const novoSaldo = saldo - valor;

    await pool.query('UPDATE contas SET saldo = $1 WHERE id = $2', [novoSaldo, contaId]);
    await pool.query('INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3)', [
      contaId,
      -valor,
      origem,
    ]);
    concluidas++;
  } catch (erro) {
    erros.registrar(erro);
  }
}

await fecharPool(pool);

const saida: SaidaWorker<ResultadoBanco> = {
  ok: true,
  id: entrada.id,
  resultado: { concluidas, erros: erros.porSqlstate() },
};
parentPort!.postMessage(saida);
