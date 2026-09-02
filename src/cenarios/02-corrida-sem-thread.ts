/**
 * CENÁRIO 02 - corrida sem thread nenhuma   (Bloco A)
 *
 * O cenário mais importante do projeto.
 *
 * O saque abaixo é IDÊNTICO ao do cenário 01: SELECT, cálculo em JS, UPDATE.
 * A única mudança é que várias chamadas correm ao mesmo tempo via Promise.all.
 * Não existe worker_thread aqui, não existe paralelismo de verdade, o processo
 * tem UMA thread de JavaScript. E o dinheiro some assim mesmo.
 *
 * A janela de perigo é o `await` no meio: entre ler o saldo e gravar o novo
 * saldo, o event loop entrega o controle para outra promise, que le o MESMO
 * saldo velho. As duas calculam a partir do mesmo número e a segunda gravação
 * apaga a primeira. Isso é um lost update, e não precisou de thread.
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
import { barras, distribuicao, ehPrincipal, imprimirResumo, titulo } from '../relatorio.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';

export const NOME = '02-corrida-sem-thread';
const CONTA_ALVO = 1;

async function saque(pool: Pool, contaId: number, valor: number): Promise<void> {
  const { rows } = await pool.query('SELECT saldo FROM contas WHERE id = $1', [contaId]);

  // pg devolve NUMERIC como string; a conversão é obrigatória
  const saldo = paraNumero(rows[0].saldo);

  // BUG INTENCIONAL: o saldo lido aqui pode estar obsoleto quando o UPDATE
  // abaixo rodar, porque outra promise já gravou nesse intervalo.
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

  // max = concorrência de propósito: com um pool menor, o próprio driver
  // enfileira as operações e a corrida some (é o que acontece no cenário 05).
  const pool = criarPool(opts.concorrencia, cfg);
  await verificarConexao(pool);
  await resetar(pool, cfg);

  const saldoInicial = await somaSaldos(pool);
  const erros = new ContadorDeErros();
  const porTrabalhador = new Array<number>(opts.concorrencia).fill(0);
  let concluidas = 0;
  let restantes = opts.operacoes;

  async function trabalhador(indice: number): Promise<void> {
    while (restantes > 0) {
      // Este decremento NÃO tem corrida: é uma thread só e não há await entre
      // a leitura e a escrita de `restantes`. Contraste com o saldo lá em cima,
      // que atravessa um await. A diferença entre os dois é a aula inteira.
      restantes--;
      try {
        await saque(pool, CONTA_ALVO, opts.valorSaque);
        porTrabalhador[indice]++;
        concluidas++;
      } catch (erro) {
        erros.registrar(erro);
      }
    }
  }

  const inicio = performance.now();
  await Promise.all(Array.from({ length: opts.concorrencia }, (_, i) => trabalhador(i)));
  const ms = performance.now() - inicio;

  const invariante = await verificarInvariante(pool, saldoInicial);
  await fecharPool(pool);

  return {
    cenario: NOME,
    concorrencia: opts.concorrencia,
    operacoes: opts.operacoes,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros: erros.porSqlstate(),
    porTrabalhador,
    extra: {
      saquesEfetivados: Math.round((saldoInicial - invariante.observado) / opts.valorSaque),
      saquesRegistrados: concluidas,
    },
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  titulo('CENÁRIO 02 - corrida sem thread nenhuma');
  console.log(`  ${cfg.operacoes} saques de ${cfg.valorSaque} na conta ${CONTA_ALVO},`);
  console.log(`  ${cfg.concorrencia} promises concorrentes, 1 (uma) thread de JavaScript.`);

  const r = await executar({
    operacoes: cfg.operacoes,
    concorrencia: cfg.concorrencia,
    valorSaque: cfg.valorSaque,
  });

  imprimirResumo(r, [
    'Zero workers. Zero threads. process.env.UV_THREADPOOL não tem nada a ver.',
    `O razão registrou ${r.concluidas} saques, a conta debitou ${r.extra?.saquesEfetivados}.`,
    'A diferença é dinheiro que o banco pagou e nunca cobrou.',
  ]);

  console.log('  operações por promise: ' + distribuicao(r.porTrabalhador));
  barras(r.porTrabalhador, 'p');
  console.log('');
}
