/**
 * CENARIO 01 - sequencial   (Bloco A)
 *
 * Baseline correto. Um await por vez, em laco. Nao ha bug aqui: este e o unico
 * cenario que serve de referencia de throughput e a prova de que a logica do
 * saque esta certa. Todo desvio que aparecer nos outros cenarios vem da forma
 * como o saque foi orquestrado, nao do saque em si.
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
import { ehPrincipal, imprimirResumo, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';

export const NOME = '01-sequencial';
const CONTA_ALVO = 1;

/**
 * SELECT, calculo em JS, UPDATE. Exatamente o mesmo saque do cenario 02.
 * A unica diferenca entre os dois cenarios e quem chama isto e como.
 */
async function saque(pool: Pool, contaId: number, valor: number): Promise<void> {
  const { rows } = await pool.query('SELECT saldo FROM contas WHERE id = $1', [contaId]);

  // pg devolve NUMERIC como string. Sem esta conversao, "1000" - 1 ate funciona
  // por coercao, mas "1000" + 1 daria "10001". Ver paraNumero em db.ts.
  const saldo = paraNumero(rows[0].saldo);

  const novoSaldo = saldo - valor;

  await pool.query('UPDATE contas SET saldo = $1 WHERE id = $2', [novoSaldo, contaId]);
  await pool.query('INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3)', [
    contaId,
    -valor,
    NOME,
  ]);
}

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();
  const pool = criarPool(2, cfg);
  await verificarConexao(pool);
  await resetar(pool, cfg);

  const saldoInicial = await somaSaldos(pool);
  const erros = new ContadorDeErros();
  let concluidas = 0;

  const inicio = performance.now();
  for (let i = 0; i < opts.operacoes; i++) {
    // um await por vez: o proximo SELECT so acontece depois do UPDATE anterior
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
    cenario: NOME,
    concorrencia: 1,
    operacoes: opts.operacoes,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros: erros.porSqlstate(),
    porTrabalhador: [concluidas],
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  titulo('CENARIO 01 - sequencial (baseline correto)');
  console.log(`  ${cfg.operacoes} saques de ${cfg.valorSaque} na conta ${CONTA_ALVO}, um de cada vez.`);

  const r = await executar({
    operacoes: cfg.operacoes,
    concorrencia: 1,
    valorSaque: cfg.valorSaque,
  });

  imprimirResumo(r, [
    'Divergencia zero: cada SELECT ja enxerga o UPDATE anterior.',
    'Guarde este throughput. Ele e o teto do cenario 05 e o piso dos demais.',
  ]);
}
