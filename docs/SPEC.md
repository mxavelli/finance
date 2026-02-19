# SPEC — Sistema de Finanzas Personales

> Documento vivo. Fuente de verdad para todas las definiciones técnicas del proyecto.

## Estado del proyecto

| Fase | Estado | Descripción |
|------|--------|-------------|
| 1. Diseño Google Sheet | ✅ Completa | Estructura, fórmulas, validaciones |
| 2. Setup proyecto Node.js | ✅ Completa | grammY + googleapis + dotenv, estructura en bot/ |
| 3. Parser lenguaje natural | ✅ Completa | Interpretar mensajes de texto |
| 4. Integración Google Sheets API | ✅ Completa | Conexión bot ↔ Sheet |
| 5. Flujo completo del bot | ✅ Completa | Consultas, borrado, ingresos automáticos |
| 6. Dashboard y reportes | ✅ Completa | Fórmulas Dashboard, flujo financiero, resumen anual |
| 7. Refinamiento | ⏳ En progreso | /tarjeta, /registrar_fijos, recordatorio gastos fijos, auto-fijos, alertas presupuesto, resumen semanal |
| 8. Dashboard Streamlit | ⏳ En progreso | Visualización de datos mobile-friendly |

---

## Contexto personal

- **Usuario**: Moises, vive en Buenos Aires con Oriana
- **Trabajo**: Implementation Manager, cobra en USD vía Deel
- **Monedas**: USD (Deel) y ARS (banco argentino)

## Flujo de dinero

El salario llega en USD a Deel y se distribuye en 3 bolsillos:

1. **Deel USD** — Ahorro/reserva en dólares
2. **Deel Card (ARS)** — Tarjeta que convierte USD→ARS al momento de compra
3. **Banco ARS** — Cuenta bancaria en pesos

## Gastos

- **Individual Moises** — Gastos personales de Moises
- **Individual Oriana** — Gastos personales de Oriana
- **Compartido** — Gastos de ambos (alquiler, super, salidas, servicios)
- Los splits son solo entre Moises y Oriana (no multi-persona)
- Split default compartido: 50/50, configurable por transacción

---

## Decisiones de diseño

