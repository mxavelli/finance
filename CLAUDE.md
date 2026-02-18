# Sistema Automatizado de Finanzas Personales

## Qué es este proyecto

Sistema de finanzas personales para Moises y Oriana (Buenos Aires, Argentina). Compuesto por:

1. **Google Sheets** — Dashboard central con transacciones, presupuestos, balance compartido
2. **Bot de Telegram** — Interfaz de input en lenguaje natural en español
3. **Google Sheets API** — Conexión entre el bot y el Sheet

Moises cobra en USD vía Deel. El dinero se distribuye en 3 bolsillos: Deel USD (ahorro), Deel Card (gastos en ARS), Banco ARS (pesos). Oriana también registra gastos y tiene sus propios ingresos en ARS.

## Estructura del repositorio

```
finance/
├── CLAUDE.md              ← Este archivo
├── docs/
│   └── SPEC.md            ← Fuente de verdad técnica (documento vivo)
├── google-sheets/
│   └── setup.js           ← Apps Script para crear el Sheet
└── bot/                   ← Bot de Telegram (grammY + googleapis)
    ├── package.json
    ├── .env.example
    └── src/
        ├── index.js       ← Punto de entrada del bot
        ├── config.js      ← Variables de entorno
        └── sheets.js      ← Conexión Google Sheets API
```

## Documento de especificaciones

**`docs/SPEC.md`** es el documento vivo con TODAS las definiciones técnicas del proyecto:
- Estado de cada fase
- Decisiones de diseño con fecha
- Modelo de datos completo
- Estructura del Sheet
- Stack técnico

Cualquier definición técnica o decisión del usuario va a SPEC.md.

## Convenciones de código

- Idioma del código: comentarios en español
- Commits: descriptivos, en español
- Priorizar simplicidad y mantenibilidad
- No generar pseudocódigo ni placeholders — todo debe ser funcional
- No mantener código deprecado — para eso está git
- No agregar features que no se pidieron

## Fases de desarrollo

El proyecto avanza fase por fase. No generar código de fases futuras hasta que la actual esté aprobada. Ver estado actual en `docs/SPEC.md` → "Estado del proyecto".

1. Diseño del Google Sheet ✅
2. Setup del proyecto Node.js
3. Parser de lenguaje natural
4. Integración con Google Sheets API
5. Flujo completo del bot
6. Dashboard y reportes en el Sheet
7. Refinamiento

## Ante decisiones de diseño

Presentar opciones con trade-offs brevemente y esperar decisión del usuario. Si algo no tiene sentido técnicamente o hay una mejor alternativa, decirlo directamente.

---

## RECORDATORIO FINAL

Antes de responder al usuario:

1. **¿Leíste `docs/SPEC.md`?** Si no, léelo ahora.
2. **¿El usuario definió algo nuevo?** Actualiza `SPEC.md` inmediatamente.
3. **¿Hay conflicto entre este archivo y `SPEC.md`?** `SPEC.md` es la fuente de verdad.
4. **¿Hay archivos o código deprecado?** Borralo. Para eso está git.
5. **¿Terminaste la conversación?** Revisá si queda algo pendiente por actualizar en `SPEC.md`.

El `SPEC.md` es un documento vivo que debe reflejar TODAS las decisiones y definiciones del proyecto. Si el usuario dice "los descuentos se manejan de X forma" o "el campo se llama Y", eso va a `SPEC.md`.
