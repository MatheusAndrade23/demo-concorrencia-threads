/**
 * CASO 01 - baseline sequencial, sem thread nenhuma
 *
 * A régua. Um saque por vez, em laço, na thread principal: SELECT, cálculo em
 * JS, UPDATE. Nenhum worker sobe aqui.
 *
 * Existe por dois motivos:
 *
 *   1. prova que a lógica do saque está certa. A divergência fecha em zero, e
 *      isso significa que todo desvio que aparecer nos outros casos veio de como
 *      o trabalho foi distribuído entre threads, e não do saque em si;
 *   2. dá o ponto de referência de tempo. É o "quanto custaria fazer isso com
 *      uma thread só", a linha tracejada contra a qual as curvas de tempo dos
 *      casos com worker são lidas.
 *
 * Roda com `threads = 1` e ignora a varredura: a ideia de "mais threads" não se
 * aplica a um laço que espera cada operação terminar antes de começar a próxima.
 */
import { performance } from 'node:perf_hooks';
import {
  ContadorDeErros,
  criarPool,
  fecharPool,
  lerConfig,
  paraNumero,
  resetar,
  somaSaldos,
  verificarConexao,
  verificarInvariante,
} from '../db.js';
import type { Pool } from '../db.js';
import type { OpcoesCaso, ResultadoCaso } from '../tipos.js';

export const NOME = '01-baseline-sequencial';
const CONTA_ALVO = 1;

/**
 * SELECT, cálculo em JS, UPDATE. Exatamente o mesmo saque que o worker do caso
 * 04 executa. A única diferença entre os dois casos é quem chama e quantos
 * chamam ao mesmo tempo.
 */
async function saque(pool: Pool, contaId: number, valor: number): Promise<void> {
  const { rows } = await pool.query('SELECT saldo FROM contas WHERE id = $1', [contaId]);

  // pg devolve NUMERIC como string. Sem esta conversão, "1000" - 1 até funciona
  // por coerção, mas "1000" + 1 daria "10001". Ver paraNumero em db.ts.
  const saldo = paraNumero(rows[0].saldo);

  const novoSaldo = saldo - valor;

  await pool.query('UPDATE contas SET saldo = $1 WHERE id = $2', [novoSaldo, contaId]);
  await pool.query('INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3)', [
    contaId,
    -valor,
    NOME,
  ]);
}

export async function executar(opts: OpcoesCaso): Promise<ResultadoCaso> {
  const cfg = lerConfig();
  const pool = criarPool(2, cfg);
  await verificarConexao(pool);
  await resetar(pool, cfg);

  const saldoInicial = await somaSaldos(pool);
  const erros = new ContadorDeErros();
  let concluidas = 0;

  const inicio = performance.now();
  for (let i = 0; i < opts.operacoes; i++) {
    // um await por vez: o próximo SELECT só acontece depois do UPDATE anterior
    try {
      await saque(pool, CONTA_ALVO, opts.valorSaque);
      concluidas++;
    } catch (erro) {
      erros.registrar(erro);
    }
  }
  const ms = performance.now() - inicio;

  const invariante = await verificarInvariante(pool, saldoInicial);
  await fecharPool(pool);

  return {
    caso: NOME,
    threads: 1,
    operacoes: opts.operacoes,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros: erros.porSqlstate(),
    porThread: [concluidas],
    extra: {
      workers: 0,
      saquesEfetivados: Math.round((saldoInicial - invariante.observado) / opts.valorSaque),
      saquesRegistrados: concluidas,
    },
  };
}