| Decisión | Definición | Fecha |
|----------|-----------|-------|
| Deel Card tracking | Solo monto ARS pagado. No se trackea el USD descontado ni tipo de cambio por transacción | 2026-02-17 |
| Presupuestos | Separados por moneda: ARS y USD | 2026-02-17 |
| Splits | Solo entre Moises y Oriana, no multi-persona | 2026-02-17 |
| Ingresos Oriana | Se trackean en el mismo Sheet (sección separada en hoja Ingresos) | 2026-02-17 |
| Fórmulas | SUMIFS con columnas helper (ARRAYFORMULA) en vez de SUMPRODUCT por performance | 2026-02-17 |
| MAX_TX | 200 filas máximas en Transacciones (por límite de tiempo Apps Script, ampliable desde el bot) | 2026-02-17 |
| Named Ranges | Diferidos a Fase 4 (removidos del setup.js por timeout) | 2026-02-17 |
| Setup split | Script dividido en setupParte1() a setupParte4() por límite de 6 min | 2026-02-17 |
| Locale fórmulas | Fórmulas usan `;` como separador (locale argentino). Helper `loc()` convierte de notación US | 2026-02-17 |
| Dashboard fórmulas | Diferidas a Fase 4 — Apps Script no puede escribir más fórmulas al documento sobrecargado. Se agregan vía Sheets API | 2026-02-17 |
| Telegram lib | grammY — moderna, TypeScript-first, mejor DX, middleware system | 2026-02-17 |
| Lenguaje bot | JavaScript puro (sin TypeScript) — simple, sin build step | 2026-02-17 |
| Google Sheets lib | googleapis directo (no google-spreadsheet wrapper) — más control para operaciones de bajo nivel en Fase 4 | 2026-02-17 |
| Credenciales Google | Env vars individuales (EMAIL + PRIVATE_KEY), no archivo JSON — deploy-friendly | 2026-02-17 |
| Bot Telegram | Nombre: PlataBot, username: @MiPlataRegistradaBot | 2026-02-18 |
| Ubicación .env | En la raíz del proyecto (no en bot/), config.js apunta a `../../.env` | 2026-02-18 |
| Método "Tarjeta" | Nuevo método de pago: tarjeta de crédito argentina, moneda ARS | 2026-02-18 |
| Método default | Si no se especifica método de pago, default: Tarjeta (ARS) | 2026-02-18 |
| Ambos usuarios | Moises y Oriana usan el bot desde su propio Telegram. Detección por user ID | 2026-02-18 |
| Confirmación | Siempre preview con botones inline (✅/❌) antes de guardar | 2026-02-18 |
| Keywords dinámicas | Parser carga keywords desde la hoja Categorías del Sheet, no hardcodeadas | 2026-02-18 |
| Pending TX en memoria | Map con TTL de 10 min (callback_data de Telegram tiene límite de 64 bytes) | 2026-02-18 |
| Guardado en filas pre-formateadas | `update` a fila vacía, no `append` con `INSERT_ROWS` (que rompe formatos de fecha/hora) | 2026-02-18 |
| Frases multi-palabra pago | "tarjeta de credito", "deel usd", "deel card" se detectan como frases antes de single-word | 2026-02-18 |
| Named Ranges | Creados vía Sheets API en setupPhase4(): Transacciones\_Datos, \_Fecha, \_Monto, etc. | 2026-02-18 |
| Dropdown actualizado | "Tarjeta" agregado al dropdown de método de pago en Transacciones y Gastos Fijos | 2026-02-18 |
| Borrado transacciones | Muestra últimas 5, usuario elige cuál borrar. Limpia A-L (preserva fórmulas M-P) | 2026-02-18 |
| Ingresos automáticos | Recordatorio texto al iniciar si el mes no tiene ingresos. Avisa de usar /cotizacion | 2026-02-18 |
| Ingresos extras | /ingreso suma al monto existente del mes. Moises=USD, Oriana=ARS por sender ID | 2026-02-18 |
| Cotización mensual | /cotizacion [tc] calcula USD a cambiar para ambos (redondeado ↑50), queda en Deel, extra USD. Registra todo en Ingresos | 2026-02-18 |
| Salario ARS fijo | Ambos tienen salario fijo en ARS. La cantidad de USD a cambiar se calcula: SALARY_ARS / TC, redondeado al próximo múltiplo de 50 | 2026-02-18 |
| Extra USD cotización | La diferencia del redondeo de ambos (sumada) se registra como transacción compartida en Transacciones | 2026-02-18 |
| Env vars ingresos | MOISES_SALARY_USD, MOISES_SALARY_ARS, ORIANA_SALARY_USD, ORIANA_SALARY_ARS — opcionales | 2026-02-18 |
| Cotización duplicada | Si el mes ya tiene ingresos, muestra aviso y opción de actualizar. Actualización es retroactiva: borra extra anterior y reescribe datos | 2026-02-18 |
| Notificación cotización | Al confirmar cotización, el otro usuario recibe el mismo mensaje detallado | 2026-02-18 |
| Recordatorio a ambos | El recordatorio de ingresos al iniciar se envía a Moises y Oriana | 2026-02-18 |
| Recordatorio gastos fijos | Al iniciar, si hay gastos fijos pendientes, envía lista personalizada a cada usuario con botones. Moises ve sus individuales + compartidos, Oriana los suyos + compartidos. Re-check al confirmar para evitar duplicados en compartidos | 2026-02-18 |
| Tarjetas específicas | Reemplaza "Tarjeta" genérico por tarjetas con nombre: Moises (Visa Galicia, Master Galicia), Oriana (Visa BBVA, Master BBVA). Config en config.js | 2026-02-18 |
| Selección de tarjeta UX | Botones inline después de escribir el gasto. Tocar tarjeta = confirma + setea método. No keywords en mensaje | 2026-02-18 |
| Gastos fijos con tarjeta | Al registrar batch, usa primera tarjeta del usuario como default si el método es "Tarjeta" genérico | 2026-02-18 |
| Datos legacy "Tarjeta" | Transacciones existentes con "Tarjeta" se mantienen. isTarjeta() y fórmulas incluyen el valor legacy | 2026-02-18 |
| Estilos profesionales | Todas las hojas con formato profesional: paleta azul/verde/rojo/dorado, headers con color, filas alternadas, tab colors. Función setupEstilos() en sheets.js | 2026-02-18 |
| Cuotas de tarjeta | Hoja separada "Cuotas" con tracking. Se registran como transacción mensual vía /registrar\_fijos. Cuota = total/N (sin interés default), ajustable post-registro | 2026-02-18 |
| Primera cuota cálculo | Si compra <= cierre o cierre no configurado → mes siguiente. Si compra > cierre → mes+2. Cierre configurable por tarjeta via env vars | 2026-02-18 |
| Cuotas integradas con fijos | /registrar\_fijos muestra gastos fijos + cuotas pendientes en una sola lista. Mismos botones de Registrar/Editar/Cancelar | 2026-02-18 |
| Rangos sin límite fijo | Lecturas de Gastos Fijos y Cuotas usan rangos abiertos (`A2:H`, `A2:M`). Fórmulas y validaciones cubren hasta fila 101 (100 items). Función `extendSheetLimits()` para re-expandir si hace falta | 2026-02-18 |
| Dashboard Streamlit | Single-page app con sidebar navigation. Plotly Express para gráficos touch-friendly. gspread con scope read-only. Cache 5 min con botón manual de refresh. Deploy en Streamlit Community Cloud | 2026-02-18 |
| Deploy Bot | Railway con long polling, restart on failure, graceful shutdown (SIGTERM) | 2026-02-18 |
| Parsing locale montos | `parseLocalNumber()` en sheets.js maneja formatos argentinos: "15.000" (punto=miles), "15.000,50", "$15.000". Usado en getGastosFijos() | 2026-02-18 |
| Filtro por usuario robusto | `filterGastosForUser()` y `filterCuotasForUser()` usan comparación case-insensitive con `includes('moises')`/`includes('oriana')`. Items sin tipo o con tipo desconocido → visibles para ambos | 2026-02-18 |
| Auto-fijos diario | Cron 9:00 AM BA: revisa gastos fijos + cuotas del día, manda preview con botones a cada usuario. Mismo mecanismo que /registrar\_fijos | 2026-02-19 |
| Alertas de presupuesto | Al registrar cada gasto, chequea si supera 80% o 100% del presupuesto. Mensaje 🟡/🔴 al usuario. Deduplicado por mes/categoría/umbral | 2026-02-19 |
| Resumen semanal | Cron lunes 9:00 AM BA: resumen compartido con totales, top categorías, balance, alertas presupuesto. Ambos usuarios reciben el mismo mensaje | 2026-02-19 |
| Scheduler separado | `scheduler.js` encapsula todos los cron jobs. Recibe contexto compartido para evitar dependencias circulares con index.js | 2026-02-19 |
| getPresupuestos() | Lee Presupuesto ARS (3 secciones) + USD (1 sección). Retorna Map con clave `"categoria\|tipo\|moneda"` → monto mensual | 2026-02-19 |

