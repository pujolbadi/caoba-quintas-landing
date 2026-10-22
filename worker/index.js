export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/leads' && request.method === 'POST') {
      return handleLead(request, env);
    }

    if (url.pathname === '/api/admin' || url.pathname === '/api/admin/') {
      return handleAdmin(request, env);
    }

    if (url.pathname === '/api/admin/leads' && request.method === 'GET') {
      return handleAdminLeads(request, env, 'json');
    }

    if (url.pathname === '/api/admin/leads.csv' && request.method === 'GET') {
      return handleAdminLeads(request, env, 'csv');
    }

    return new Response('Not found', { status: 404 });
  },
};

/* ── Auth helper ─────────────────────────────────────────────── */
// Sin ADMIN_PASSWORD configurada el panel queda cerrado (503): no hay
// contraseña por defecto. Configurar con `wrangler secret put ADMIN_PASSWORD`.
function adminGuard(request, env) {
  if (!env.ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD no configurada: panel de administración deshabilitado.');
    return new Response('Panel no configurado', { status: 503 });
  }
  if (!checkAuth(request, env)) return unauthorizedResponse();
  return null;
}

function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Basic ')) return false;

  const decoded = atob(authHeader.slice(6));
  const [user, pass] = decoded.split(':');
  return user === 'admin' && pass === env.ADMIN_PASSWORD;
}

function unauthorizedResponse() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Caoba Quintas Admin"' },
  });
}

