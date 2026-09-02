/**
 * Saída legível de um cenário no terminal.
 *
 * Cada cenário roda sozinho e imprime o próprio resumo, sem depender do runner.
 * A formatação mora aqui para não ser copiada onze vezes.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { ResultadoCenario } from './tipos.js';

/** true quando o arquivo foi chamado direto (npx tsx src/cenários/xx.ts). */
export function ehPrincipal(urlDoModulo: string): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  return resolve(argv) === resolve(fileURLToPath(urlDoModulo));
}

const LARGURA = 66;

export function titulo(texto: string): void {
  console.log('\n' + '='.repeat(LARGURA));
  console.log(' ' + texto);
  console.log('='.repeat(LARGURA));
}

export function secao(texto: string): void {
  console.log('\n' + '-'.repeat(LARGURA));
  console.log(' ' + texto);
  console.log('-'.repeat(LARGURA));
}

function linha(rotulo: string, valor: string): void {
  console.log('  ' + rotulo.padEnd(34) + valor);
}

export function dinheiro(v: number): string {
  return v.toFixed(2);
}

/** min / max / desvio das operações por trabalhador, para mostrar desigualdade. */
export function distribuicao(porTrabalhador: number[]): string {
  if (porTrabalhador.length === 0) return 'sem dados';
  const min = Math.min(...porTrabalhador);
  const max = Math.max(...porTrabalhador);
  const media = porTrabalhador.reduce((a, b) => a + b, 0) / porTrabalhador.length;
  const variancia =
    porTrabalhador.reduce((a, b) => a + (b - media) ** 2, 0) / porTrabalhador.length;
  return (
    `min ${min} / max ${max} / média ${media.toFixed(1)} / desvio ${Math.sqrt(variancia).toFixed(2)}`
  );
}

/** Histograma horizontal simples, útil quando há poucos trabalhadores. */
export function barras(porTrabalhador: number[], rotulo = 'w'): void {
  if (porTrabalhador.length === 0 || porTrabalhador.length > 32) return;
  const max = Math.max(...porTrabalhador, 1);
  porTrabalhador.forEach((n, i) => {
    const largura = Math.round((n / max) * 34);
    console.log(`    ${rotulo}${String(i).padStart(2, '0')} ${'#'.repeat(largura).padEnd(34)} ${n}`);
  });
}

export function imprimirResumo(r: ResultadoCenario, notas: string[] = []): void {
  const inv = r.invariante;
  secao(`${r.cenario}   concorrência ${r.concorrencia} / ${r.operacoes} operações`);
  linha('tempo', `${r.ms.toFixed(2)} ms`);
  linha('throughput', `${r.throughput.toFixed(1)} ops/s`);
  linha('concluídas', `${r.concluidas} de ${r.operacoes}`);
  console.log('');
  linha('saldo inicial', dinheiro(inv.saldoInicial));
  linha('movimentos (razão)', dinheiro(inv.movimentos));
  linha('esperado', `${dinheiro(inv.esperado)}   (inicial + movimentos)`);
  linha('observado', dinheiro(inv.observado));

  if (inv.divergencia > 0) {
    linha('DIVERGÊNCIA', `+${dinheiro(inv.divergencia)}  pago e nunca debitado`);
  } else if (inv.divergencia < 0) {
    linha('DIVERGÊNCIA', `${dinheiro(inv.divergencia)}  sumiu das contas`);
  } else {
    linha('divergência', '0.00  (invariante preservada)');
  }

  const erros = Object.entries(r.erros);
  linha(
    'erros',
    erros.length === 0 ? 'nenhum' : erros.map(([k, v]) => `${k}=${v}`).join('  '),
  );

  if (r.maiorLacunaEventLoopMs !== undefined) {
    linha('maior lacuna do loop', `${r.maiorLacunaEventLoopMs.toFixed(1)} ms`);
  }
  if (r.porTrabalhador.length > 1) {
    linha('ops por trabalhador', distribuicao(r.porTrabalhador));
  }
  for (const [chave, valor] of Object.entries(r.extra ?? {})) {
    linha(chave, String(valor));
  }

  if (notas.length > 0) {
    console.log('');
    for (const n of notas) console.log('  > ' + n);
  }
  console.log('');
}
