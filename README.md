# Concorrência e threads: um catálogo de bugs

Projeto didático em TypeScript + Node.js + PostgreSQL para uma apresentação sobre
concorrência e threads.

O objetivo aqui é **demonstrar problemas, não resolvê-los**. Os bugs são o
produto. Cada trecho problemático está marcado no código com
`// BUG INTENCIONAL: <explicação>`, e não existe mutex, `Atomics.wait`, fila de
serialização, `SELECT ... FOR UPDATE`, `UPDATE saldo = saldo - x`, isolamento
`SERIALIZABLE` nem retry em lugar nenhum. A única exceção é o cenário 1, que é o
baseline correto e serve de régua para todos os outros.

A apresentação tem dois blocos, e o contraste entre eles é a tese:

| Bloco | O que é | Cenários |
|---|---|---|
| **A** | concorrência sem thread nenhuma (event loop, async/await) | 1 a 5 |
| **B** | paralelismo real com `worker_threads` | 6 a 11 |

**A maioria dos bugs que as pessoas atribuem a "thread" acontece com uma thread
só.** O cenário 2 é a prova: 200 saques registrados no razão, 9 debitados de
verdade, zero workers envolvidos.

---

## Como subir

Precisa de Node 20+ e Docker.

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:reset
```

O `db:up` sobe um Postgres 17 na porta **5433** (para não brigar com um Postgres
já instalado na máquina) e espera ficar saudável. O `db:reset` cria as tabelas e
semeia as contas.

Se o banco estiver fora do ar, qualquer cenário falha com uma mensagem clara em
vez de despejar um `ECONNREFUSED`:

```
[ERRO] Nao consegui falar com o Postgres em localhost:5433/banco.
       O banco esta fora do ar. Suba com:  npm run db:up
```

Para derrubar tudo no fim: `npm run db:down`.

## Como rodar um cenário isolado

Cada cenário roda sozinho, imprime o próprio resumo e não depende do runner:

```bash
npx tsx src/cenarios/02-corrida-sem-thread.ts
```

Ou pelos atalhos do npm, de `c01` a `c11`:

```bash
npm run c02
```

Os parâmetros vêm do `.env` e podem ser sobrescritos na chamada:

```bash
CONCORRENCIA=64 OPERACOES=500 npm run c02
```

O cenário 11 escreve os logs de depuração em stderr, porque o barulho dele é o
próprio experimento. Para ver só o resumo:

```bash
npm run c11 2>/dev/null
```

## Como rodar tudo

Existem dois comandos, e eles servem para coisas diferentes.

### Os 11 cenários na sequência, com a saída de apresentação

```bash
npm run todos
```

Roda de 1 a 11 na ordem, cada um num processo separado, com a mesma saída que
teriam se você os chamasse um a um. Leva cerca de 20 segundos no total e termina
com uma tabela de tempo e status por cenário. É o comando para ensaiar a
apresentação e para conferir que tudo funciona depois de um `git clone`.

```bash
npm run todos -- --so 02,06,11     # só estes, por prefixo
npm run todos -- --bloco A         # só o bloco A (1 a 5)
npm run todos -- --bloco B         # só o bloco B (6 a 11)
npm run todos -- --parar-no-erro   # interrompe no primeiro que falhar
npm run todos 2>/dev/null          # esconde o barulho de depuração do cenário 11
```

Por padrão ele segue mesmo se um cenário falhar, e lista as falhas no resumo do
fim. O código de saída é 1 se algum cenário falhou.

### A medição, com repetições e gráficos

```bash
caffeinate -i npm run bench -- --cenarios todos --repeticoes 10
npm run graficos
```

Este é o que gera os CSV e os SVG. Ao contrário do `npm run todos`, ele silencia
a saída dos cenários e mede.

Opções do runner:

| Opção | Padrão | O que faz |
|---|---|---|
| `--cenarios` | `todos` | lista separada por vírgula, ou `todos`, `A`, `B`. Aceita prefixo: `--cenarios 02,08` |
| `--concorrencia` | o que cada cenário define | ex: `1,2,4,8,16,32,64` |
| `--repeticoes` | `10` | uma linha no CSV por repetição, nunca só a média |
| `--operacoes` | por cenário | número de saques; cenários de CPU e de memória ignoram, porque a escala deles é outra |
| `--sem-warmup` | desligado | não descarta a primeira execução de cada série |
| `--saida` | `resultados` | diretório de saída |

O runner descarta uma execução de warm-up antes de cada série, recria o estado do
banco antes de **cada** repetição, e nenhum cenário aborta o benchmark: uma
repetição que estoura vira uma linha com `falhou=sim` e o erro na coluna ao lado.

**Em macOS, rode com `caffeinate -i`.** `performance.now()` conta o tempo em que a
máquina esteve suspensa, então um notebook que dorme no meio da execução produz
repetições de vinte minutos que não medem nada:

```bash
caffeinate -i npm run bench -- --cenarios todos --repeticoes 10
```

### O que é gerado em `resultados/`

| Arquivo | Conteúdo |
|---|---|
| `resultados.csv` | uma linha por repetição, com tempo, throughput, invariante, erros por SQLSTATE, operações por trabalhador e maior lacuna do event loop |
| `distribuicao.csv` | operações concluídas por trabalhador, uma linha por trabalhador por repetição |
| `serie-leitura-suja.csv` | série temporal do `SELECT SUM(saldo)` do cenário 10 |
| `throughput-x-concorrencia.svg` | throughput por concorrência, uma linha por cenário |
| `dinheiro-perdido-x-concorrencia.svg` | dinheiro perdido por concorrência, com cada repetição visível como ponto |
| `distribuicao-por-trabalhador.svg` | distribuição de operações por trabalhador |
| `cpu-loop-vs-workers.svg` | tempo por número de workers, event loop único contra `worker_threads` |
| `serie-leitura-suja.svg` | série temporal do total observado durante as transferências |

---

## O schema e a invariante

```sql
contas(id SERIAL PK, titular TEXT, saldo NUMERIC(12,2) NOT NULL)
movimentos(id BIGSERIAL PK, conta_id INT, valor NUMERIC(12,2),
           origem TEXT, criado_em TIMESTAMPTZ DEFAULT now())
