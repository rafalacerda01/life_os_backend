import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) {
  initializeApp({ projectId: 'chat-context-minimization-test' });
}

const { chatHandler } = await import('../api/chat.js');

const MODEL_DATA_PREFIX = '[DADOS NÃO CONFIÁVEIS DO USUÁRIO]\n';
const OUT_OF_SCOPE_REPLY =
  'Posso ajudar com sua rotina, produtividade, estudos, hábitos, metas, ' +
  'finanças, hidratação e bem-estar. Receitas culinárias gerais e outros ' +
  'assuntos fora desse escopo não fazem parte do Core.';

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function successResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: 'Resposta minimizada' }],
          },
        },
      ],
    }),
  };
}

function extractModelPayload(options) {
  const geminiBody = JSON.parse(options.body);
  const text = geminiBody.contents[0].parts[0].text;
  assert.ok(text.startsWith(MODEL_DATA_PREFIX));
  return JSON.parse(text.slice(MODEL_DATA_PREFIX.length));
}

async function invokeChat({
  message,
  context = {},
  uid,
  fetch,
}) {
  const res = responseStub();
  await chatHandler(
    {
      method: 'POST',
      headers: {
        'x-firebase-appcheck': 'valid-app-check',
        authorization: 'Bearer valid-id-token',
      },
      body: { message, context },
    },
    res,
    {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async () => ({ uid }),
      hasAiConsent: async () => true,
      hasPremiumAccess: async () => true,
      checkRateLimit: async () => true,
      geminiApiKey: 'test-api-key',
      fetch,
    },
  );
  return res;
}

test('UID autenticado nunca é enviado ao Gemini', async () => {
  const secretUid = 'uid-super-secreto';
  let options;
  const response = await invokeChat({
    message: 'Como melhorar meu foco nos estudos?',
    uid: secretUid,
    fetch: async (_, receivedOptions) => {
      options = receivedOptions;
      return successResponse();
    },
  });

  const modelPayload = extractModelPayload(options);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(modelPayload.context, {});
  assert.equal(Object.hasOwn(modelPayload, 'userId'), false);
  assert.doesNotMatch(options.body, new RegExp(secretUid));
});

test('pergunta financeira envia somente agregados financeiros', async () => {
  let options;
  await invokeChat({
    message: 'Como estão meus gastos?',
    uid: 'finance-context-user',
    context: {
      humor: 'triste',
      hidratacao_ml: 500,
      medicamentos_ativos: 3,
      fase_ciclo: 'menstrual',
      financas: {
        saldo_atual: 100,
        total_entradas: 500,
        total_saidas: 400,
      },
    },
    fetch: async (_, receivedOptions) => {
      options = receivedOptions;
      return successResponse();
    },
  });

  assert.deepEqual(extractModelPayload(options).context, {
    financas: {
      saldo_atual: 100,
      total_entradas: 500,
      total_saidas: 400,
    },
  });
});

test('pergunta de hidratação envia somente hidratacao_ml', async () => {
  let options;
  await invokeChat({
    message: 'Estou bebendo pouca água?',
    uid: 'hydration-context-user',
    context: {
      humor: 'bem',
      hidratacao_ml: 500,
      medicamentos_ativos: 2,
      fase_ciclo: 'luteal',
      financas: {
        saldo_atual: 100,
        total_entradas: 500,
        total_saidas: 400,
      },
    },
    fetch: async (_, receivedOptions) => {
      options = receivedOptions;
      return successResponse();
    },
  });

  assert.deepEqual(extractModelPayload(options).context, {
    hidratacao_ml: 500,
  });
});

test('alimentação contextual ao ciclo permite somente fase derivada', async () => {
  let options;
  await invokeChat({
    message: 'Estou menstruada e com vontade de chocolate. O que posso comer?',
    uid: 'cycle-food-context-user',
    context: {
      humor: 'cansada',
      hidratacao_ml: 500,
      medicamentos_ativos: 2,
      fase_ciclo: 'menstrual',
      financas: {
        saldo_atual: 100,
        total_entradas: 500,
        total_saidas: 400,
      },
    },
    fetch: async (_, receivedOptions) => {
      options = receivedOptions;
      return successResponse();
    },
  });

  assert.deepEqual(extractModelPayload(options).context, {
    fase_ciclo: 'menstrual',
  });
});

