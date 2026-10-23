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

/* ── A-16: la notificación al asesor se espera antes de responder ── */

test('paso 3: el aviso al asesor ya se envió cuando el webhook responde', async () => {
  // Respuestas lentas de la API: si el aviso no se espera, queda colgado tras la Response.
  globalThis.fetch = async (url, init) => {
    await new Promise(r => setTimeout(r, 20));
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
  const env = {
    ...baseEnv(),
    WA_WEBHOOK_SECRET: 's3cr3t',
    NOTIFY_WA_NUM: '50611112222',
    DB: makeFakeDB({ rows: [{ step: 3, nombre: 'Ana', cedula: '1-1111-1111', disponibilidad: null, completed_at: null }] }),
  };
  const res = await bot.fetch(webhook({
    headers: { 'x-webhook-secret': 's3cr3t' },
    body: { remoteJid: '50688887777', text: 'lunes en la tarde', messageId: 'm3' },
  }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(sent.map(s => s.body.number), ['50688887777', '50611112222']);
});

/* ── M-054: adaptadores de payload y firma de Meta ───────────── */

const conSecreto = () => ({ ...baseEnv(), WA_WEBHOOK_SECRET: 's3cr3t' });
const hdr = { 'x-webhook-secret': 's3cr3t' };

test('evolution messages.upsert: responde al remoteJid sin el sufijo de WhatsApp', async () => {
  const body = { event: 'messages.upsert', data: { key: { remoteJid: '50688887777@s.whatsapp.net', id: 'ABC' }, message: { conversation: 'hola' } } };
  const res = await bot.fetch(webhook({ headers: hdr, body }), conSecreto());
  assert.equal(res.status, 200);
  assert.deepEqual(sent.map(s => s.body.number), ['50688887777']);
});

test('evolution: ignora los mensajes propios (fromMe)', async () => {
  const body = { data: { key: { remoteJid: '50688887777@s.whatsapp.net', id: 'X', fromMe: true }, message: { conversation: 'info' } } };
  const res = await bot.fetch(webhook({ headers: hdr, body }), conSecreto());
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
});

test('formato Dify: usa el usuario como teléfono y no deduplica (sin messageId)', async () => {
  const env = conSecreto();
  const body = { query: 'info', user: '50688887777@c.us', conversation_id: 'c1', inputs: {} };
  const res = await bot.fetch(webhook({ headers: hdr, body }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(sent.map(s => s.body.number), ['50688887777']);
  assert.ok(!env.DB.calls.some(c => c.sql.includes('wa_inbound')), 'sin dedup');
  const upsert = env.DB.calls.find(c => c.sql.includes('INSERT INTO wa_sessions'));
  assert.equal(upsert.params[1], 1, 'la sesión avanza al paso 1');
});

async function firmaMeta(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return 'sha256=' + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

test('meta: acepta la firma HMAC válida y rechaza una alterada', async () => {
  const env = { ...baseEnv(), WA_PROVIDER: 'meta', WA_APP_SECRET: 'app', WA_PHONE_ID: 'p1' };
  const body = { entry: [{ changes: [{ value: { messages: [{ from: '50688887777', id: 'w1', type: 'text', text: { body: 'hola' } }] } }] }] };
  const raw = JSON.stringify(body);
  const firma = await firmaMeta('app', raw);

  const mala = await bot.fetch(webhook({ headers: { 'x-hub-signature-256': firma.replace(/.$/, c => (c === '0' ? '1' : '0')) }, body }), env);
  assert.equal(mala.status, 403);

  const buena = await bot.fetch(webhook({ headers: { 'x-hub-signature-256': firma }, body }), env);
  assert.equal(buena.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.to, '50688887777');
});
