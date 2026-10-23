/* ── D1 falsa en memoria para pruebas (no es un archivo *.test.js) ──
 * Registra cada sentencia preparada con sus parámetros y devuelve las filas
 * configuradas para los SELECT. Suficiente para probar los handlers. */
export function makeFakeDB({ rows = [], changes = 1, failOn = null } = {}) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args; return stmt; },
        async all() { calls.push({ sql, params }); return { results: rows }; },
        async first() { calls.push({ sql, params }); return rows[0] ?? null; },
        async run() {
          calls.push({ sql, params });
          if (failOn && failOn.test(sql)) throw new Error('D1 falló');
          return { meta: { changes } };
        },
      };
      return stmt;
    },
  };
  return db;
}