---

## Stack técnico

- **Bot**: Node.js + grammY (Telegram Bot framework)
- **Dashboard**: Streamlit + gspread + Plotly Express (Python)
- **Spreadsheet**: Google Sheets + Google Sheets API
- **Auth**: Google Service Account
- **Deploy Bot**: Railway (long polling 24/7)
- **Deploy Dashboard**: Streamlit Community Cloud (gratis)
- **Entorno**: VSCode + Claude Code

---

## Modelo de datos

### Transacciones (hoja principal)

| Columna | Campo | Tipo | Notas |
|---------|-------|------|-------|
| A | Fecha | DD/MM/YYYY | |
| B | Hora | HH:MM | |
| C | Descripción | Texto | Texto libre |
| D | Categoría | Dropdown | Referencia a hoja Categorías |
| E | Monto | Número | En la moneda indicada en F |
| F | Moneda | ARS / USD | Determinada por método de pago |
| G | Método de pago | Deel Card / Banco / Efectivo / Deel USD / Visa Galicia / Master Galicia / Visa BBVA / Master BBVA | Legacy: "Tarjeta" (pre-tarjetas específicas) |
| H | Tipo | Individual Moises / Individual Oriana / Compartido | |
| I | Pagado por | Moises / Oriana | Quién hizo el pago físico |
| J | Split Moises % | Número | Auto según tipo (100/0/50) |
| K | Split Oriana % | Número | Siempre = 100 - J |
| L | Notas | Texto | Opcional |
| M | Mes | Auto (ARRAYFORMULA) | Helper oculto |
| N | Año | Auto (ARRAYFORMULA) | Helper oculto |
| O | Monto Moises | Auto (E*J/100) | Helper oculto |
| P | Monto Oriana | Auto (E*K/100) | Helper oculto |

