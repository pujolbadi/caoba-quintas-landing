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

/* ── M-051: correo de aviso y límites de longitud ────────────── */

test('leads: el correo de aviso escapa nombre y teléfono', async t => {
  const enviados = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    enviados.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  });
  const env = { DB: makeFakeDB(), RESEND_API_KEY: 'k', NOTIFY_EMAIL: 'a@b.c' };
  const res = await worker.fetch(leadRequest({
    nombre: '<a href="https://phish.example">Ganaste</a>',
    telefono: '<img src=x>',
    fuente: 'hero',
  }), env);
  assert.equal(res.status, 201);
  assert.equal(enviados.length, 1);
  assert.ok(!enviados[0].html.includes('<a '), 'sin enlaces inyectados');
  assert.ok(!enviados[0].html.includes('<img'), 'sin imágenes inyectadas');
  assert.ok(enviados[0].html.includes('&lt;a href='));
});

test('leads: rechaza nombre o teléfono de más de 120 caracteres', async () => {
  const env = { DB: makeFakeDB() };
  const largo = 'x'.repeat(121);
  for (const body of [{ nombre: largo, telefono: '8888' }, { nombre: 'Ana', telefono: largo }]) {
    const res = await worker.fetch(leadRequest(body), env);
    assert.equal(res.status, 400);
  }
  assert.equal(env.DB.calls.length, 0);
  const ok = await worker.fetch(leadRequest({ nombre: 'x'.repeat(120), telefono: '8888' }), env);
  assert.equal(ok.status, 201);
});

/* ── M-052: inyección de fórmulas en el CSV ──────────────────── */

test('csv: neutraliza valores que empiezan como fórmula', async () => {
  const env = {
    ADMIN_PASSWORD: 'pw',
    DB: makeFakeDB({
      rows: [
        { id: 1, nombre: '=HYPERLINK("https://x.example","clic")', telefono: '+50688887777', fuente: 'hero', created_at: '' },
        { id: 2, nombre: '@SUM(A1)', telefono: '-1', fuente: '\tcta_final', created_at: '' },
        { id: 3, nombre: 'Ana, Pérez', telefono: '8888', fuente: 'hero', created_at: '' },
      ],
    }),
  };
  const res = await worker.fetch(adminRequest('/api/admin/leads.csv', basic('admin', 'pw')), env);
  assert.equal(res.status, 200);
  const [, l1, l2, l3] = (await res.text()).split('\n');
  assert.equal(l1, `1,"'=HYPERLINK(""https://x.example"",""clic"")",'+50688887777,hero,`);
  assert.equal(l2, `2,'@SUM(A1),'-1,'\tcta_final,`);
  assert.equal(l3, '3,"Ana, Pérez",8888,hero,');
});
