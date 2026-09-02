# Notas de apresentação

Um bloco por cenário: o problema em uma frase, o que aparece na tela, e a
pergunta que a plateia costuma fazer.

Os números citados são os medidos na máquina de desenvolvimento (10 núcleos,
Postgres 17 em container local). Rode antes da apresentação e substitua pelos
seus, porque bug de corrida não é determinístico e a plateia vai perguntar.

O ensaio completo leva cerca de 20 segundos:

```bash
npm run db:up && npm run all
```

Para ensaiar um bloco por vez: `npm run all -- --block A`.

---

## Abertura

A frase que sustenta a apresentação inteira:

> A maioria dos bugs que as pessoas atribuem a "thread" acontece com uma thread só.

Deixe o cenário 2 fazer esse trabalho. Não adiante o final.

---

# Bloco A: concorrência sem thread nenhuma

## 1. sequencial

**O problema em uma frase.** Não há problema: este é o baseline correto, e existe
para provar que a lógica do saque está certa antes de qualquer acusação.

**O que aparece na tela.** Divergência `0.00 (invariante preservada)`, 200 de 200
saques concluídos, e um número de throughput (algo em torno de 1600 ops/s) que
vale anotar no quadro, porque ele volta no cenário 5.

**A pergunta que a plateia faz.** *"Por que não usar `saldo = saldo - 1` direto no
UPDATE?"* Porque resolveria. O `SELECT`, calcular em JS e depois gravar é
exatamente o formato que quase todo código de aplicação tem quando a regra de
negócio é mais complicada do que uma subtração, e é esse formato que quebra.
Guarde essa resposta: ela volta no cenário 2.

## 2. corrida sem thread

**O problema em uma frase.** A mesma função de saque do cenário 1, chamada em
paralelo por `Promise.all`, perde dinheiro numa aplicação com uma única thread.

**O que aparece na tela.** O razão registrou 200 saques e a conta debitou 9.
Divergência de +191. Zero workers, zero threads. Mostre também a linha
`ops por trabalhador: min 2 / max 15`, porque a plateia costuma supor que a
divisão do trabalho é justa.

**Antes de rodar, mostre o diff mental.** Abra os cenários 1 e 2 lado a lado. A
função `saque` é idêntica. A única diferença está em quem chama e como.

**O detalhe que vale ouro.** No mesmo arquivo existe um `restantes--` que **não**
tem corrida, porque não atravessa nenhum `await`. Aponte para os dois na mesma
tela: um decremento seguro e uma subtração insegura, no mesmo arquivo, na mesma
thread. A diferença é o `await` no meio.

**A pergunta que a plateia faz.** *"Mas o Node não é single-threaded?"* É. E é
exatamente por isso que o bug aparece: `single-threaded` não quer dizer
`uma-operação-por-vez`, quer dizer `um-pedaço-de-código-por-vez`. Entre dois
pedaços do mesmo saque cabe o saque inteiro de outra pessoa.

## 3. promise órfã

**O problema em uma frase.** `forEach` com callback `async` dispara tudo e não
espera nada, e o erro que acontece lá dentro não aparece em lugar nenhum.

**O que aparece na tela.** `"tudo pronto"` em 0,08 ms com **zero** saques
concluídos, e o último terminando 800 ms depois. Um erro engolido por um `catch`
vazio. E o segundo ato: `relatório do allSettled diz 11/11 sucesso` /
`a verdade é 10/11 sucesso`.

**O truque de palco.** Depois que o processo terminar, rode `echo $?` no terminal.
Sai `0`. Uma operação falhou, o programa disse que estava tudo pronto antes de
começar, e o CI passaria.

**A pergunta que a plateia faz.** *"É só trocar por `for...of`?"* Para o `forEach`,
sim, e é a resposta certa. Mas a segunda metade do cenário não tem essa saída: o
`allSettled` está correto, quem está errado é o relatório. `allSettled` nunca
rejeita, e por isso mesmo contar `resultados.length` é sempre 100%.

## 4. event loop travado

**O problema em uma frase.** `async` não cria thread nenhuma, então um laço de CPU
dentro de um handler `async` congela o processo inteiro.

**O que aparece na tela.** O heartbeat batendo em 100 ms, depois nada, depois uma
batida com `intervalo 1894.1 ms <-- atrasou 1794 ms`. Das 26 batidas esperadas,
saíram 8.

**Como conduzir.** Deixe as quatro primeiras batidas saírem antes de falar. O
silêncio no meio é o slide.