**Regla moneda ↔ método de pago:**
- Deel Card / Banco / Efectivo / Visa Galicia / Master Galicia / Visa BBVA / Master BBVA → ARS
- Deel USD → USD

### Categorías

| Categoría | Keywords (para el parser del bot) |
|-----------|----------------------------------|
| Alimentación | super, supermercado, mercado, comida, cena, almuerzo, desayuno, delivery, restaurante, café, bar, pedidosya, rappi |
| Transporte | uber, cabify, taxi, remis, nafta, combustible, peaje, estacionamiento, subte, colectivo, bondi |
| Entretenimiento | cine, teatro, salida, juego, gaming, streaming |
| Hogar | alquiler, expensas, luz, gas, agua, internet, wifi, limpieza, mueble, decoración |
| Salud | farmacia, médico, doctor, consulta, prepaga, obra social, medicamento |
| Suscripciones | spotify, netflix, youtube, hbo, disney, software, app, icloud, chatgpt |
| Ropa y personal | ropa, zapatillas, perfume, peluquería, barbería |
| Moto | seguro moto, patente moto, mecánico moto, casco, aceite moto |
| Educación | curso, libro, capacitación, udemy, platzi |
| Ahorro / Inversión | ahorro, inversión, plazo fijo, crypto, cedear |
| Otros | (default si no matchea nada) |

---

## Estructura del Google Sheet

### Hojas

1. **Dashboard** — Resumen visual con selectores de mes/año (fórmulas se agregan vía Sheets API en Fase 4)
2. **Transacciones** — Registro central (el bot escribe acá)
3. **Presupuesto ARS** — 3 secciones (Moises, Oriana, Compartido) con SUMIFS por mes
4. **Presupuesto USD** — 1 sección (Moises) con SUMIFS por mes
5. **Balance Compartido** — Quién pagó vs quién le corresponde, saldo acumulado
6. **Gastos Fijos** — Recurrentes con verificación automática (COUNTIFS)
7. **Ingresos** — Moises (USD + distribución) y Oriana (ARS)
8. **Categorías** — Referencia para dropdowns y keywords del bot
9. **Cuotas** — Compras en cuotas con tracking de cuotas registradas y estado

### Cuotas

| Columna | Campo | Notas |
|---------|-------|-------|
| A | Descripción | Nombre de la compra |
| B | Categoría | Dropdown |
| C | Monto Total | Precio total |
| D | Cuotas | Cantidad total de cuotas |
| E | Monto Cuota | Default C/D, editable para interés |
| F | Moneda | Siempre ARS |
| G | Tarjeta | Visa Galicia, Master Galicia, etc. |
| H | Tipo | Individual Moises / Individual Oriana / Compartido |
| I | Pagado por | Moises / Oriana |
| J | Fecha compra | DD/MM/YYYY |
| K | Primera cuota | MM/YYYY |
| L | Cuotas registradas | Número, empieza en 0, bot incrementa |
| M | Estado | Fórmula: Completada o Cuota X/Y |

### Presupuesto (ARS y USD)

Layout por sección:
- Columna A: Categoría
- Columna B: Presupuesto mensual (lo llena el usuario)
- Columnas C-N: Gastado por mes (Ene-Dic, fórmulas SUMIFS)
- Columna O: Total gastado anual
- Columna P: % anual usado

Formato condicional: amarillo >80%, rojo >100% del presupuesto mensual.

### Balance Compartido

Por cada mes calcula:
- Total compartido, pagó Moises, pagó Oriana
- Corresponde a cada uno (usando helper columns O/P de Transacciones)
- Balance = Pagado - Corresponde
- Resultado en texto ("Oriana le debe X a Moises" o viceversa)
- Saldo acumulado anual

### Gastos Fijos

Columna "¿Registrado este mes?" usa COUNTIFS con wildcard para buscar transacciones cuya descripción contenga el nombre del gasto fijo en el mes actual.