test('bolo genérico recebe resposta local sem chamar Gemini', async () => {
  let fetchCalls = 0;
  const response = await invokeChat({
    message: 'Como faço um bolo de chocolate?',
    uid: 'out-of-scope-user',
    context: { humor: 'privado', hidratacao_ml: 500 },
    fetch: async () => {
      fetchCalls += 1;
      return successResponse();
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { reply: OUT_OF_SCOPE_REPLY });
  assert.equal(fetchCalls, 0);
});

test('finanças não liberam receita culinária genérica', async () => {
  let fetchCalls = 0;
  const response = await invokeChat({
    message: 'Como faço um bolo de chocolate para economizar dinheiro?',
    uid: 'finance-recipe-user',
    fetch: async () => {
      fetchCalls += 1;
      return successResponse();
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { reply: OUT_OF_SCOPE_REPLY });
  assert.equal(fetchCalls, 0);
});

test('Life OS não libera receita culinária genérica', async () => {
  let fetchCalls = 0;
  const response = await invokeChat({
    message: 'Como faço uma receita de bolo de chocolate no Life OS?',
    uid: 'life-os-recipe-user',
    fetch: async () => {
      fetchCalls += 1;
      return successResponse();
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { reply: OUT_OF_SCOPE_REPLY });
  assert.equal(fetchCalls, 0);
});

test('tarefas não liberam receita culinária genérica', async () => {
  let fetchCalls = 0;
  const response = await invokeChat({
    message: 'Como fazer bolo de chocolate como uma tarefa?',
    uid: 'task-recipe-user',
    fetch: async () => {
      fetchCalls += 1;
      return successResponse();
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { reply: OUT_OF_SCOPE_REPLY });
  assert.equal(fetchCalls, 0);
});

test('alimentação contextual a estudos continua dentro do escopo', async () => {
  let fetchCalls = 0;
  let options;
  const response = await invokeChat({
    message: 'O que posso comer antes de estudar para ter mais energia?',
    uid: 'study-food-user',
    context: {
      financas: {
        saldo_atual: 100,
        total_entradas: 500,
        total_saidas: 400,
      },
    },
    fetch: async (_, receivedOptions) => {
      fetchCalls += 1;
      options = receivedOptions;
      return successResponse();
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(extractModelPayload(options).context, {});
});

test('produtividade permanece no escopo com contexto vazio', async () => {
  let fetchCalls = 0;
  let options;
  const response = await invokeChat({
    message: 'Como melhorar meu foco nos estudos?',
    uid: 'productivity-context-user',
    context: {
      humor: 'privado',
      hidratacao_ml: 500,
      medicamentos_ativos: 2,
      fase_ciclo: 'luteal',
      financas: {
        saldo_atual: 100,
        total_entradas: 500,
        total_saidas: 400,
      },
    },
    fetch: async (_, receivedOptions) => {
      fetchCalls += 1;
      options = receivedOptions;
      return successResponse();
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(extractModelPayload(options).context, {});
});

test('cliente antigo não consegue enviar campos sensíveis ao Gemini', async () => {
  const secrets = [
    'MEDICAMENTO-SECRETO-XYZ',
    'LAST-PERIOD-SECRET',
    'EMAIL-SECRET@example.com',
    'DOCUMENT-ID-SECRET',
    'CAMPO-ARBITRARIO-SECRET',
  ];
  let options;
  await invokeChat({
    message: 'Como estão meus gastos?',
    uid: 'legacy-client-user',
    context: {
      humor: 'bem',
      hidratacao: '1500ml',
      medicamentos: secrets[0],
      ciclo_menstrual: {
        lastPeriodStart: secrets[1],
        cycleLengthDays: 28,
      },
      financas: {
        saldo_atual: 100,
        total_entradas: 500,
        total_saidas: 400,
        transactionId: secrets[3],
      },
      data_coleta: '2026-08-24T20:00:00',
      status: 'Online',
      email: secrets[2],
      campo_arbitrario: secrets[4],
    },
    fetch: async (_, receivedOptions) => {
      options = receivedOptions;
      return successResponse();
    },
  });

  const serializedBody = options.body;
  for (const secret of secrets) {
    assert.doesNotMatch(serializedBody, new RegExp(secret));
  }
  assert.deepEqual(extractModelPayload(options).context, {
    financas: {
      saldo_atual: 100,
      total_entradas: 500,
      total_saidas: 400,
    },
  });
});

test('finanças descartam campos extras e descrições', async () => {
  let options;
  await invokeChat({
    message: 'Como estão minhas finanças?',
    uid: 'finance-extra-fields-user',
    context: {
      financas: {
        saldo_atual: 100,
        total_entradas: 500,
        total_saidas: 400,
        transactionId: 'DOCUMENT-ID-SECRET',
        description: 'DESCRICAO-SECRETA',
        category: 'CATEGORIA-SECRETA',
      },
    },
    fetch: async (_, receivedOptions) => {
      options = receivedOptions;
      return successResponse();
    },
  });

  assert.deepEqual(extractModelPayload(options).context, {
    financas: {
      saldo_atual: 100,
      total_entradas: 500,
      total_saidas: 400,
    },
  });
  assert.doesNotMatch(
    options.body,
    /DOCUMENT-ID-SECRET|DESCRICAO-SECRETA|CATEGORIA-SECRETA/,
  );
});

test('tipos inválidos são omitidos do contexto do modelo', async () => {
  let options;
  await invokeChat({
    message: 'Analise humor, água, medicamentos, ciclo e gastos',
    uid: 'invalid-context-types-user',
    context: {
      humor: { value: 'privado' },
      hidratacao_ml: '1500ml',
      medicamentos_ativos: [],
      fase_ciclo: 'texto-livre',
      financas: {
        saldo_atual: '100',
        total_entradas: {},
        total_saidas: [],
      },
    },
    fetch: async (_, receivedOptions) => {
      options = receivedOptions;
      return successResponse();
    },
  });

  assert.deepEqual(extractModelPayload(options).context, {});
});

test('NaN e Infinity são rejeitados antes de qualquer chamada Gemini', async () => {
  let fetchCalls = 0;
  const response = await invokeChat({
    message: 'Analise minha água e medicamentos',
    uid: 'non-finite-context-user',
    context: {
      hidratacao_ml: Number.NaN,
      medicamentos_ativos: Number.POSITIVE_INFINITY,
    },
    fetch: async () => {
      fetchCalls += 1;
      return successResponse();
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(fetchCalls, 0);
});