**A pergunta que a plateia faz.** *"Mas eu botei `async` na função."* `async` só
promete que a função **pode** ceder o controle num `await`. Se não há `await`
dentro do laço, não há cessão nenhuma. `async` é sobre esperar, não sobre
paralelizar.

## 5. conexão compartilhada

**O problema em uma frase.** Um `Client` compartilhado no lugar de um `Pool`
transforma toda a concorrência do processo em uma fila, sem que ninguém tenha
escrito um laço sequencial.

**O que aparece na tela.** `Client compartilhado 1418 ms` contra
`Pool com max=32: 110 ms`. 12,8x mais lento com a mesma concorrência declarada. E
a linha que fecha o cenário: a divergência continua diferente de zero.

**O detalhe que vale ouro.** O próprio `pg` avisa. Durante a execução aparece
`DeprecationWarning: Calling client.query() when the client is already executing a
query`. O driver está dizendo, em texto, que você enfileirou.

**A pergunta que a plateia faz.** *"Se serializou, não deveria estar correto?"*
Não, e essa é a melhor pergunta do bloco A. O driver serializa as **queries**, não
as **transações**. A ordem vira `SELECT-A, SELECT-B, UPDATE-A, UPDATE-B`, e os
dois leem o mesmo saldo velho do mesmo jeito. Perdeu-se o desempenho e não se
ganhou a correção.

**Nota de honestidade, se perguntarem.** O cenário usa `pg_sleep` de 2 ms por
query. Com o Postgres em loopback cada query responde em 0,15 ms e o gargalo vira
a CPU do próprio Node, o que esconde o efeito. Os 2 ms são a latência que um banco
de verdade na rede tem e o loopback não. Diga isso antes que alguém descubra.

---

# Bloco B: paralelismo real com worker_threads

**Transição.** Até aqui, nenhuma thread. Agora threads de verdade. A pergunta que
o bloco B responde é: *o que muda?*

## 6. corrida em memória com SharedArrayBuffer

**O problema em uma frase.** Dois núcleos incrementando o mesmo inteiro sem
`Atomics` perdem incrementos, e o valor final nunca bate.

**O que aparece na tela.** Esperado 8.000.000, contador em 2.529.099, 68% perdido.
Rode três vezes: 68,39%, 73,66%, 73,01%. Nunca o mesmo número.

**Como conduzir.** Peça para a plateia prever o resultado antes de rodar. Quase
todo mundo chuta "vai dar um pouco menos". Ninguém chuta um terço.

**A pergunta que a plateia faz.** *"Isso é o mesmo bug do cenário 2?"* É o mesmo
bug, sim, com uma janela de tamanho diferente. Lá o intervalo perigoso era um
`await` e a janela tinha centenas de microssegundos. Aqui é `carrega, soma,
escreve` e a janela tem nanossegundos. Mesmo lost update, escalas diferentes.

## 7. o mesmo trabalho em workers

**O problema em uma frase.** Não é um problema, é o contraponto: o mesmo trabalho
do cenário 4 fica mais rápido conforme se adiciona worker, e o heartbeat não para.

**O que aparece na tela.** A tabela de 1 a 8 workers, com o tempo caindo de 1843
para 345 ms (5,3x), e a coluna da direita mostrando a maior lacuna do event loop
parada em 101 ms nas quatro linhas.

**Como conduzir.** Volte ao slide do cenário 4 e ponha os dois números na mesma
tela: 1894 ms de lacuna contra 101 ms. É o mesmo trabalho de CPU.

**A pergunta que a plateia faz.** *"Então worker resolve?"* Resolve trabalho de
CPU. Não resolve corrida, e o próximo cenário mostra isso. `async/await` serve
para esperar I/O, `worker_threads` serve para gastar CPU, e trocar um pelo outro
não resolve nada.

**Nota de honestidade, se perguntarem por que não é sha256.** A primeira versão
usava `crypto.createHash`, que aloca um contexto do OpenSSL por rodada. Com 8
threads a disputa pelo alocador derrubava cada worker para menos de um terço da
velocidade e a curva ficava achatada por um motivo que não tem nada a ver com o
assunto da aula. O laço atual é aritmética de inteiros pura, sem alocar um byte.

## 8. a mesma corrida com paralelismo real

**O problema em uma frase.** Trocar promises por workers não corrige o lost
update: ele continua, com um padrão de perda diferente.

**O que aparece na tela.** As duas linhas lado a lado, no mesmo comando:

```
02 promises (1 thread)     divergencia  165   debitou  35 de 200   3315 ops/s
08 workers (8 threads)     divergencia  159   debitou  41 de 200    884 ops/s
```

