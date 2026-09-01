/**
 * CENARIO 11 - o heisenbug   (Bloco B da apresentacao, Bloco A na tecnica)
 *
 * O cenario 02 inteiro, com uma unica diferenca: uma flag que insere um
 * `console.log` dentro da secao critica, entre o SELECT e o UPDATE.
 *
 * O log nao corrige nada. Ele so muda o tempo. E como o bug depende de duas
 * promises caírem na mesma janela, mudar o tempo muda a frequencia com que ele
 * aparece. E por isso que "aqui na minha maquina funciona" e "coloquei um log e
 * parou de dar erro" sao a mesma frase.
 *
 * Este cenario NAO afirma para que lado o efeito vai: ele mede, em dois lugares
 * onde a janela da corrida tem tamanhos muito diferentes.
 *
 *   PAINEL A - a corrida no banco (cenario 02). A janela entre o SELECT e o
 *   UPDATE e uma ida e volta ao Postgres, algo como 300 microssegundos. Um
 *   console.log custa poucos microssegundos. A perturbacao e 1% da janela, e a
 *   medicao mostra exatamente isso: o log nao muda quase nada.
 *
 *   PAINEL B - a corrida em memoria (cenario 06). A janela entre ler e escrever
 *   o Int32Array e de nanossegundos. Agora o mesmo log e MIL VEZES maior que a
 *   janela, e a perda cai de forma clara.
 *
 * A conclusao nao e "log esconde bug". E que o log esconde o bug quando ele e
 * grande perto da janela da corrida, e nao faz nada quando e pequeno. Como
 * ninguem sabe de cabeca o tamanho da janela, um print nunca e prova de nada.
 *
 * Dica de execucao: os logs de depuracao vao para stderr. Rode com 2>/dev/null
 * para ver so o resumo, e sem redirecionar para ver o barulho.
 */
