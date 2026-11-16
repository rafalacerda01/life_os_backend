# Life OS — Premium sem Firebase (proposta técnica, não implantada)

Data: 2026-11-16
Branch: refactor/premium-without-firebase-20261116
Status: DESIGN_ONLY / nenhum endpoint habilitado ou implantado

## Contrato de arquitetura
- Os módulos Flutter armazenam dados pessoais exclusivamente no dispositivo (Drift/SQLite e demais armazenamentos locais migrados).
- A Vercel atua apenas nos serviços online estritamente necessários; a validação de compras Google Play fica separada de quaisquer dados de Saúde, Finanças, Tarefas, Estudos, etc.
- O aplicativo não exige criação de conta Firebase, Firestore nem token Firebase App Check para usar os módulos.
- IA Companion e Círculos colaborativos permanecem desabilitados no lançamento.
- Uma compra validada habilita recursos Premium, não sincronização de conteúdo.
- Não ativar endpoints de Billing v2 antes dos testes de segurança e do ambiente de publicação na Google Play.

## Dependências atuais que NÃO podem ser simplesmente apagadas
- `api/billing/google/_shared.js` exige Firebase ID token, App Check e Firestore.
- `api/billing/google/_reconciliation.js` armazena estado por UID, token e transações do Firestore.
- `api/billing/google/verify.js` usa a reconciliação por UID.
- Handlers de RTDN, consultas Play e rate-limit distribuído também devem ser inventariados.
- Uma alteração apenas no cliente quebra verificação, renovação, restauração e revogação.
- A Google Play Developer API e as credenciais de serviço podem exigir um projeto Google Cloud mínimo, separado da antiga infraestrutura de identidade. Validar o requisito antes de excluir todos os projetos.
- Nenhum armazenamento durável, banco pago ou credencial nova está autorizado neste documento.

## Fluxo proposto para futura implementação
1. O aplicativo gera uma chave de instalação não exportável no Android Keystore e guarda dados do perfil local sem expô-los ao servidor.
2. Para efetuar/restaurar uma compra, o cliente obtém um desafio do backend, apresenta prova de posse da chave de instalação e, quando viável, uma prova de integridade do app com nonce vinculado à solicitação. Não confiar em UID local informado pelo cliente.
3. O cliente envia apenas token de compra, identificadores mínimos do produto, desafio e prova de integridade/posse. Nunca enviar dados dos módulos.
4. O backend consulta a Google Play Developer API e decide os direitos com base no estado efetivo da assinatura, validade, produto, plano, acknowledgement, linhagem e revogação. Não conceder Premium a partir de resposta declarada pelo cliente.
5. O backend utiliza armazenamento durável com unicidade por hash do token e política explícita de transferência/restauração. Não duplicar concessões em compras concorrentes.
6. Após validar, a Vercel emite autorização curta e assinada, vinculada à instalação, com campos mínimos (issuer, audience, product, tier, issuedAt, expiresAt, deviceKeyThumbprint, keyId). A chave privada nunca vai para o app.
7. O Flutter verifica assinatura e validade da autorização localmente; usa Premium offline apenas até seu prazo. Retornos de rede não devem apagar dados existentes.
8. Renovação, cancelamento, reembolso, troca de aparelho, restauração, clock rollback e rotação de chaves exigem testes explícitos antes de lançamento.

## Requisitos de segurança que permanecem BLOCKED
- Armazenamento durável e consistente para identidade da compra, replay, rate limit e recuperação de assinatura (escolher após avaliar custo real).
- Autenticidade do app e proteção contra roubo do purchase token. Não confiar em IDs, headers ou tokens não verificados.
- Verificação efetiva de Play Integrity / outro mecanismo escolhido, com integração e custos avaliados.
- Revogação e atualização de compras com RTDN/consultas periódicas: definir sem recriar sincronização de dados pessoais.
- Restauração no novo dispositivo quando não há login obrigatório, sem vincular permanentemente a compra ao aparelho original.
- Limites da operação totalmente offline e proteção contra manipulação do relógio do dispositivo.
- Requisitos atuais de Google Play Console, vinculação à Google Cloud e serviço de faturamento.
- A solução não garante custo absoluto zero; não criar recursos faturáveis automaticamente.

## Critérios de prova
- Compra válida, expirada, em carência, cancelada, reembolsada e token revogado.
- Reenvio do mesmo token, token furtado, múltiplos dispositivos, concorrência e recuperação após reinstalação.
- Cliente adulterado e ausência/invalidade de atestação.
- Assinaturas válidas usam a mesma política de entitlement em Android, serviço e status local.
- Modo avião não impede uso dos módulos e não concede Premium para sempre.
- Nenhum dado dos módulos é transmitido à Vercel.
- Sem Firebase Admin, Firebase Auth, Firestore ou Firebase App Check nos caminhos online definitivos.
- Testes negativos e de regressão Node + fluxo real Google Play (trilha interna) antes de qualquer deploy.

## Limites da fase atual
Este arquivo é uma especificação inicial, não uma implementação ou aprovação do Billing.
Não alterar endpoints ativos, segredos ou deploys da Vercel nesta fase.
Não desligar projetos Google Cloud até confirmar requisitos mínimos do Billing.
