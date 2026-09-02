/**
 * CENÁRIO 03 - a promise órfã   (Bloco A)
 *
 * Duas formas de perder o controle do fluxo sem nenhum erro aparente.
 *
 * Parte 1: Array.prototype.forEach recebe um callback async, ignora a promise
 * que ele devolve e retorna na hora. O "tudo pronto" sai antes do primeiro
 * saque terminar, o processo encerra com código 0 e o erro que aconteceu dentro
 * do callback não aparece em lugar nenhum.
 *
 * Parte 2: Promise.allSettled espera de verdade, mas o relatório conta o
 * tamanho do array em vez dos `fulfilled`. Falha virou sucesso na planilha.
 */
import { performance } from 'node:perf_hooks';
import {
  ContadorDeErros,
  criarPool,
  fecharPool,
  lerConfig,
  listarContas,
  montarInvariante,
  paraNumero,
  resetar,
  somaSaldos,
  verificarConexao,
  verificarInvariante,
} from '../db.js';
import type { Pool } from '../db.js';
import { ehPrincipal, imprimirResumo, secao, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';

export const NOME = '03-promise-orfa';

/** Conta que não existe. O saque nela estoura, e ninguém fica sabendo. */
const CONTA_FANTASMA = 999_999;

async function saque(pool: Pool, contaId: number, valor: number): Promise<void> {
  const { rows } = await pool.query('SELECT saldo FROM contas WHERE id = $1', [contaId]);
  if (rows.length === 0) {
    throw new Error(`conta ${contaId} não existe`);
  }
  const saldo = paraNumero(rows[0].saldo);
  await pool.query('UPDATE contas SET saldo = $1 WHERE id = $2', [saldo - valor, contaId]);
  await pool.query('INSERT INTO movimentos (conta_id, valor, origem) VALUES ($1, $2, $3)', [
    contaId,
    -valor,
    NOME,
  ]);
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function executar(opts: OpcoesCenario): Promise<ResultadoCenario> {
  const cfg = lerConfig();
  const pool = criarPool(Math.max(4, opts.concorrencia), cfg);
  await verificarConexao(pool);
  await resetar(pool, cfg);

  const contas = await listarContas(pool);
  const saldoInicial = await somaSaldos(pool);
  const erros = new ContadorDeErros();
  const silencioso = opts.silencioso === true;

  // -------------------------------------------------------------------------
  // Parte 1: forEach com callback async
  // -------------------------------------------------------------------------
  let concluidosNoForEach = 0;

  const inicio = performance.now();

  // BUG INTENCIONAL: forEach descarta a promise devolvida pelo callback. Ele
  // dispara os N saques e retorna imediatamente, sem esperar nenhum.
  [...contas.map((c) => c.id), CONTA_FANTASMA].forEach(async (contaId) => {
    try {
      await saque(pool, contaId, opts.valorSaque);
      concluidosNoForEach++;
    } catch {
      // BUG INTENCIONAL: catch vazio. O saque na conta fantasma falha aqui
      // dentro e o erro morre neste bloco. Sem este catch o Node derrubaria o
      // processo com ERR_UNHANDLED_REJECTION, o que já seria melhor do que isto.
    }
  });

  const msAteTudoPronto = performance.now() - inicio;
  const concluidosQuandoImprimiu = concluidosNoForEach;
  if (!silencioso) {
    console.log(`\n  [${msAteTudoPronto.toFixed(2)} ms] tudo pronto!`);
    console.log(`  saques realmente concluídos neste instante: ${concluidosQuandoImprimiu}`);
  }

  // BUG INTENCIONAL: "esperar um tempinho" não é esperar as promises. É um
  // chute que funciona na máquina do desenvolvedor e falha em produção.
  await esperar(800);
  const msAteTerminarDeVerdade = performance.now() - inicio;

  // -------------------------------------------------------------------------
  // Parte 2: Promise.allSettled com relatório errado
  // -------------------------------------------------------------------------
  const tarefas = [...contas.map((c) => c.id), CONTA_FANTASMA].map((contaId) =>
    saque(pool, contaId, opts.valorSaque),
  );
  const acertos = await Promise.allSettled(tarefas);

  // BUG INTENCIONAL: conta o tamanho do array, não os que deram fulfilled.
  // allSettled nunca rejeita, então o relatório sempre diz 100% de sucesso.
  const relatorioDiz = acertos.length;

  // a verdade, que o relatório acima não conta
  const rejeitados = acertos.filter((a) => a.status === 'rejected');
  for (const r of rejeitados) erros.registrar((r as PromiseRejectedResult).reason);
  const verdade = acertos.length - rejeitados.length;

  const ms = performance.now() - inicio;
  const invariante = await verificarInvariante(pool, saldoInicial);
  const concluidas = concluidosNoForEach + verdade;
  await fecharPool(pool);

  return {
    cenario: NOME,
    concorrencia: contas.length + 1,
    operacoes: (contas.length + 1) * 2,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros: erros.porSqlstate(),
    porTrabalhador: [],
    extra: {
      msAteTudoPronto: Number(msAteTudoPronto.toFixed(2)),
      msAteTerminarDeVerdade: Number(msAteTerminarDeVerdade.toFixed(2)),
      concluidosQuandoImprimiuTudoPronto: concluidosQuandoImprimiu,
      relatorioAllSettledDiz: `${relatorioDiz}/${acertos.length} sucesso`,
      verdadeAllSettled: `${verdade}/${acertos.length} sucesso`,
      errosEngolidosNoForEach: 1,
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  titulo('CENÁRIO 03 - a promise órfã');
  console.log('  Um saque por conta, mais um saque numa conta que não existe.');

  const r = await executar({ operacoes: cfg.contas, concorrencia: cfg.contas, valorSaque: cfg.valorSaque });

  secao('o que o programa disse x o que aconteceu');
  console.log(`  "tudo pronto" saiu em ................ ${r.extra?.msAteTudoPronto} ms`);
  console.log(`  saques concluídos naquele instante ... ${r.extra?.concluidosQuandoImprimiuTudoPronto}`);
  console.log(`  o último saque só terminou em ........ ${r.extra?.msAteTerminarDeVerdade} ms`);
  console.log(`  erros engolidos pelo catch vazio ..... ${r.extra?.errosEngolidosNoForEach}`);
  console.log('');
  console.log(`  relatório do allSettled diz .......... ${r.extra?.relatorioAllSettledDiz}`);
  console.log(`  a verdade é .......................... ${r.extra?.verdadeAllSettled}`);

  imprimirResumo(r, [
    'O processo vai encerrar com exit code 0. Confira com: echo $?',
    'Nenhuma exceção subiu, nenhum log de erro, e mesmo assim uma operação falhou.',
  ]);
}