import { performance } from 'node:perf_hooks';
import {
  aquecerPool,
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
import { ehPrincipal, secao, titulo } from '../relatorio.js';
import { executar as executarSab } from './06-worker-sab-corrida.js';
import type { OpcoesCenario, ResultadoCenario } from '../tipos.js';

export const NOME = '11-heisenbug';
const CONTA_ALVO = 1;
export const REPETICOES_PADRAO = 5;

/** Painel B: a mesma pergunta feita ao contador em memoria do cenario 06. */
export const WORKERS_MEMORIA = 4;
export const ITERACOES_MEMORIA = 20_000;
export const REPETICOES_MEMORIA = 3;

async function saque(
  pool: Pool,
  contaId: number,
  valor: number,
  logNaSecaoCritica: boolean,
): Promise<void> {
  const { rows } = await pool.query('SELECT saldo FROM contas WHERE id = $1', [contaId]);
  const saldo = paraNumero(rows[0].saldo);

  if (logNaSecaoCritica) {
    // O OBSERVADOR: escrever custa tempo. Esta linha nao corrige o bug,
    // so mexe no relogio. Vai para stderr, ver a dica de execucao no topo.
    console.error(`  [debug] li saldo=${saldo}, vou gravar ${saldo - valor}`);
  }

  // BUG INTENCIONAL: o mesmo read-modify-write do cenario 02, intacto.
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
  const comLog = opts.logNaSecaoCritica === true;

  const pool = criarPool(opts.concorrencia, cfg);
  await verificarConexao(pool);
  await resetar(pool, cfg);
  await aquecerPool(pool, opts.concorrencia);

  const saldoInicial = await somaSaldos(pool);
  const erros = new ContadorDeErros();
  const porTrabalhador = new Array<number>(opts.concorrencia).fill(0);
  let concluidas = 0;
  let restantes = opts.operacoes;

  async function trabalhador(indice: number): Promise<void> {
    while (restantes > 0) {
      restantes--;
      try {
        await saque(pool, CONTA_ALVO, opts.valorSaque, comLog);
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
    cenario: comLog ? `${NOME}-com-log` : `${NOME}-sem-log`,
    concorrencia: opts.concorrencia,
    operacoes: opts.operacoes,
    concluidas,
    ms,
    throughput: (concluidas / ms) * 1000,
    invariante,
    erros: erros.porSqlstate(),
    porTrabalhador,
    extra: {
      logNaSecaoCritica: comLog,
      saquesEfetivados: Math.round((saldoInicial - invariante.observado) / opts.valorSaque),
    },
  };
}

/** Roda `repeticoes` vezes e resume a dispersao, que e o que importa aqui. */
async function medir(
  opts: OpcoesCenario,
  repeticoes: number,
): Promise<{ divergencias: number[]; media: number; limpas: number; msMedio: number }> {
  const divergencias: number[] = [];
  const tempos: number[] = [];
  for (let i = 0; i < repeticoes; i++) {
    const r = await executar(opts);
    divergencias.push(r.invariante.divergencia);
    tempos.push(r.ms);
  }
  const media = divergencias.reduce((a, b) => a + b, 0) / repeticoes;
  return {
    divergencias,
    media,
    limpas: divergencias.filter((d) => d === 0).length,
    msMedio: tempos.reduce((a, b) => a + b, 0) / repeticoes,
  };
}

if (ehPrincipal(import.meta.url)) {
  const cfg = lerConfig();
  const base: OpcoesCenario = {
    operacoes: 100,
    concorrencia: cfg.concorrencia,
    valorSaque: cfg.valorSaque,
  };

  titulo('CENARIO 11 - o heisenbug');
  console.log('  O mesmo experimento em dois lugares: no banco e na memoria.');
  console.log('  Rode com 2>/dev/null para esconder o barulho do proprio experimento.');

  // ---------------------------------------------------------------- painel A
  const semLog = await medir({ ...base, logNaSecaoCritica: false }, REPETICOES_PADRAO);
  const comLog = await medir({ ...base, logNaSecaoCritica: true }, REPETICOES_PADRAO);

  secao('PAINEL A - corrida no banco, janela de ~300 microssegundos');
  const linha = (rotulo: string, m: { media: number; limpas: number; msMedio: number; divergencias: number[] }): void => {
    console.log(
      `  ${rotulo.padEnd(10)} divergencia media ${m.media.toFixed(1).padStart(7)}` +
        `   execucoes limpas ${m.limpas}/${REPETICOES_PADRAO}` +
        `   tempo medio ${m.msMedio.toFixed(0).padStart(6)} ms`,
    );
    console.log(`             por execucao: ${m.divergencias.join(', ')}`);
  };
  linha('sem log', semLog);
  linha('com log', comLog);
  const fatorBanco = semLog.media === 0 ? 0 : comLog.media / semLog.media;
  console.log(`\n  o log mudou a perda por um fator de ${fatorBanco.toFixed(2)}x. Ou seja, nao mudou.`);

  // ---------------------------------------------------------------- painel B
  const perdasSemLog: number[] = [];
  const perdasComLog: number[] = [];
  for (let i = 0; i < REPETICOES_MEMORIA; i++) {
    const a = await executarSab({ operacoes: ITERACOES_MEMORIA, concorrencia: WORKERS_MEMORIA, valorSaque: 0, logNaSecaoCritica: false });
    const b = await executarSab({ operacoes: ITERACOES_MEMORIA, concorrencia: WORKERS_MEMORIA, valorSaque: 0, logNaSecaoCritica: true });
    perdasSemLog.push(Number(a.extra?.percentualPerdido));
    perdasComLog.push(Number(b.extra?.percentualPerdido));
  }
  const media = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length;

  secao('PAINEL B - corrida em memoria, janela de nanossegundos');
  console.log(`  ${WORKERS_MEMORIA} workers x ${ITERACOES_MEMORIA.toLocaleString('pt-BR')} incrementos, ${REPETICOES_MEMORIA} execucoes de cada.`);
  console.log(`  sem log    incrementos perdidos: ${perdasSemLog.map((p) => p + '%').join(', ')}   media ${media(perdasSemLog).toFixed(1)}%`);
  console.log(`  com log    incrementos perdidos: ${perdasComLog.map((p) => p + '%').join(', ')}   media ${media(perdasComLog).toFixed(1)}%`);
  const fatorMemoria = media(perdasSemLog) === 0 ? 0 : media(perdasComLog) / media(perdasSemLog);
  console.log(`\n  aqui o log mudou a perda por um fator de ${fatorMemoria.toFixed(2)}x.`);

  secao('a licao');
  console.log('  > O log nao tocou em uma linha da logica, nos dois paineis.');
  console.log(`  > No banco nao mudou nada (${fatorBanco.toFixed(2)}x). Na memoria mudou muito (${fatorMemoria.toFixed(2)}x).`);
  console.log('  > A diferenca e o tamanho da perturbacao comparado ao tamanho da janela.');
  console.log('  > Como ninguem sabe de cabeca esse tamanho, print nunca e prova de nada.\n');
}