### Named Ranges (para la API del bot — se crean en Fase 4)

- `Transacciones_Datos` → Transacciones!A2:L200
- `Transacciones_Fecha` → Transacciones!A2:A200
- `Transacciones_Monto` → Transacciones!E2:E200
- `Transacciones_Categoria` → Transacciones!D2:D200
- `Transacciones_Moneda` → Transacciones!F2:F200
- `Transacciones_Tipo` → Transacciones!H2:H200
- `Lista_Categorias` → Categorías!A2:A12
- `Keywords_Categorias` → Categorías!B2:B12

---

## Setup del Google Sheet

Script de Apps Script en `google-sheets/setup.js`. Dividido en 4 funciones por el límite de 6 minutos de Apps Script.

Instrucciones:
1. Crear Google Sheet nuevo en blanco
2. Extensiones > Apps Script
3. Pegar el contenido de `setup.js`
4. Ejecutar `setupParte1()` → esperar a que termine
5. Ejecutar `setupParte2()` → esperar a que termine
6. Ejecutar `setupParte3()` → esperar a que termine
7. Ejecutar `setupParte4()` → esperar a que termine
8. Autorizar permisos cuando se solicite

Contenido por función:
- `setupParte1()`: Crea 8 hojas, Categorías, Transacciones (headers, ARRAYFORMULAs, validaciones, formatos)
- `setupParte2()`: Presupuesto ARS (3 secciones) y Presupuesto USD (1 sección) con SUMIFS
- `setupParte3()`: Gastos Fijos, Ingresos, Balance Compartido
- `setupParte4()`: Dashboard (labels y estructura, sin fórmulas — se agregan en Fase 4 vía Sheets API)

---

## Estructura del Bot

```
bot/
├── package.json          ← grammy, googleapis, dotenv, node-cron
├── .env.example          ← Template de variables de entorno
└── src/
    ├── index.js          ← Entrada, auth middleware, parse + confirm flow, alertas presupuesto
    ├── config.js         ← Env vars (incluye Telegram IDs)
    ├── sheets.js         ← Auth Service Account + cliente Google Sheets API v4
    ├── categories.js     ← Carga y cachea categorías desde el Sheet
    ├── parser.js         ← Parser de lenguaje natural (función pura)
    └── scheduler.js      ← Cron jobs: auto-fijos diario, resumen semanal, limpieza alertas
```

### Variables de entorno requeridas

Archivo `.env` en la **raíz del proyecto** (no en `bot/`).

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `BOT_TOKEN` | ✅ | Token del bot de Telegram (@BotFather) |
| `GOOGLE_SHEET_ID` | ✅ | ID del Google Sheet (de la URL) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | ✅ | Email del Service Account |
| `GOOGLE_PRIVATE_KEY` | ✅ | Clave privada del Service Account |
| `MOISES_TELEGRAM_ID` | ✅ | Telegram user ID de Moises |
| `ORIANA_TELEGRAM_ID` | ✅ | Telegram user ID de Oriana |
| `MOISES_SALARY_USD` | ❌ | Salario total mensual en USD de Deel |
| `MOISES_SALARY_ARS` | ❌ | Salario fijo en ARS (para calcular USD a cambiar) |
| `ORIANA_SALARY_USD` | ❌ | Salario total mensual en USD de Deel de Oriana |
| `ORIANA_SALARY_ARS` | ❌ | Salario fijo en ARS de Oriana (para calcular USD a cambiar) |
| `CIERRE_GALICIA` | ❌ | Día de cierre tarjetas Galicia (1-28, para cálculo primera cuota) |
| `CIERRE_BBVA` | ❌ | Día de cierre tarjetas BBVA (1-28, para cálculo primera cuota) |

### Comandos disponibles

