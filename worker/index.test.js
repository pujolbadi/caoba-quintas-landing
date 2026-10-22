import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { makeFakeDB } from './fake-db.js';

const basic = (user, pass) => 'Basic ' + btoa(`${user}:${pass}`);

function adminRequest(path, auth) {
  const headers = auth ? { Authorization: auth } : {};
  return new Request(`https://caobaquintas.com${path}`, { headers });
}

/* ── C-03: autenticación del panel ───────────────────────────── */

test('panel: sin ADMIN_PASSWORD configurada responde 503 a cualquier credencial (falla cerrado, sin contraseña por defecto)', async () => {
  const env = { DB: makeFakeDB() };
  for (const path of ['/api/admin', '/api/admin/leads', '/api/admin/leads.csv']) {
    for (const auth of [undefined, basic('admin', ''), basic('admin', 'cualquier-cosa')]) {
      const res = await worker.fetch(adminRequest(path, auth), env);
      assert.equal(res.status, 503, `${path} auth=${auth}`);
    }
  }
  assert.equal(env.DB.calls.length, 0, 'no debe tocar la base sin autenticación');
});

test('panel: con ADMIN_PASSWORD acepta solo la contraseña configurada', async () => {
  const env = { DB: makeFakeDB(), ADMIN_PASSWORD: 'secreto-de-prueba' };
  const mala = await worker.fetch(adminRequest('/api/admin', basic('admin', 'otra')), env);
  assert.equal(mala.status, 401);
  const buena = await worker.fetch(adminRequest('/api/admin', basic('admin', 'secreto-de-prueba')), env);
  assert.equal(buena.status, 200);
});

/* ── C-02: XSS almacenado en el panel ────────────────────────── */

const XSS = '"><img src=x onerror=alert(1)>';

test('panel: escapa fuente en la clase del badge y en las tarjetas de conteo', async () => {
  const env = {
    ADMIN_PASSWORD: 'pw',
    DB: makeFakeDB({
      rows: [{ id: 1, nombre: '<b>Ana</b>', telefono: '+506 8888', fuente: XSS, created_at: '2026-10-01T10:00:00Z' }],
    }),
  };
  const res = await worker.fetch(adminRequest('/api/admin', basic('admin', 'pw')), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('<img'), 'no debe haber etiquetas inyectadas');
  assert.ok(!html.includes('<b>Ana'), 'el nombre se escapa');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

function leadRequest(body) {
  return new Request('https://caobaquintas.com/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('leads: rechaza una fuente fuera de la lista permitida sin guardarla', async () => {
  const env = { DB: makeFakeDB() };
  for (const fuente of [XSS, 'Hero', 'a b', 'x'.repeat(41)]) {
    const res = await worker.fetch(leadRequest({ nombre: 'Ana', telefono: '8888', fuente }), env);
    assert.equal(res.status, 400, `fuente=${fuente}`);
  }
  assert.equal(env.DB.calls.length, 0);
});

test('leads: acepta las fuentes que envía el sitio (hero, cta_final, lote_*)', async () => {
  for (const fuente of ['hero', 'cta_final', 'lote_lote-11', undefined]) {
    const env = { DB: makeFakeDB() };
    const res = await worker.fetch(leadRequest({ nombre: 'Ana', telefono: '8888', fuente }), env);
    assert.equal(res.status, 201, `fuente=${fuente}`);
    assert.equal(env.DB.calls[0].params[2], fuente ?? 'hero');
  }
});
