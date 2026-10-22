/* ── Núcleo puro del bot (sin I/O, sin env, sin Date.now, sin SQL/fetch) ──
 * decide(session, msg, config, nowMs) -> { reply, effects }
 * Los efectos son datos; el caller los aplica SOLO tras un envío exitoso. */

export const MSG = {
  WELCOME: `¡Hola! 🌿 Soy el asistente de *Caoba Quintas*.
Para coordinar tu visita necesito algunos datos rápidos.
¿Cuál es tu nombre completo?`,
  FALLBACK: `No entendí tu mensaje. Si deseas información sobre Caoba Quintas, escribe *info* para comenzar.`,
  ASK_CEDULA: nombre => `Gracias, ${nombre}. ¿Cuál es tu número de cédula?`,
  RETRY_NOMBRE: `No alcancé a leer tu nombre. ¿Me lo compartes, por favor?`,
  ASK_DISP: `Perfecto. ¿Cuándo estarías disponible para que te llamemos?
(Ej: lunes en la tarde, martes a cualquier hora)`,
  RETRY_CEDULA: `Necesito un número de cédula válido para continuar. ¿Me lo compartes?`,
  RETRY_DISP: `¿Cuándo estarías disponible para que te llamemos? (Ej: lunes en la tarde)`,
  DONE: `¡Excelente! Tu información fue recibida. ✅
Un asesor de *Caoba Quintas* te contactará pronto. ¡Gracias!`,
  ALREADY: `Tu información ya está registrada con nosotros. 😊
Un asesor se pondrá en contacto contigo pronto.`,
  ADVISOR: ({ nombre, cedula, disponibilidad, phone }) =>
    `🌿 *Cliente Caoba*\n` +
    `Nombre: ${nombre || '(no indicado)'}\n` +
    `Cédula: ${cedula || '(no indicada)'}\n` +
    `Disponibilidad: ${disponibilidad}\n` +
    `Número: ${phone}`,
};

export function decide(session, msg, config, nowMs) {
  const text = msg.text || '';

  // Sin sesión activa: requiere la palabra clave para arrancar.
  if (!session || session.step === 0) {
    if (matchesTrigger(text, config.trigger)) {
      return { reply: MSG.WELCOME, effects: [{ type: 'saveSession', patch: { step: 1 } }] };
    }
    return { reply: MSG.FALLBACK, effects: [] };
  }

  // Sesión completada: re-engagement solo si expiró el TTL y vuelve la palabra clave.
  if (session.step === 4) {
    const expired = session.completedAt != null && (nowMs - session.completedAt) > config.ttlMs;
    if (expired && matchesTrigger(text, config.trigger)) {
      return {
        reply: MSG.WELCOME,
        effects: [{
          type: 'saveSession',
          patch: { step: 1, nombre: null, cedula: null, disponibilidad: null, completedAt: null },
        }],
      };
    }
    return { reply: MSG.ALREADY, effects: [] };
  }

  // Paso 1: capturar nombre.
  if (session.step === 1) {
    const nombre = text.trim();
    if (!nombre) return { reply: MSG.RETRY_NOMBRE, effects: [] };
    return {
      reply: MSG.ASK_CEDULA(nombre),
      effects: [{ type: 'saveSession', patch: { step: 2, nombre } }],
    };
  }

  // Paso 2: capturar cédula (no vacía y con al menos un dígito).
  if (session.step === 2) {
    const cedula = text.trim();
    if (!cedula || !/\d/.test(cedula)) return { reply: MSG.RETRY_CEDULA, effects: [] };
    return {
      reply: MSG.ASK_DISP,
      effects: [{ type: 'saveSession', patch: { step: 3, cedula } }],
    };
  }

  // Paso 3: capturar disponibilidad → completar, registrar lead y notificar.
  if (session.step === 3) {
    const disponibilidad = text.trim();
    if (!disponibilidad) return { reply: MSG.RETRY_DISP, effects: [] };
    return {
      reply: MSG.DONE,
      effects: [
        { type: 'saveSession', patch: { step: 4, disponibilidad, completedAt: nowMs } },
        { type: 'insertLead', lead: { nombre: session.nombre || 'Bot WA', phone: msg.phone, fuente: 'wa_bot' } },
        { type: 'notifyAdvisor', summary: MSG.ADVISOR({ nombre: session.nombre, cedula: session.cedula, disponibilidad, phone: msg.phone }) },
      ],
    };
  }

  return { reply: null, effects: [] };
}

/* ── Servicio de aplicación: orquesta una conversación completa ──────────
 * Posee el invariante: enviar la respuesta PRIMERO; solo tras un envío
 * exitoso aplica los efectos (avance de estado, lead, notificación). Si el
 * envío falla, libera la marca de dedup para que el proveedor reintente sin
 * doble-avance. No hace I/O directo: todo pasa por puertos inyectados.
 *
 * @param {{phone,text,messageId}} msg
 * @param {{ config, clock, sessions, sender, dedup, applyEffect }} deps
 * @returns {Promise<{status:'ok'|'duplicate'|'send_failed', reply?:string|null}>}
 */
export async function runEngine(msg, deps) {
  const { config, clock, sessions, sender, dedup, applyEffect } = deps;

  // 1. Idempotencia: reclamar el messageId (no-op si viene null).
  if (msg.messageId && !(await dedup.claim(msg.messageId, msg.phone))) {
    return { status: 'duplicate' };
  }

  // 2. Cargar estado y decidir (puro).
  let decision;
  try {
    const session = await sessions.get(msg.phone);
    decision = decide(session, msg, config, clock.now());
  } catch (err) {
    await dedup.release(msg.messageId);
    throw err;
  }

  // 3. Enviar la respuesta PRIMERO.
  if (decision.reply) {
    try {
      await sender.send(msg.phone, decision.reply);
    } catch (err) {
      await dedup.release(msg.messageId); // permitir reintento del proveedor
      return { status: 'send_failed' };
    }
  }

  // 4. Solo ahora: aplicar efectos en el orden declarado (best-effort).
  //    Si falla saveSession se omiten los siguientes: dependen de que el paso
  //    haya avanzado y, si no, el próximo mensaje repetiría el lead y el aviso.
  for (const effect of decision.effects) {
    try {
      await applyEffect(effect, msg.phone);
    } catch (err) {
      console.error('runEngine effect failed:', effect.type, err);
      if (effect.type === 'saveSession') break;
    }
  }

  return { status: 'ok', reply: decision.reply };
}

// Coincide solo si la palabra clave aparece como token completo (no subcadena).
export function matchesTrigger(text, trigger) {
  const tokens = (text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.includes(trigger);
}
