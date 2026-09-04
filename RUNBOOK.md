# RUNBOOK — caoba (Caoba Quintas)

> Última actualización: 2026-09-04 · Dueño: por definir · Repo: `Dmr343/caoba-quintas-landing`
> Cómo mantener: actualizar este archivo en el MISMO PR que cambie infraestructura.

## 1. Qué es / resumen operativo

caobaquintas.com — landing de venta de lotes + captura de leads + bot de WhatsApp. Tres unidades
desplegables independientes que comparten una única D1.

## 2. Arquitectura y servicios

| Servicio | Detalle |
|---|---|
| Sitio estático | Cloudflare Pages, proyecto `caoba-quintas`, sirve `public/` |
| Worker API | `caoba-leads` — captura de leads, panel admin en `/api/admin` |
| Worker bot | `caoba-bot` — bot de WhatsApp |
| Base de datos | Cloudflare D1 `caoba-leads` (`database_id = 9a64e966-57d7-4bc2-a281-6fb103253a16`), compartida por ambos workers. Tablas propias del bot: `wa_sessions`, `wa_inbound` |
| Dominio | `caobaquintas.com` + `www.caobaquintas.com` (CNAME → `caoba-quintas.pages.dev`, proxied). Zona `be84e67bc1d903c4af2745d921fae940` |
| Routes | `caoba-leads`: `caobaquintas.com/api/*` · `caoba-bot`: `caobaquintas.com/webhook/wa*` |
| Cuenta Cloudflare | `berrocal.dbp@gmail.com` (account_id `b910323a680984cdf79e11913711dffc`) |
| Correos | `udmr343@gmail.com` (NOTIFY_EMAIL, notificación de leads) · `leads@caobaquintas.com` (sender Resend) · `info@caobaquintas.com` (contacto público) |
| WhatsApp | Evolution API instancia `caoba` en `https://bot-whatsapp-evolution-api.r4gls5.easypanel.host` (EasyPanel); relacionado: bot Flask de cobros `https://bot-cobros-caoba.pujolbadi.com` |

## 3. Requisitos previos

- Node + `npx wrangler` (login con la cuenta Cloudflare de arriba).
- Acceso al repo `Dmr343/caoba-quintas-landing` (privado).
- Secretos — **no viven aquí, solo se listan los nombres**:
  - Local (gitignored): `secrets/credenciales_caoba.md` — Cloudflare, D1, Worker Secrets, Resend,
    panel admin, GitHub, dominios, deploy, Evolution API, teléfonos del proyecto.
    **⚠️ Este archivo guarda valores en texto plano — ver riesgo en sección 11.**
  - Worker `caoba-leads`: `RESEND_API_KEY`.
  - Worker `caoba-bot`: `WA_PROVIDER`, `WA_API_URL`, `WA_API_TOKEN`, `WA_INSTANCE`, `WA_PHONE_ID`,
    `BOT_WA_NUM`, `NOTIFY_WA_NUM`, `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_WEBHOOK_SECRET`.
  - **Pendiente**: no hay gestor de secretos compartido; ver nota en Notion "Documentación Técnica → Por confirmar".

## 4. Desarrollo local

`npx wrangler pages dev public` para el sitio. Para los workers: `npx wrangler dev --config
config/wrangler.toml` (leads) / `config/wrangler.bot.toml` (bot).

## 5. Deploy

```bash
# Sitio — auto-deploy vía GitHub Actions en push a main (no manual normalmente)
npx wrangler pages deploy public --project-name caoba-quintas

# Worker de leads
npx wrangler deploy --config config/wrangler.toml

# Worker de bot WhatsApp
npx wrangler deploy --config config/wrangler.bot.toml
```

CI: `.github/workflows/deploy-pages.yml` (solo el sitio estático, auto en push a `main`). Los
workers se despliegan manualmente — no hay workflow de CI para ellos.

## 6. Rollback

`npx wrangler pages deployment list --project-name caoba-quintas` + rollback desde dashboard.
Para workers: `npx wrangler deployments list --name caoba-leads` (o `caoba-bot`) + `wrangler rollback`.

## 7. Rotar secretos / credenciales

```bash
npx wrangler secret put RESEND_API_KEY --config config/wrangler.toml
npx wrangler secret put WA_API_TOKEN --config config/wrangler.bot.toml
# repetir por cada secret listado en sección 3
```
Actualizar `secrets/credenciales_caoba.md` local tras cada rotación (no se versiona).

## 8. Logs y observabilidad

`npx wrangler tail caoba-leads` / `npx wrangler tail caoba-bot` para logs en vivo.

## 9. Base de datos

```bash
npx wrangler d1 execute caoba-leads --config config/wrangler.toml --command "SELECT * FROM leads LIMIT 10"
```
Migraciones en `migrations/`:
```bash
npx wrangler d1 execute caoba-leads --config config/wrangler.toml --file=migrations/<archivo>.sql
```

## 10. Cron / jobs / workflows

Ninguno. Sin cron triggers, KV ni R2 en ninguno de los dos workers.

## 11. Troubleshooting / fallos comunes

- **Riesgo de seguridad activo**: `secrets/credenciales_caoba.md` guarda valores reales en texto
  plano (Resend API key, token de WhatsApp, teléfonos). Tratar como sensible; no debe salir de la
  máquina local ni subirse a ningún sitio (ya está gitignored).
- **Bot de WhatsApp no responde**: verificar que la instancia Evolution API `caoba` esté arriba en
  EasyPanel (`bot-whatsapp-evolution-api.r4gls5.easypanel.host`).
- **Leads no llegan por email**: revisar `RESEND_API_KEY` y que `NOTIFY_EMAIL` (`udmr343@gmail.com`)
  siga siendo la dirección correcta.
- **Auto-deploy del sitio falla con `Authentication error [code: 10000]`**: el secret de GitHub
  Actions `CLOUDFLARE_API_TOKEN` (o `CLOUDFLARE_ACCOUNT_ID`) está vencido o le faltan permisos —
  ver blocker activo en sección 12. Verificar corridas: `gh run list --branch main`.

## 12. Migración en curso / blockers

**Auto-deploy del sitio roto desde 2026-07-26** (detectado 2026-09-04 al pushear el fix del mapa
de lotes — commit `eb3461c` sí llegó a `origin/main`, pero el workflow `Deploy a Cloudflare Pages`
falló). Último deploy exitoso: 2026-06-17. Causa: `Authentication error [code: 10000]` de la API de
Cloudflare — el secret `CLOUDFLARE_API_TOKEN` de GitHub Actions está vencido o sin los permisos de
Pages. `npx wrangler whoami` local tampoco está autenticado, así que no hay deploy manual de
respaldo disponible sin antes hacer login.

Para resolver:
1. Generar un token nuevo en el dashboard de Cloudflare (cuenta `berrocal.dbp@gmail.com`,
   account_id `b910323a680984cdf79e11913711dffc`) con permiso de edición sobre Pages.
2. Actualizar el secret `CLOUDFLARE_API_TOKEN` (y `CLOUDFLARE_ACCOUNT_ID` si hiciera falta) en
   GitHub → repo → Settings → Secrets and variables → Actions.
3. Re-correr el workflow fallido (`gh run rerun <id>`) o volver a pushear a `main`.

Repo reorganizado a `public/` / `config/` / `worker/` (ver BITACORA.md).

---
Fuentes: `config/wrangler.toml`, `config/wrangler.bot.toml`, `.github/workflows/deploy-pages.yml`,
`migrations/`, `BITACORA.md`, `secrets/credenciales_caoba.md` (solo nombres, no valores).
