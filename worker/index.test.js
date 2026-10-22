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
