/**
 * CENÁRIO 01 - sequencial   (Bloco A)
 *
 * Baseline correto. Um await por vez, em laço. Não há bug aqui: este é o único
 * cenário que serve de referência de throughput e a prova de que a lógica do
 * saque está certa. Todo desvio que aparecer nos outros cenários vem da forma
 * como o saque foi orquestrado, não do saque em si.
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
 * SELECT, cálculo em JS, UPDATE. Exatamente o mesmo saque do cenário 02.
 * A única diferença entre os dois cenários é quem chama isto e como.
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
  titulo('CENÁRIO 01 - sequencial (baseline correto)');
  console.log(`  ${cfg.operacoes} saques de ${cfg.valorSaque} na conta ${CONTA_ALVO}, um de cada vez.`);

  const r = await executar({
    operacoes: cfg.operacoes,
    concorrencia: 1,
    valorSaque: cfg.valorSaque,
  });

  imprimirResumo(r, [
    'Divergência zero: cada SELECT já enxerga o UPDATE anterior.',
    'Guarde este throughput. Ele é o teto do cenário 05 e o piso dos demais.',
  ]);
}
