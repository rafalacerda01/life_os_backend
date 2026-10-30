# K01 — reprodução local isolada

P1 RED; K01 ABERTO; rollout CLOSED. Estes testes não certificam IAM, geração Auth ou entrega de eventos Cloud.

Use as dependências locais previstas no repositório, Node 22 e Java/JAR Firestore Emulator já instalados. Nenhuma instalação, login ou download é executado pelo launcher.

Na raiz deste repositório, execute:

```powershell
& 'C:\tools\node.exe' tools/k01/emulator-run.cjs
```

Em outra máquina, escolha o executável Node 22 instalado. O Java padrão Windows é o JBR do Android Studio; em outros sistemas, /usr/bin/java. Para caminhos diferentes, configure K01_JAVA_EXE e K01_FIRESTORE_JAR com caminhos absolutos locais. O JAR padrão é ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar.

O launcher fixa demo-life-os e 127.0.0.1, usa perfil vazio e ambiente sem credenciais herdadas, bloqueia conexões externas/ADC nos clientes e encerra o processo Emulator de sua propriedade. Logs/TAP/result.json ficam em um diretório temporário exclusivo impresso ao terminar, fora do repositório. Falha, skip, cancelamento, interrupção ou encerramento não confirmado impedem PASS.

A seleção cobre 21 casos SDK nativos e não depende do repositório Flutter/Functions. deny-all.rules é uma fixture local; os testes Admin usam somente o token sintético owner aceito pelo Emulator.

A substituição com conteúdo idêntico usa delete e recriação reais; um set idêntico pode ser uma operação sem mudança de updateTime. A pausa K01 alcança a leitura da página dentro da transação destrutiva após a última consulta Auth, com dados A/B preservados. Auth e eventos são portas sintéticas; transações, versões, recibos e Rules Firestore usam SDK real.

Os arquivos SDK optam por skip fora deste launcher para não procurar credenciais ou serviços ao executar a suíte offline comum. Na execução isolada, nenhum caso pode ser skipped.