| Comando / Acción | Función |
|---------|---------|
| `/start` | Saludo con ejemplos de uso y lista de comandos |
| `/ping` | Verifica conexión y muestra categorías |
| `/balance` | Balance compartido del mes: quién le debe a quién |
| `/resumen [mes]` | Resumen de gastos del mes (por categoría, tipo) |
| `/gastosfijos` | Estado de gastos fijos: cuáles están registrados y cuáles faltan |
| `/ultimas [n]` | Últimas N transacciones (default 5, max 10) |
| `/borrar` | Muestra últimas 5, elegir cuál borrar con botones |
| `/flujo [mes]` | Flujo financiero: ingresos vs gastos vs sobrante del mes |
| `/tarjeta [mes]` | Resumen de gastos con tarjeta de crédito del mes |
| `/registrar_fijos` | Registrar gastos fijos y cuotas pendientes del mes (con opción de editar montos) |
| `/cuotas` | Ver estado de compras en cuotas (activas, completadas, total mensual) |
| `/cotizacion [tc]` | Registra ingresos del mes: calcula USD a cambiar, queda en Deel, extra. Escribe en Ingresos |
| `/ingreso [monto] [desc]` | Registrar ingreso extra (se suma al mes actual) |
| Texto libre | Parsea como transacción, muestra preview con botones |
| ✅ Confirmar | Guarda la transacción en Google Sheets |
| ❌ Cancelar | Descarta la transacción |

### Recordatorio automático de ingresos

Al iniciar el bot, si las env vars de ingresos están configuradas y el mes actual no tiene ingresos registrados, envía un mensaje de texto a ambos (Moises y Oriana): "Recordá registrar los ingresos con /cotizacion [monto]".

### Flujo de cotización (/cotizacion)

1. Usuario envía `/cotizacion 1350`
2. Bot calcula para ambos: USD exacto = SALARY\_ARS / TC, redondea ↑ al próximo múltiplo de 50
3. Muestra preview detallado para Moises y Oriana: salario USD, salario ARS, USD exacto, USD a cambiar, queda en Deel, extra
4. Si ya hay ingresos registrados → avisa y ofrece actualizar (retroactivo: borra extra anterior)
5. ✅ → escribe en Ingresos (Salario, Queda Deel, Transferido, TC) para ambos + registra extra total como transacción compartida
6. Notifica al otro usuario con el mismo mensaje detallado

### Flujo de /flujo

1. Usuario envía `/flujo` o `/flujo febrero`
2. Bot lee datos de Ingresos (ambos) + suma transacciones del mes
3. Muestra: ingresos ARS (Moises + Oriana), gastos ARS (con desglose Tarjeta), sobrante ARS, y sección USD (salario, transferido, gastado, queda en Deel)

### Flujo de /tarjeta

1. Usuario envía `/tarjeta` o `/tarjeta febrero`
2. Bot carga transacciones del mes y filtra por `isTarjeta(metodoPago)` (incluye tarjetas específicas + legacy "Tarjeta")
3. Muestra: total, desglose por tarjeta (si hay más de una), desglose por categoría, y listado detallado con nombre de tarjeta

### Flujo de /registrar_fijos

1. Usuario envía `/registrar_fijos` (o recibe recordatorio automático al iniciar el bot)
2. Bot carga gastos fijos y filtra: pendientes (❌) + relevantes al usuario (Individual propio + Compartidos)
3. Muestra listado numerado con botones: [✅ Registrar todos] [✏️ Editar monto] [❌ Cancelar]
4. **Registrar todos**: re-lee gastos fijos del Sheet para evitar duplicados (otro usuario pudo registrar compartidos), luego crea transacciones para los que siguen pendientes
5. **Editar monto**: muestra botones numerados → elige cuál → envía nuevo monto como texto → actualiza monto en la hoja Gastos Fijos + actualiza la lista → vuelve al menú principal
6. **Cancelar**: descarta

La edición de monto actualiza tanto la lista en memoria como la hoja Gastos Fijos (columna C), de forma que el nuevo monto persiste para meses futuros.

### Recordatorio automático de gastos fijos

Al iniciar el bot, si hay gastos fijos pendientes, envía lista personalizada a cada usuario:
- **Moises** recibe: Individual Moises + Compartidos pendientes
- **Oriana** recibe: Individual Oriana + Compartidos pendientes

Los compartidos aparecen en ambas listas. El primero que confirma los registra; al confirmar, el bot re-lee el Sheet para no duplicar los que el otro ya registró.

### Auto-registro diario de gastos fijos (scheduler)

Todos los días a las 9:00 AM Buenos Aires, el bot revisa si hay gastos fijos con día de vencimiento = hoy. Si los hay:

