/* ── Núcleo de conversación (puro + servicio, testeable) ─────── */
import { runEngine } from './engine.js';

/* ── Router principal ────────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/webhook/wa/health') {
      return json({ ok: true });
    }

    // Meta Cloud API: verificación de webhook (GET con hub.challenge)
    if (url.pathname === '/webhook/wa' && request.method === 'GET') {
      return handleMetaVerify(url, env);
    }

    if (url.pathname === '/webhook/wa' && request.method === 'POST') {
      return handleIncoming(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

/* ── Verificación de webhook Meta ────────────────────────────── */
function handleMetaVerify(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  // Token dedicado de verificación (NO reutilizar WA_API_TOKEN, que es la
  // credencial de la API). Si no está configurado, rechazar (fail-closed).
  const expected = env.WA_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

/* ── Autenticación del webhook entrante (POST) ───────────────── */
// Devuelve true si la petición es legítima. Meta: firma HMAC X-Hub-Signature-256
// sobre el cuerpo crudo con WA_APP_SECRET. Otros proveedores: secreto compartido
// en header `x-webhook-secret` contra WA_WEBHOOK_SECRET. Si falta el secreto del
// proveedor, rechaza (falla cerrado). No se acepta el secreto en la query: las
// URLs quedan en los logs.
async function verifyWebhook(request, rawBody, url, env) {
  const provider = env.WA_PROVIDER || '';

  if (provider === 'meta') {
    const secret = env.WA_APP_SECRET;
    if (!secret) {
      console.error('WA_APP_SECRET no configurado: webhook Meta rechazado.');
      return false;
    }
    const header = request.headers.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + (await hmacSha256Hex(secret, rawBody));
    return timingSafeEqual(header, expected);
  }

  const secret = env.WA_WEBHOOK_SECRET;
  if (!secret) {
    console.error('WA_WEBHOOK_SECRET no configurado: webhook rechazado.');
    return false;
  }
  const provided = request.headers.get('x-webhook-secret') || '';
  return timingSafeEqual(provided, secret);
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Comparación en tiempo constante para evitar fugas por timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── Procesador de mensajes entrantes ────────────────────────── */
async function handleIncoming(request, env) {
  const url = new URL(request.url);
  // Leer el cuerpo crudo (necesario para verificar la firma HMAC de Meta).
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (!(await verifyWebhook(request, rawBody, url, env))) {
    return new Response('Forbidden', { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const msg = parseIncoming(payload, env.WA_PROVIDER);
  if (!msg) return new Response('OK', { status: 200 });

  // Construir adaptadores desde env e invocar el servicio de conversación.
  // El invariante enviar→commit y el release-on-failure viven en runEngine.
  let result;
  try {
    result = await runEngine(msg, makeDeps(env));
  } catch (err) {
    console.error('Bot error:', err);
    return new Response('Error', { status: 500 });
  }

  if (result.status === 'duplicate') return new Response('OK', { status: 200 });
  if (result.status === 'send_failed') return new Response('Error', { status: 500 });
  // También devolver en body para EvolutionBot por si lo usa.
  if (result.reply) return json({ data: { message: result.reply } });
  return new Response('OK', { status: 200 });
}

/* ── Adaptadores: conectan los puertos del motor con D1 y WhatsApp ─── */
function makeDeps(env) {
  const db = env.DB;
  return {
    config: {
      trigger: (env.WA_TRIGGER || 'info').toLowerCase(),
      ttlMs: parseInt(env.SESSION_TTL_DAYS || '30', 10) * 86400 * 1000,
    },
    clock: { now: () => Date.now() },
    sessions: {
      get: async phone => {
        const row = await getSession(db, phone);
        if (!row) return null;
        return {
          step: row.step,
          nombre: row.nombre,
          cedula: row.cedula,
          disponibilidad: row.disponibilidad,
          // El motor razona el TTL en epoch ms; la columna guarda ISO.
          completedAt: row.completed_at ? Date.parse(row.completed_at) : null,
        };
      },
    },
    sender: { send: (to, text) => sendTextDirect(to, text, env) },
    dedup: {
      claim: async (messageId, phone) => {
        let claimed = true;
        try {
          const res = await db.prepare(
            'INSERT OR IGNORE INTO wa_inbound (message_id, phone) VALUES (?, ?)'
          ).bind(messageId, phone).run();
          claimed = res.meta.changes !== 0;
        } catch (err) {
          console.error('Dedup error:', err);
        }
        // Limpieza oportunista de filas viejas (la tabla no crece sin límite).
        if (Math.random() < 0.02) {
          try {
            await db.prepare(
              "DELETE FROM wa_inbound WHERE received_at < datetime('now', '-7 days')"
            ).run();
          } catch (err) {
            console.error('Dedup cleanup error:', err);
          }
        }
        return claimed;
      },
      release: async messageId => {
        if (!messageId) return;
        try {
          await db.prepare('DELETE FROM wa_inbound WHERE message_id = ?').bind(messageId).run();
        } catch (err) {
          console.error('Dedup rollback error:', err);
        }
      },
    },
    applyEffect: async (effect, phone) => {
      if (effect.type === 'saveSession') {
        await upsertSession(db, phone, patchToColumns(effect.patch));
      } else if (effect.type === 'insertLead') {
        try {
          await db.prepare(
            'INSERT INTO leads (nombre, telefono, fuente) VALUES (?, ?, ?)'
          ).bind(effect.lead.nombre, effect.lead.phone, effect.lead.fuente).run();
        } catch (err) {
          console.error('D1 leads insert error:', err);
        }
      } else if (effect.type === 'notifyAdvisor') {
        // Notificación al asesor: número distinto al cliente, best-effort.
        // Se espera el envío: una promesa suelta puede cancelarse al devolver la Response.
        if (env.NOTIFY_WA_NUM) {
          await sendTextDirect(env.NOTIFY_WA_NUM, effect.summary, env).catch(e =>
            console.error('Notify send error:', e)
          );
        }
      }
    },
  };
}

// Mapea el patch del motor (completedAt en epoch ms) a columnas de wa_sessions
// (completed_at en ISO), preservando qué columnas están presentes.
function patchToColumns(patch) {
  const cols = {};
  if ('step' in patch) cols.step = patch.step;
  if ('nombre' in patch) cols.nombre = patch.nombre;
  if ('cedula' in patch) cols.cedula = patch.cedula;
  if ('disponibilidad' in patch) cols.disponibilidad = patch.disponibilidad;
  if ('completedAt' in patch) {
    cols.completed_at = patch.completedAt == null ? null : new Date(patch.completedAt).toISOString();
  }
  return cols;
}

/* ── D1 helpers ──────────────────────────────────────────────── */
async function getSession(db, phone) {
  const row = await db.prepare('SELECT * FROM wa_sessions WHERE phone = ?').bind(phone).first();
  return row || null;
}

// UPSERT atómico (un solo statement): evita el race read-modify-write entre
// mensajes concurrentes del mismo número. Solo actualiza las columnas presentes
// en `fields`; las no indicadas se preservan en la fila existente.
async function upsertSession(db, phone, fields) {
  const now = new Date().toISOString();
  const cols = ['step', 'nombre', 'cedula', 'disponibilidad', 'completed_at'];
  const provided = cols.filter(c => Object.prototype.hasOwnProperty.call(fields, c));
  const setClauses = provided.map(c => `${c}=excluded.${c}`);
  setClauses.push('updated_at=excluded.updated_at');

  await db.prepare(
    `INSERT INTO wa_sessions (phone, step, nombre, cedula, disponibilidad, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET ${setClauses.join(', ')}`
  ).bind(
    phone,
    fields.step ?? 0,
    fields.nombre ?? null,
    fields.cedula ?? null,
    fields.disponibilidad ?? null,
    now,
    fields.completed_at ?? null
  ).run();
}

/* ── Envío directo vía API (solo para notificación al asesor) ── */
async function sendTextDirect(to, text, env) {
  const provider = env.WA_PROVIDER || '';
  if (provider === 'evolution') {
    const url = `${env.WA_API_URL}/message/sendText/${env.WA_INSTANCE}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': env.WA_API_TOKEN },
      body: JSON.stringify({ number: to, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Evolution sendText error:', res.status, body);
      throw new Error(`Evolution sendText failed: ${res.status}`);
    }
  } else if (provider === 'meta') {
    const url = `https://graph.facebook.com/v19.0/${env.WA_PHONE_ID}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.WA_API_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Meta sendText error:', res.status, body);
      throw new Error(`Meta sendText failed: ${res.status}`);
    }
  }
}

/* ── Parsers de payload entrante ─────────────────────────────── */
function parseIncoming(payload, provider) {
  if (provider === 'meta') return parseMeta(payload);
  return parseEvolution(payload);
}

function parseEvolution(payload) {
  try {
    // Formato Dify (EvolutionBot): {query, user, conversation_id, inputs, files}
    if (payload.query !== undefined && payload.user !== undefined) {
      const phone = (payload.user || '').replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
      const text = payload.query || '';
      // OJO: conversation_id es constante en toda la conversación, NO por mensaje.
      // Usarlo como messageId haría que el dedup descarte todos los mensajes salvo
      // el primero. Este formato no trae un ID por mensaje, así que no deduplicamos.
      const messageId = null;
      if (!phone || !text) return null;
      return { phone, text, messageId };
    }

    // Formato messages.upsert (webhook regular): {event, data:{key, message}}
    if (payload.data && typeof payload.data === 'object') {
      const data = payload.data;
      const key = data.key || {};
      const msg = data.message || {};
      if (key.fromMe) return null;
      const remoteJid = key.remoteJid || data.remoteJid;
      const messageId = key.id;
      const text = msg.conversation || msg.extendedTextMessage?.text || '';
      const phone = (remoteJid || '').replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
      if (!phone || !text) return null;
      return { phone, text, messageId: messageId || null };
    }

    // Formato plano
    const fromMe = payload.fromMe ?? false;
    if (fromMe) return null;
    const remoteJid = payload.remoteJid || payload.number;
    const messageId = payload.messageId;
    const text = payload.text || payload.message || '';
    const phone = (remoteJid || '').replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
    if (!phone || !text) return null;
    return { phone, text, messageId: messageId || null };
  } catch {
    return null;
  }
}

function parseMeta(payload) {
  try {
    const change = payload?.entry?.[0]?.changes?.[0]?.value;
    if (!change?.messages) return null;
    const msg = change.messages[0];
    if (msg.type !== 'text') return null;
    return { phone: msg.from, text: msg.text?.body || '', messageId: msg.id || null };
  } catch {
    return null;
  }
}

/* ── Util ────────────────────────────────────────────────────── */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
