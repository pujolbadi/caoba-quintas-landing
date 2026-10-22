import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import bot from './bot.js';
import { makeFakeDB } from './fake-db.js';

// El bot llama a la API de WhatsApp con fetch global: se reemplaza por un espía.
const realFetch = globalThis.fetch;
let sent;
beforeEach(() => {
  sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const baseEnv = () => ({
  DB: makeFakeDB(),
  WA_PROVIDER: 'evolution',
  WA_API_URL: 'https://evo.example',
  WA_INSTANCE: 'caoba',
  WA_API_TOKEN: 't',
});

function webhook({ query = '', headers = {}, body = { remoteJid: '50688887777', text: 'hola', messageId: 'm1' } } = {}) {
  return new Request(`https://caobaquintas.com/webhook/wa${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/* ── A-15: autenticación del webhook ─────────────────────────── */

test('webhook: sin WA_WEBHOOK_SECRET configurado responde 403 y no envía nada (falla cerrado)', async () => {
  const env = baseEnv();
  const res = await bot.fetch(webhook(), env);
  assert.equal(res.status, 403);
  assert.equal(sent.length, 0);
  assert.equal(env.DB.calls.length, 0);
});

test('webhook Meta: sin WA_APP_SECRET configurado responde 403', async () => {
  const env = { ...baseEnv(), WA_PROVIDER: 'meta' };
  const res = await bot.fetch(webhook({ headers: { 'x-hub-signature-256': 'sha256=00' } }), env);
  assert.equal(res.status, 403);
  assert.equal(sent.length, 0);
});

test('webhook: el secreto en la query (?secret=) ya no autentica', async () => {
  const env = { ...baseEnv(), WA_WEBHOOK_SECRET: 's3cr3t' };
  const res = await bot.fetch(webhook({ query: '?secret=s3cr3t' }), env);
  assert.equal(res.status, 403);
  assert.equal(sent.length, 0);
});

test('webhook: con el secreto correcto en x-webhook-secret procesa el mensaje', async () => {
  const env = { ...baseEnv(), WA_WEBHOOK_SECRET: 's3cr3t' };
  const res = await bot.fetch(webhook({ headers: { 'x-webhook-secret': 's3cr3t' } }), env);
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.number, '50688887777');
});