1. Filtra gastos fijos pendientes (❌) cuyo día coincide con hoy
2. Incluye cuotas pendientes del mes actual
3. Cada usuario recibe su preview personalizado (Individual propio + Compartidos)
4. Botones: [✅ Registrar todos] [✏️ Editar monto] [❌ Ahora no]
5. Usa los mismos callbacks que `/registrar_fijos` — sin duplicar lógica

### Alertas de presupuesto

Se disparan al registrar cada gasto (no por cron). Después de guardar una transacción:

1. Lee presupuestos con `getPresupuestos()` (Map: `"categoria|tipo|moneda"` → monto)
2. Suma transacciones del mes para esa categoría+tipo+moneda
3. Si supera 80% → alerta 🟡. Si supera 100% → alerta 🔴
4. `budgetAlertsSent` Map evita alertas repetidas (key: `"cat|tipo|moneda|mes|año|umbral"`)
5. Se limpia al inicio de cada mes (cron `0 0 1 * *`)

Puntos de integración: después de `appendTransaction()` en tx normal, selección de tarjeta, y registro batch de gastos fijos.

Destinatario según tipo de gasto:
- Individual Moises → alerta a Moises
- Individual Oriana → alerta a Oriana
- Compartido → alerta a ambos

### Resumen semanal

Lunes 9:00 AM Buenos Aires. Mismo mensaje a ambos usuarios.

Contenido:
- Total semana (ARS + USD) y cantidad de transacciones
- Top 5 categorías por monto
- Desglose por tipo (Individual M / Individual O / Compartido)
- Balance compartido del mes (acumulado)
- Alertas de presupuesto: categorías en 🟡 (>80%) o 🔴 (>100%)

Edge case: si estamos en los primeros 7 días del mes, también carga transacciones del mes anterior para cubrir la semana completa.

### Scheduler (scheduler.js)

```
startScheduler(bot, ctx)
├── setTimeout checkIncomeReminder (3s)
├── setTimeout checkFixedExpensesReminder (5s)
├── cron '0 9 * * *'   → checkDailyAutoFijos (diario)
├── cron '0 9 * * 1'   → sendWeeklySummary (lunes)
└── cron '0 0 1 * *'   → limpiar budgetAlertsSent (mensual)
```

Recibe un objeto `ctx` con referencias compartidas (Maps, funciones helper) para evitar dependencias circulares con index.js.

---

## Parser de lenguaje natural (Fase 3)

### Formato de input

El usuario envía texto libre al bot. El parser extrae:
- **Monto**: el número en el mensaje (soporta "3500", "15.000", "1500,50")
- **Categoría**: detectada por keywords desde la hoja Categorías del Sheet
- **Método de pago**: por keyword ("efectivo", "banco", "deel", "usd", "tarjeta"). Default: Tarjeta
- **Tipo**: "compartido" → Compartido, sino → Individual [sender]
- **Descripción**: tokens restantes, capitalizado

### Keywords de método de pago

| Keyword en mensaje | Método de pago | Moneda |
|--------------------|---------------|--------|
| (nada / default) | Tarjeta | ARS |
| "tarjeta" | Tarjeta | ARS |
| "efectivo" | Efectivo | ARS |
| "banco" | Banco | ARS |
| "deel" | Deel Card | ARS |
| "usd" | Deel USD | USD |

### Ejemplos de parsing

| Mensaje | Categoría | Monto | Método | Tipo |
|---------|-----------|-------|--------|------|
| uber 3500 | Transporte | 3500 ARS | Tarjeta | Individual [sender] |
| super 15000 compartido | Alimentación | 15000 ARS | Tarjeta | Compartido |
| 100 usd ahorro | Ahorro / Inversión | 100 USD | Deel USD | Individual [sender] |
| alquiler 150000 banco compartido | Hogar | 150000 ARS | Banco | Compartido |
| netflix 2500 | Suscripciones | 2500 ARS | Tarjeta | Individual [sender] |
| zapatillas 90000 3 cuotas | Ropa y personal | 90000 ARS | Tarjeta | Individual [sender] | cuotas=3 |
| heladera 500000 en 12 cuotas compartido | Otros | 500000 ARS | Tarjeta | Compartido | cuotas=12 |

### Normalización de acentos

El parser normaliza acentos para matching flexible: "cafe" matchea "café", "medico" matchea "médico".

---

## Dashboard (Fase 6)