/* ── Admin HTML dashboard ────────────────────────────────────── */
async function handleAdmin(request, env) {
  const denied = adminGuard(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    'SELECT id, nombre, telefono, fuente, created_at FROM leads ORDER BY created_at DESC LIMIT 500'
  ).all();

  const rows = results || [];
  const total = rows.length;
  const fuentes = rows.reduce((acc, r) => {
    acc[r.fuente] = (acc[r.fuente] || 0) + 1;
    return acc;
  }, {});

  const tableRows = rows.map(r => `
    <tr>
      <td>${esc(r.id)}</td>
      <td>${esc(r.nombre)}</td>
      <td><a href="https://wa.me/${esc(String(r.telefono || '').replace(/\D/g, ''))}" target="_blank">${esc(r.telefono)}</a></td>
      <td><span class="badge ${esc(r.fuente)}">${esc(r.fuente)}</span></td>
      <td>${r.created_at ? esc(new Date(r.created_at).toLocaleString('es-CR')) : '—'}</td>
    </tr>`).join('');

  const fuenteBadges = Object.entries(fuentes).map(([k, v]) =>
    `<div class="stat-card"><div class="stat-num">${esc(v)}</div><div class="stat-lbl">${esc(k)}</div></div>`
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin — Caoba Quintas</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0ebe4;color:#2c1a0e;min-height:100vh}
  header{background:#3D2418;color:#F5EFE6;padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:18px;font-weight:700;letter-spacing:.02em}
  header small{font-size:12px;opacity:.65}
  .container{max-width:1100px;margin:0 auto;padding:32px 24px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-bottom:32px}
  .stat-card{background:white;border-radius:12px;padding:20px 16px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  .stat-card.total .stat-num{color:#3D2418}
  .stat-num{font-size:32px;font-weight:700;line-height:1}
  .stat-lbl{font-size:12px;color:#888;margin-top:6px;text-transform:capitalize}
  .toolbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
  .toolbar input{flex:1;min-width:180px;height:38px;border:1.5px solid #ddd;border-radius:8px;padding:0 12px;font-size:13px;outline:none}
  .toolbar input:focus{border-color:#6B3D28}
  .btn{height:38px;padding:0 16px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
  .btn-primary{background:#E87D3E;color:white}
  .btn-primary:hover{background:#d06b2e}
  .btn-outline{background:white;color:#3D2418;border:1.5px solid #ddd}
  .btn-outline:hover{border-color:#6B3D28}
  .table-wrap{background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#3D2418;color:#F5EFE6;padding:12px 14px;text-align:left;font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  td{padding:11px 14px;border-bottom:1px solid #f0ede8;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#faf7f3}
  td a{color:#6B3D28;text-decoration:none;font-weight:500}
  td a:hover{text-decoration:underline}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  .badge.hero{background:#e8f4e8;color:#2D4A3E}
  .badge.lotes{background:#fff3e8;color:#8B5A3C}
  .badge.contacto{background:#e8eef8;color:#2d4870}
  .badge.cta{background:#f8f0e8;color:#6B3D28}
  .count-info{font-size:13px;color:#888;margin-bottom:8px}
  @media(max-width:600px){th:nth-child(1),td:nth-child(1){display:none}.container{padding:16px}}
</style>
</head>
<body>
<header>
  <h1>Caoba Quintas — Panel de Leads</h1>
  <small>caobaquintas.com</small>
</header>
<div class="container">
  <div class="stats">
    <div class="stat-card total"><div class="stat-num">${total}</div><div class="stat-lbl">Total leads</div></div>
    ${fuenteBadges}
  </div>
  <div class="toolbar">
    <input type="search" id="q" placeholder="Buscar por nombre o teléfono…" oninput="filtrar()"/>
    <a class="btn btn-outline" href="/api/admin/leads.csv" download="leads-caoba.csv">⬇ Exportar CSV</a>
    <a class="btn btn-primary" href="https://wa.me/50661541764" target="_blank">WhatsApp</a>
  </div>
  <div class="count-info" id="count-info">${total} leads</div>
  <div class="table-wrap">
    <table id="leads-table">
      <thead><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Fuente</th><th>Fecha</th></tr></thead>
      <tbody id="tbody">${tableRows}</tbody>
    </table>
  </div>
</div>
<script>
function filtrar(){
  const q=(document.getElementById('q').value||'').toLowerCase();
  const rows=document.querySelectorAll('#tbody tr');
  let vis=0;
  rows.forEach(r=>{
    const txt=r.textContent.toLowerCase();
    const show=!q||txt.includes(q);
    r.style.display=show?'':'none';
    if(show)vis++;
  });
  document.getElementById('count-info').textContent=vis+' leads'+(q?' (filtrados)':'');
}
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  });
}

/* ── Admin API: leads JSON / CSV ─────────────────────────────── */
async function handleAdminLeads(request, env, format) {
  const denied = adminGuard(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    'SELECT id, nombre, telefono, fuente, created_at FROM leads ORDER BY created_at DESC'
  ).all();

  const rows = results || [];

  if (format === 'csv') {
    const lines = ['id,nombre,telefono,fuente,fecha'];
    rows.forEach(r => {
      lines.push([r.id, csvEsc(r.nombre), csvEsc(r.telefono), csvEsc(r.fuente), r.created_at || ''].join(','));
    });
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': 'attachment; filename="leads-caoba.csv"',
      },
    });
  }

  return new Response(JSON.stringify(rows), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ── Lead submission ─────────────────────────────────────────── */
async function handleLead(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ error: 'JSON inválido' }, 400);
  }

  const nombre = (body.nombre || '').trim();
  const telefono = (body.telefono || '').trim();
  const fuente = (body.fuente || 'hero').trim();

  if (!nombre || !telefono) {
    return corsResponse({ error: 'nombre y telefono son requeridos' }, 400);
  }
  if (nombre.length > MAX_CAMPO || telefono.length > MAX_CAMPO) {
    return corsResponse({ error: `nombre y telefono admiten hasta ${MAX_CAMPO} caracteres` }, 400);
  }
  if (!fuenteValida(fuente)) {
    return corsResponse({ error: 'fuente inválida' }, 400);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO leads (nombre, telefono, fuente) VALUES (?, ?, ?)'
    ).bind(nombre, telefono, fuente).run();
  } catch (err) {
    console.error('D1 error:', err);
    return corsResponse({ error: 'Error guardando lead' }, 500);
  }

  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
    await sendEmail(env, nombre, telefono, fuente).catch(e =>
      console.error('Email error:', e)
    );
  }

  return corsResponse({ ok: true }, 201);
}

async function sendEmail(env, nombre, telefono, fuente) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'leads@caobaquintas.com',
      to: env.NOTIFY_EMAIL,
      subject: `Nuevo lead — ${nombre}`,
      html: `<p><strong>Nombre:</strong> ${esc(nombre)}</p>
             <p><strong>Teléfono:</strong> ${esc(telefono)}</p>
             <p><strong>Fuente:</strong> ${esc(fuente)}</p>`,
    }),
  });
}

/* ── Helpers ─────────────────────────────────────────────────── */
// Fuentes que envía el sitio: formulario del hero, CTA final y CTA con lote
// elegido (`lote_<nombre-del-lote>`, ver public/index.html).
const MAX_CAMPO = 120;

const FUENTES = new Set(['hero', 'cta_final']);
const FUENTE_LOTE = /^lote_[a-z0-9-]{1,32}$/;

function fuenteValida(fuente) {
  return FUENTES.has(fuente) || FUENTE_LOTE.test(fuente);
}

function corsResponse(body, status) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function csvEsc(s) {
  const str = String(s || '');
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"` : str;
}