```

Não existe `CHECK (saldo >= 0)` de propósito. A constraint transformaria parte do
lost update em erro visível e esconderia justamente o dinheiro que some.

**A invariante é ancorada no razão**, não no total inicial:

```
esperado    = saldo_inicial + SUM(movimentos.valor)
divergência = observado - esperado
```

O motivo é que um saque diminui a soma dos saldos de propósito, então comparar o
total final com o total inicial cru acusaria perda onde não houve. A tabela
`movimentos` registra tudo o que o banco de fato movimentou, e a pergunta passa a
ser: *o saldo das contas bate com o que o razão diz que aconteceu?*

A fórmula serve para os três formatos de cenário. Num saque, cada operação grava
um movimento negativo e o esperado cai junto. Numa transferência, grava um
negativo e um positivo, que se anulam. No contador em memória do cenário 6, os
"movimentos" são os incrementos que os workers dizem ter feito e o "observado" é
o valor final do `Int32Array`.

O sinal da divergência tem significado:

- **positivo**: o banco pagou e não debitou. É o clássico do lost update em saque.
- **negativo**: dinheiro sumiu das contas.

### A pegadinha do `NUMERIC`

O driver `pg` devolve `NUMERIC` como **string**, não como número. Ele faz isso de
propósito: `NUMERIC(12,2)` do Postgres tem precisão maior que o `double` do JS, e
converter sozinho perderia informação. O efeito prático é que `"500" - 1` dá
`499` por coerção, mas `"500" + 1` dá `"5001"`. Toda leitura de saldo neste
projeto passa por `paraNumero()` em [src/db.ts](src/db.ts), e isso está comentado
no código porque vale mencionar na apresentação.

---

## O que cada cenário demonstra

### Bloco A: concorrência sem thread nenhuma

**1. sequencial** ([src/cenarios/01-sequencial.ts](src/cenarios/01-sequencial.ts))

Um `await` por vez, em laço. É o único cenário sem bug, e existe para provar duas
coisas: que a lógica do saque está correta, e qual é o throughput de referência.
Todo desvio que aparecer nos outros cenários vem de como o saque foi orquestrado,
não do saque em si. A divergência fecha em zero porque cada `SELECT` já enxerga o
`UPDATE` anterior. Guarde este número: ele é o teto do cenário 5 e o piso dos
demais.

**2. corrida sem thread** ([src/cenarios/02-corrida-sem-thread.ts](src/cenarios/02-corrida-sem-thread.ts))

O cenário mais importante do projeto. A função de saque é **idêntica** à do
cenário 1, byte por byte: `SELECT`, cálculo em JS, `UPDATE`. A única mudança é
que várias chamadas correm ao mesmo tempo via `Promise.all`. Não há
`worker_thread`, não há paralelismo de verdade, o processo tem **uma** thread de
JavaScript. E o dinheiro some. A janela de perigo é o `await` do meio: entre ler
o saldo e gravar o novo saldo o event loop entrega o controle para outra promise,
que lê o mesmo saldo velho, e a segunda gravação apaga a primeira. Na máquina
onde foi medido, com 32 promises e 200 saques, o razão registrou 200 saques e a
conta debitou 9. Repare também que o mesmo arquivo tem um `restantes--` que **não**
tem corrida, porque não atravessa nenhum `await`: a diferença entre os dois é a
aula inteira.

**3. promise órfã** ([src/cenarios/03-promise-orfa.ts](src/cenarios/03-promise-orfa.ts))

Duas formas de perder o controle do fluxo sem nenhum erro aparente. Na primeira,
`Array.prototype.forEach` recebe um callback `async`, ignora a promise que ele
devolve e retorna na hora: o `"tudo pronto"` sai em 0,08 ms com **zero** saques
concluídos, o último só termina 800 ms depois, o processo encerra com exit code 0
e o erro que aconteceu dentro do callback morre num `catch` vazio. Na segunda,
`Promise.allSettled` espera de verdade, mas o relatório conta o tamanho do array
em vez dos `fulfilled`, e como `allSettled` nunca rejeita, ele sempre diz 100% de
sucesso. Onze operações, dez deram certo, o relatório diz onze.

**4. event loop travado** ([src/cenarios/04-event-loop-travado.ts](src/cenarios/04-event-loop-travado.ts))

Um `setInterval` bate um heartbeat a cada 100 ms enquanto um handler `async` roda
um laço apertado de CPU. A palavra `async` não cria thread nenhuma e não devolve
o controle ao loop: ela só promete que a função **pode** ceder num `await`, e não
há `await` nenhum dentro do laço. O heartbeat simplesmente para de bater. Na
medição, a maior lacuna foi de 1894 ms e 17 batidas nunca saíram. É o que
acontece com um servidor HTTP quando alguém coloca processamento pesado numa
rota: não é um pedido lento, são todos os pedidos parados.

**5. conexão compartilhada** ([src/cenarios/05-conexao-compartilhada.ts](src/cenarios/05-conexao-compartilhada.ts))

Todas as operações usam o mesmo `Client` do `pg` em vez de um `Pool`. O efeito
não é corrupção, é serialização: o driver mantém uma fila interna por conexão e
só manda a próxima query depois que a anterior respondeu. As 32 promises
"concorrentes" viram uma fila única e o throughput desaba, 12,8x mais lento que a
mesma carga num `Pool`. O detalhe que costuma surpreender é que **a corrida do
cenário 2 continua acontecendo**: o driver serializa as queries, não as
transações, então a ordem vira `SELECT-A, SELECT-B, UPDATE-A, UPDATE-B` e os dois
leem o mesmo saldo velho do mesmo jeito. Perde-se o desempenho e não se ganha a
correção. O cenário usa uma latência simulada de 2 ms por query
(`LATENCIA_DE_REDE_MS`), porque com o Postgres em loopback cada query responde em
0,15 ms e o gargalo vira a CPU do próprio Node, o que esconde o efeito.

### Bloco B: paralelismo real com worker_threads

**6. corrida em memória com SharedArrayBuffer** ([src/cenarios/06-worker-sab-corrida.ts](src/cenarios/06-worker-sab-corrida.ts))

Agora há paralelismo de verdade: N workers, cada um numa thread do sistema
operacional, incrementando o mesmo `Int32Array` sobre um `SharedArrayBuffer`, sem
`Atomics` e sem banco de dados nenhum. `contador[0] = contador[0] + 1` são três
operações de máquina, e dois núcleos que carregam o mesmo valor ao mesmo tempo
escrevem o mesmo resultado, evaporando um dos incrementos. Com 4 workers e 2
milhões de incrementos cada, de 68% a 74% dos incrementos somem, e o número muda
a cada execução. O contraste com o cenário 2 é a tese: lá o intervalo perigoso
era um `await`, aqui é uma instrução de máquina, e o bug é o mesmo lost update.

**7. o mesmo trabalho em workers** ([src/cenarios/07-worker-cpu.ts](src/cenarios/07-worker-cpu.ts))

Pega o laço de CPU do cenário 4 e distribui entre N workers. Duas coisas mudam de
uma vez: o tempo **cai** conforme se adiciona worker (5,3x mais rápido com 8
workers na máquina medida), e o heartbeat do event loop principal continua batendo
em 101 ms, porque a thread principal não está fazendo conta nenhuma, só esperando
mensagem. É o contraponto exato do cenário 4, e a lição é que `async/await` serve
para esperar I/O enquanto `worker_threads` serve para gastar CPU: trocar um pelo
outro não resolve nada. O trabalho é aritmética de inteiros pura, sem alocação,
porque a versão com `crypto.createHash` fazia os workers disputarem o alocador e
achatava a curva por um motivo que não tem nada a ver com o assunto da aula.

**8. a mesma corrida com paralelismo real** ([src/cenarios/08-worker-banco.ts](src/cenarios/08-worker-banco.ts))

N workers, cada um com o **próprio** `Pool`, fazendo saques read-modify-write na
mesma conta. É o cenário 2 com threads de verdade no lugar das promises, e ele
roda os dois lado a lado no mesmo comando. O ponto não é que fica pior, é que
fica **diferente**: na medição, 8 workers perderam 159 contra 165 das promises,
com throughput 4x menor por causa do custo de subir worker. Os dois perdem
dinheiro porque o bug nunca foi da thread, foi do read-modify-write.

**9. deadlock** ([src/cenarios/09-deadlock.ts](src/cenarios/09-deadlock.ts))

Metade dos workers transfere da conta A para a B, a outra metade da B para a A, ao
mesmo tempo. Não existe mutex, semáforo nem `LOCK TABLE` em lugar nenhum do
código: quem trava é o `UPDATE`, porque no Postgres um `UPDATE` segura a linha
até o `COMMIT`. A transação que vai de A para B trava A e quer B, a que vai de B
para A trava B e quer A, e o Postgres detecta o ciclo e mata uma delas com
`SQLSTATE 40P01`. Na medição, 67 de 80 transferências morreram assim. O erro é
capturado, classificado e contado, e não há retry: retry seria a correção.

**10. leitura suja** ([src/cenarios/10-leitura-suja.ts](src/cenarios/10-leitura-suja.ts))

Workers transferem dinheiro entre pares de contas **sem transação**, enquanto a
thread principal roda `SELECT SUM(saldo)` em laço, como faria um dashboard. Cada
worker tem o próprio par de contas, então não há disputa por linha e no fim nada
se perde: a divergência fecha em zero exato. Mesmo assim, 92,6% das amostras
mostraram um total que nunca foi verdade, com buracos de até 500, porque entre o
débito de uma conta e o crédito da outra existe um instante em que o dinheiro não
está em lugar nenhum. Um número pode estar errado sem que nenhum dado esteja
errado: o erro está em ter lido no meio de uma operação que ainda não acabou.

**11. heisenbug** ([src/cenarios/11-heisenbug.ts](src/cenarios/11-heisenbug.ts))

O cenário 2 com uma flag que insere um `console.log` dentro da seção crítica. O
log não corrige nada, só muda o tempo, e como o bug depende de duas operações
caírem na mesma janela, mudar o tempo muda a frequência com que ele aparece. O
cenário **mede em dois lugares** em vez de afirmar o resultado, e a resposta é
diferente em cada um. No banco, a janela entre o `SELECT` e o `UPDATE` é uma ida
e volta ao Postgres, algo como 300 µs, e um `console.log` custa poucos µs: a
perturbação é 1% da janela e a perda não muda nada (fator 1,01x). Em memória, a
janela entre ler e escrever o `Int32Array` é de nanossegundos, o mesmo log é mil
vezes maior que ela, e a perda cai de 26% para 5% (fator 0,19x), ficando também
muito mais estável. A conclusão não é "log esconde bug", é que o log esconde o bug
quando é grande perto da janela da corrida e não faz nada quando é pequeno. Como
ninguém sabe de cabeça o tamanho da janela, um print nunca é prova de nada.

---

## Estrutura

```
docker-compose.yml
package.json
tsconfig.json                 strict ligado
.env.example
README.md
src/db.ts                     pool, seed, invariante, classificação de erro
src/tipos.ts                  ResultadoCenario, Invariante, OpcoesCenario
src/relatorio.ts              resumo legível no terminal
src/hash.ts                   o trabalho de CPU dos cenários 4 e 7
src/heartbeat.ts              o heartbeat dos cenários 4 e 7
src/cenarios/01..11
src/workers/protocolo.ts      workerData na entrada, postMessage na saída
src/workers/sab-worker.ts
src/workers/cpu-worker.ts
src/workers/banco-worker.ts
src/workers/deadlock-worker.ts
src/workers/transferencia-worker.ts
src/todos.ts                  roda os 11 cenários na sequência
src/benchmark.ts
src/graficos.ts
resultados/                   CSV e SVG gerados
slides/notas.md
```

### Como os workers recebem parâmetros e devolvem resultado

Entrada por `workerData`, saída por `parentPort.postMessage`. O pai também espera
o evento `exit`, então um worker que morre antes de responder vira um resultado
`{ ok: false }` em vez de derrubar o benchmark: a promise nunca rejeita.

```ts
interface EntradaWorker<P> {
  id: number;                 // índice, usado na distribuição por trabalhador
  config: Config;             // o worker abre o PRÓPRIO Pool a partir daqui
  params: P;
  sab?: SharedArrayBuffer;    // só nos cenários que precisam
}