Fórmulas escritas vía Sheets API con `setupDashboard()` (ejecutar una sola vez).

El Dashboard usa selectores en B4 (mes) y B5 (año). Las fórmulas se actualizan dinámicamente.

### Secciones del Dashboard

| Sección | Filas | Qué muestra |
|---------|-------|-------------|
| Resumen del mes | 8-11 | Total ARS, Total USD, # transacciones |
| Gasto por persona | 13-17 | Moises ARS/USD, Oriana ARS, Compartido ARS |
| Por método de pago | 19-28 | Visa Galicia, Master Galicia, Visa BBVA, Master BBVA, Tarjetas (total), Deel Card, Banco, Efectivo, Deel USD |
| Balance compartido | 30-31 | Resultado del mes (quién debe a quién) |
| Flujo del mes | 33-46 | Ingresos vs Gastos vs Sobrante (ARS y USD) |
| Resumen anual | 48-63 | Tabla 12 meses: ingresado, gastado, sobrante, USD |

### Setup del Dashboard

```bash
# Setup inicial (fórmulas base + headers Ingresos Oriana)
cd bot && node -e "require('./src/sheets').setupDashboard()"

# Actualización con tarjetas específicas (reescribe desde fila 19)
cd bot && node -e "require('./src/sheets').setupDashboardCards()"
```

`setupDashboard()` también corrige headers de Ingresos Oriana (misma estructura que Moises).
`setupDashboardCards()` reescribe la sección de métodos de pago con tarjetas individuales y desplaza Balance, Flujo y Resumen Anual.

### Estilos profesionales

```bash
cd bot && node -e "require('./src/sheets').setupEstilos()"
```

`setupEstilos()` aplica formato visual a todas las hojas: paleta de colores coherente, headers con fondo, filas alternadas, tab colors, anchos de columna, bordes. Ejecutar una vez (o re-ejecutar para actualizar estilos).

### Cuotas

```bash
cd bot && node -e "require('./src/sheets').setupCuotas()"
```

`setupCuotas()` crea la hoja Cuotas con headers, validaciones, fórmulas de estado y estilos. Ejecutar una sola vez.

---

## Dashboard Streamlit (Fase 8)

Dashboard de visualización de datos accesible desde el celular.

### Estructura

```
dashboard/
├── app.py                 # Entry point
├── requirements.txt       # streamlit, gspread, plotly, pandas
├── .streamlit/
│   ├── config.toml        # Tema visual
│   └── secrets.toml       # Credenciales (NO en git)
└── src/
    ├── conexion.py        # Auth Google Sheets (read-only)
    ├── datos.py           # Lectura de datos con cache 5 min
    ├── graficos.py        # Gráficos Plotly mobile-friendly
    └── formato.py         # Helpers moneda AR, fechas
```

### Secciones

| Sección | Qué muestra |
|---------|-------------|
| Resumen del mes | Totales ARS/USD, por persona, distribución por tipo |
| Gastos por categoría | Dona + barras, filtrable por persona |
| Tendencias mensuales | Líneas mes a mes, top 5 categorías apiladas |
| Balance compartido | Quién debe a quién, tabla mensual, evolución |
| Presupuesto vs real | Barras con colores por %, progress bars |
| Métodos de pago | Distribución por método, total tarjetas |
| Cuotas activas | Lista con progreso, total mensual |
| Flujo de caja | Ingresos vs gastos ARS/USD, sobrante |
| Gastos fijos | Registrados vs pendientes, progreso |
| Comparativo M vs O | Barras agrupadas por categoría |

### Deploy

```
Streamlit Community Cloud:
- Repo: mxavelli/finance
- Branch: main
- Main file: dashboard/app.py
- Secrets: JSON Service Account + sheet_id
```

---

## Próximos pasos al retomar

- **Fase 7: Refinamiento** — En progreso. Ya implementados: `/tarjeta`, `/registrar_fijos`, recordatorio gastos fijos, tarjetas de crédito específicas, cuotas de tarjeta, rangos expandidos, parsing locale, filtros robustos, auto-fijos diario, alertas de presupuesto, resumen semanal
- **Fase 8: Dashboard Streamlit** — Funcionando en Streamlit Community Cloud con viewer auth
- Ideas pendientes: export, más ideas del usuario