**Como conduzir.** Esta é a resposta ao "então worker resolve?" do cenário
anterior. Paralelismo real custou 4x o throughput e entregou a mesma perda.

**A pergunta que a plateia faz.** *"Por que os workers ficaram mais lentos?"*
Subir worker custa caro: são processos de V8 novos, com módulos para carregar e
pools para abrir. Para 200 saques de 3 queries cada, o custo de subir a thread é
maior que o trabalho. Worker paga quando o trabalho é longo e de CPU, como no
cenário 7, não quando é curto e de I/O.

## 9. deadlock

**O problema em uma frase.** Duas transferências em direções opostas travam uma à
outra, sem que exista um único `lock` escrito no código.

**O que aparece na tela.** `tentativas 80`, `commitadas 13`, `abortadas 67`,
`destas, deadlock 40P01: 67`. 83,8% das transferências mortas.

**Como conduzir.** Antes de rodar, pergunte onde está o lock no código. Não está.
Deixe alguém procurar por dez segundos, e então mostre a linha do `UPDATE`.

**A pergunta que a plateia faz.** *"Isso é bug do Postgres?"* Não. É o Postgres
avisando que o código travou. Sem a detecção, as duas transações esperariam para
sempre e o `40P01` nunca chegaria, o que seria muito pior. A correção real seria
travar as linhas sempre na mesma ordem, ordenando as contas por `id`, mais retry.
Nenhuma das duas está aqui de propósito.

## 10. leitura suja

**O problema em uma frase.** Um relatório pode mostrar um número errado sem que
nenhum dado esteja errado, se ele ler no meio de uma operação que ainda não
acabou.

**O que aparece na tela.** 92,6% das amostras com o total errado, mínimo observado
de 9.500 contra um total real de 10.000, e a linha final:
`divergencia 0.00 (invariante preservada)`.

**Como conduzir.** Este é o cenário que mais confunde, porque as duas afirmações
parecem se contradizer: nada se perdeu **e** o total estava errado 92% do tempo.
Ponha as duas na mesma frase e deixe o silêncio trabalhar. Depois mostre o gráfico
`serie-leitura-suja.svg`, onde a linha vermelha tracejada é o total real e a série
azul é o que o dashboard viu.

**A pergunta que a plateia faz.** *"Isso não é o `dirty read` que o isolamento
resolve?"* Não exatamente, e aqui vale a precisão. As transferências deste cenário
não estão dentro de uma transação: são dois `UPDATE` independentes, cada um com
seu próprio commit. Não há nada de sujo para o Postgres esconder, porque cada
metade já está commitada. Nível de isolamento não conserta operação que não é
transação.

## 11. heisenbug

**O problema em uma frase.** Colocar um `console.log` para investigar um bug de
corrida muda o bug que se está investigando.

**O que aparece na tela.** Dois painéis com respostas opostas. No banco, fator
1,01x: o log não mudou nada. Em memória, fator 0,19x: a perda caiu de 26% para 5%
e ficou muito mais estável (5,13%, 4,69%, 5,03% contra 26,72%, 15,33%, 35,22%).

**Como conduzir.** Rode sem redirecionar primeiro, para a tela encher de
`[debug]`. Aponte que o barulho é o experimento. Depois rode com `2>/dev/null`
para ler a tabela.

**A pergunta que a plateia faz.** *"Então log esconde bug ou não?"* Depende do
tamanho do log comparado ao tamanho da janela da corrida. No banco a janela é uma
ida ao Postgres (~300 µs) e o log custa poucos µs, ou seja 1% da janela: não muda
nada. Em memória a janela é de nanossegundos e o mesmo log é mil vezes maior que
ela: apaga o bug. Como ninguém sabe de cabeça o tamanho da janela, um print nunca
é prova de nada. Bug de corrida se investiga com invariante medida e execução
repetida, que é exatamente o que o `resultados.csv` deste projeto tem.

---

## Fechamento

Três frases, na ordem:

1. Os cenários 2 e 6 são o mesmo bug, com janelas de tamanhos diferentes. Um deles
   não tem thread nenhuma.
2. O cenário 8 mostra que trocar promise por thread não corrigiu nada, só ficou
   4x mais lento.
3. O cenário 11 mostra que a ferramenta que todo mundo usa para investigar isso
   (o print) é a que menos serve.

E o que não está aqui: `SELECT ... FOR UPDATE`, `UPDATE saldo = saldo - x`,
`SERIALIZABLE` com retry, mutex de aplicação. Se sobrar tempo, essa é a próxima
apresentação.