type SaidaWorker<R> =
  | { ok: true;  id: number; resultado: R }
  | { ok: false; id: number; erro: { sqlstate: string; mensagem: string } };
```

Cada worker abre o próprio `Pool`. A única exceção é o cenário 5, e lá isso é o
bug.

### Tratamento de erro

Todo erro de banco é capturado e classificado por `SQLSTATE` pela classe
`ContadorDeErros`. Erros que não vêm do Postgres recebem um pseudo-código em
maiúsculas (`ECONNREFUSED`, `JS`, `WORKER_SEM_RESPOSTA`, `DESCONHECIDO`) para
caberem na mesma contagem. Nenhum cenário aborta o benchmark inteiro.

## Configuração

Tudo por variável de ambiente, com `.env.example` versionado:

| Variável | Padrão | O que é |
|---|---|---|
| `PGHOST` / `PGPORT` | `localhost` / `5433` | conexão |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `demo` / `demo` / `banco` | conexão |
| `CONTAS` | `10` | quantas contas o seed cria |
| `SALDO_INICIAL` | `1000` | saldo de cada conta |
| `OPERACOES` | `200` | saques por execução, quando o cenário roda sozinho |
| `CONCORRENCIA` | `32` | promises ou workers, quando o cenário roda sozinho |
| `VALOR_SAQUE` | `1` | valor de cada saque |
