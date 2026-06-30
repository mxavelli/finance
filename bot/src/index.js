// Punto de entrada del bot de Telegram.
// Fase 5: flujo completo con consultas, borrado e ingresos.

const { Bot, InlineKeyboard, Keyboard } = require('grammy');
const config = require('./config');
const {
  appendTransaction, appendTransactionsBatch, getBalance, getMonthlyTransactions,
  getGastosFijos, updateGastoFijoMonto, getLastTransactions, deleteTransaction,
  getIncomeStatus, registerIncome, getCurrentIncome, updateIncome, getFlowData,
  getCuotas, appendCuota, updateCuotasBatch, updateCuotaMonto,
  getPresupuestos, getSharedUnsettled, settleTransaction, parseLocalNumber,
  getCryptoHoldings, getCryptoTransactions, appendCryptoTransaction, addCryptoHolding,
  getInversiones, getInversionesHistorial, updateInversiones, appendInversionesHistorial,
  registrarPagoTC, registrarOtrosIngresos,
  getAhorroCuentas, updateAhorroCuenta, getLastTC,
} = require('./sheets');
const { getCategories } = require('./categories');
const { formatAmount } = require('./parser');
const { startScheduler } = require('./scheduler');
const { transcribeAudio, parseExpense, analyzeReceipt, analyzeStatementPdf, isConfigured: isAiConfigured } = require('./ai');
const { simulateAffordability, VERDICT_EMOJI: AFFORD_EMOJI, esTarjeta: affordEsTarjeta } = require('./affordability');
const { CATEGORIAS_POSITIVAS, ahorradoEnArs } = require('./constants');

const bot = new Bot(config.botToken);

// Middleware de seguridad: solo usuarios autorizados pueden usar el bot
const AUTHORIZED_USERS = new Set([config.moisesId, config.orianaId]);
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !AUTHORIZED_USERS.has(userId)) {
    if (ctx.message) {
      await ctx.reply('No tenés acceso a este bot.');
    }
    return;
  }
  return next();
});

// Verifica si un metodo de pago es una tarjeta de credito (especifica o legacy "Tarjeta")
function isTarjeta(metodo) {
  return metodo === 'Tarjeta' || config.todasLasTarjetas.includes(metodo);
}

// ============================================
// ESTADO EN MEMORIA
// ============================================

const pendingTx = new Map();       // Transacciones pendientes de confirmacion
const pendingDeletes = new Map();   // Borrados pendientes de confirmacion
const pendingIncome = new Map();    // Ingresos extras pendientes
const pendingFijos = new Map();     // Gastos fijos pendientes de registro
const pendingFixedEdit = new Map(); // Edicion de monto de gasto fijo (userId → estado)
const pendingCuotaEdit = new Map(); // Ajuste de monto cuota post-confirmacion (userId → estado)
const pendingSettle = new Map();   // Saldados pendientes de confirmacion
const pendingCrypto = new Map();   // Operaciones crypto pendientes
const pendingInversiones = new Map(); // Actualización de inversiones pendiente
const pendingAhorro = new Map();      // Actualización de saldo de ahorro pendiente
const pendingManual = new Map();     // Wizard carga manual (userId → estado)
const pendingPdf = new Map();        // Reconciliación de PDF de resumen TC
let txCounter = 0;
const TX_TTL = 10 * 60 * 1000; // 10 minutos

// Alertas de presupuesto enviadas este mes (evita repetir).
// Key: "categoria|tipo|moneda|month|year|threshold"
const budgetAlertsSent = new Map();

// Nombres de meses en español para parseo y display
const MESES_NOMBRE = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Limpia entries expirados de cualquier Map
function cleanMap(map) {
  const now = Date.now();
  for (const [id, entry] of map) {
    if (now - entry.createdAt > TX_TTL) map.delete(id);
  }
}

// Menú persistente (ReplyKeyboard) — siempre visible en la parte inferior del chat
const mainMenu = new Keyboard()
  .text('📋 Registrar').text('💰 Balance').row()
  .text('📊 Resumen').text('📝 Últimas').row()
  .text('💵 Flujo').text('🔮 Próximo').row()
  .text('📅 Proyección').text('🤝 Saldar').row()
  .text('💎 Ahorro').text('❓ Ayuda').row()
  .resized().persistent();

// Mapeo botón del menú → nombre de comando
const MENU_MAP = {
  '📋 Registrar':  'registrar_menu',
  '💰 Balance':    'balance',
  '📊 Resumen':    'resumen',
  '📝 Últimas':    'ultimas',
  '💵 Flujo':      'flujo',
  '🔮 Próximo':    'proximo',
  '📅 Proyección': 'proyeccion',
  '🤝 Saldar':     'saldar',
  '💎 Ahorro':     'ahorro',
  '❓ Ayuda':      'start',
};

// Fecha actual en Buenos Aires
function getNowBA() {
  const now = new Date();
  const ba = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return { month: ba.getMonth() + 1, year: ba.getFullYear(), day: ba.getDate() };
}

// Calcula mes de primera cuota segun fecha de compra y dia de cierre de tarjeta.
// cierre=0 (no configurado) o compra<=cierre → mes siguiente.
// compra>cierre → mes+2.
function calcPrimeraCuota(purchaseDate, cierreDay) {
  function nextMonth(m, y) {
    return m === 12 ? { month: 1, year: y + 1 } : { month: m + 1, year: y };
  }
  if (cierreDay === 0 || purchaseDate.day <= cierreDay) {
    return nextMonth(purchaseDate.month, purchaseDate.year);
  }
  const next = nextMonth(purchaseDate.month, purchaseDate.year);
  return nextMonth(next.month, next.year);
}

function formatMesAnio(month, year) {
  return `${String(month).padStart(2, '0')}/${year}`;
}

function parseMesAnio(str) {
  const parts = str.split('/');
  return { month: parseInt(parts[0]), year: parseInt(parts[1]) };
}

function monthsDiff(from, to) {
  return (to.year - from.year) * 12 + (to.month - from.month);
}

// Determina cuotas pendientes para el mes actual.
// Una cuota es pendiente si el mes actual esta dentro de su rango y la cuota esperada > registradas.
function getPendingCuotasForMonth(cuotas, month, year) {
  const now = { month, year };
  const result = [];
  for (const c of cuotas) {
    if (!c.primeraCuota || c.cuotasRegistradas >= c.cuotasTotales) continue;
    const primera = parseMesAnio(c.primeraCuota);
    const diff = monthsDiff(primera, now);
    if (diff < 0 || diff >= c.cuotasTotales) continue;
    const cuotaEsperada = diff + 1;
    if (c.cuotasRegistradas >= cuotaEsperada) continue;
    result.push({ ...c, cuotaNumero: cuotaEsperada, esCuota: true });
  }
  return result;
}

// Filtra cuotas relevantes para un usuario (individual propio + compartidos)
// Compartido, vacío, o desconocido → visible para ambos.
function filterCuotasForUser(cuotas, userId) {
  const esMoises = userId === config.moisesId;
  return cuotas.filter(c => {
    const tipo = (c.tipo || '').toLowerCase().trim();
    if (tipo.includes('moises')) return esMoises;
    if (tipo.includes('oriana')) return !esMoises;
    return true;
  });
}

// Construye texto del listado con gastos fijos + cuotas pendientes
function buildFijosAndCuotasText(gastos, cuotas) {
  let text = `📋 *Gastos fijos y cuotas pendientes*\n\n`;
  let idx = 1;
  if (gastos.length > 0) {
    text += '*Gastos fijos:*\n';
    for (const g of gastos) {
      text += `${idx}. ${g.descripcion} — ${fmtMonto(g.montoEstimado, g.moneda)} (${g.metodoPago})\n`;
      idx++;
    }
  }
  if (cuotas.length > 0) {
    if (gastos.length > 0) text += '\n';
    text += '*Cuotas:*\n';
    for (const c of cuotas) {
      text += `${idx}. 💳 ${c.descripcion} (Cuota ${c.cuotaNumero}/${c.cuotasTotales}) — ${fmtMonto(c.montoCuota, c.moneda)} (${c.tarjeta})\n`;
      idx++;
    }
  }
  text += `\nTotal: ${gastos.length + cuotas.length} pendientes`;
  return text;
}

// Parsea argumento de mes: "febrero", "feb", "2", o vacio (= mes actual)
function parseMonth(arg) {
  const { month, year } = getNowBA();
  if (!arg || !arg.trim()) return { month, year };

  const lower = arg.trim().toLowerCase();

  // Numero directo
  const num = parseInt(lower);
  if (num >= 1 && num <= 12) return { month: num, year };

  // Nombre completo o inicio
  const idx = MESES_NOMBRE.findIndex(m => m.startsWith(lower));
  if (idx !== -1) return { month: idx + 1, year };

  return { month, year };
}

// Formatea un monto para display (reutiliza logica del parser)
function fmtMonto(monto, moneda) {
  return formatAmount(monto, moneda || 'ARS');
}

// Envía un texto largo partiéndolo en varios mensajes (límite Telegram: 4096 chars).
// Corta en saltos de línea para no romper entidades Markdown a la mitad.
async function replyChunked(ctx, text, options) {
  const LIMIT = 3900;
  if (text.length <= LIMIT) return ctx.reply(text, options);

  let chunk = '';
  for (const line of text.split('\n')) {
    if (chunk.length + line.length + 1 > LIMIT) {
      await ctx.reply(chunk, options);
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) await ctx.reply(chunk, options);
}

// Verifica si una transacción superó el 80% o 100% del presupuesto de su categoría.
// Para categorías positivas (ahorro), no alerta al exceder.
// Se ejecuta después de cada appendTransaction exitoso (fire and forget).
async function checkBudgetAlert(userId, tx) {
  try {
    if (!tx.categoria || !tx.tipo || !tx.moneda) return;
    const { month, year } = getNowBA();

    const presupuestos = await getPresupuestos();
    const key = `${tx.categoria}|${tx.tipo}|${tx.moneda}`;
    const budget = presupuestos.get(key);
    if (!budget || budget <= 0) return;

    // Categorías positivas: no alertar por exceso
    if (CATEGORIAS_POSITIVAS.includes(tx.categoria)) return;

    const transactions = await getMonthlyTransactions(month, year);
    const totalGastado = transactions
      .filter(t => t.categoria === tx.categoria && t.tipo === tx.tipo && t.moneda === tx.moneda)
      .reduce((sum, t) => sum + t.monto, 0);

    const porcentaje = (totalGastado / budget) * 100;

    const thresholds = [
      { pct: 100, emoji: '🔴', label: 'superó' },
      { pct: 80, emoji: '🟡', label: 'llegó al' },
    ];

    for (const th of thresholds) {
      if (porcentaje < th.pct) continue;

      const alertKey = `${key}|${month}|${year}|${th.pct}`;
      if (budgetAlertsSent.has(alertKey)) continue;
      budgetAlertsSent.set(alertKey, Date.now());

      const pctStr = Math.round(porcentaje);
      const text =
        `${th.emoji} *Alerta de presupuesto*\n\n` +
        `Tu gasto en *${tx.categoria}* (${tx.tipo}) ${th.label} el ${pctStr}% del presupuesto.\n` +
        `Gastado: ${fmtMonto(totalGastado, tx.moneda)} / ${fmtMonto(budget, tx.moneda)}`;

      // Enviar a los usuarios relevantes
      const tipoLower = (tx.tipo || '').toLowerCase();
      const recipients = tipoLower.includes('moises') ? [config.moisesId]
        : tipoLower.includes('oriana') ? [config.orianaId]
        : [config.moisesId, config.orianaId];

      for (const rid of recipients) {
        await bot.api.sendMessage(rid, text, { parse_mode: 'Markdown' });
      }
      break; // Solo el umbral más alto alcanzado
    }
  } catch (error) {
    console.error('Error chequeando presupuesto:', error.message);
  }
}

// ============================================
// MIDDLEWARE
// ============================================

bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  if (userId !== config.moisesId && userId !== config.orianaId) {
    return ctx.reply('No tenés acceso a este bot.');
  }
  return next();
});

// ============================================
// COMANDOS
// ============================================

// /start — ayuda completa con todos los comandos
async function cmdStart(ctx) {
  const text =
    '*PlataBot* 🤖 — Tus finanzas en Telegram\n\n' +

    '*📝 Registrar gastos*\n' +
    'Escribí el gasto directamente:\n' +
    '• `uber 3500` → Transporte, Tarjeta\n' +
    '• `super 15000 compartido` → Alimentación, Compartido\n' +
    '• `100 usd ahorro` → Ahorro, Deel USD\n' +
    '• `zapatillas 90000 6 cuotas visa galicia` → con cuotas\n' +
    '• 🎙 Audio: mandá un mensaje de voz y lo procesa\n' +
    '• 📸 Foto: sacale una foto al ticket/recibo\n' +
    '• 📄 PDF resumen TC: subilo y el bot reconcilia + carga Pagos TC\n\n' +
    '/gasto — Wizard paso a paso (categoría, monto, método...)\n' +
    '/registrar\\_fijos — Gastos fijos y cuotas pendientes del mes\n' +
    '/cotizacion `[tc]` — Registrar ingresos del mes con cotización\n' +
    '/ingreso `[monto] [desc]` — Ingreso extra del mes\n\n' +

    '*📊 Consultar estado*\n' +
    '/balance — Quién le debe a quién este mes\n' +
    '/resumen `[mes]` — Resumen de gastos del mes\n' +
    '/flujo `[mes]` — Ingresos vs gastos vs sobrante\n' +
    '/tarjeta `[mes]` — Total y desglose con tarjeta de crédito\n' +
    '/gastosfijos — Estado de gastos fijos (✅ / ❌)\n' +
    '/ultimas `[n]` — Últimas N transacciones (default 5)\n' +
    '/cuotas — Estado de cuotas activas y completadas\n' +
    '/suscripciones — Análisis de tus suscripciones + detección de redundancias\n\n' +

    '*🔮 Proyecciones*\n' +
    '/proximo — Estimación del próximo resumen TC (fijos + cuotas + variable)\n' +
    '/finalizan — Cuotas que terminan y ahorro proyectado en los próximos 3 meses\n' +
    '/meta — Progreso de ahorro vs meta del mes (con proyección fin de mes)\n' +
    '/proyeccion `[mes]` — Proyección completa: fijos + cuotas + variables estimados (ARS y USD)\n' +
    '  Sin arg → mes siguiente. Ej: `/proyeccion julio`\n' +
    '/puedo `[compra]` — ¿Encaja esta compra con la meta de ahorro?\n' +
    '  Ej: `/puedo tv 800000 visa galicia 12 cuotas`\n\n' +

    '*💎 Patrimonio*\n' +
    '/ahorro — Ahorro total + registrar aporte (suma al saldo y cuenta para la meta)\n' +
    '/crypto — Portafolio crypto con precio live (compras/ventas)\n' +
    '/inversiones — Portafolio PPI (valor total + composición)\n\n' +

    '*🛠 Mantenimiento*\n' +
    '/borrar — Borrar una de las últimas transacciones\n' +
    '/saldar — Marcar gasto compartido como saldado\n' +
    '/pago\\_tarjeta `[tarjeta] [monto] [mes]` — Cargar TOTAL A PAGAR de un resumen\n' +
    '  Ej: `/pago_tarjeta Visa Galicia 2828119.80`\n\n' +

    '*🔌 Otros*\n' +
    '/ping — Verificar conexión con el Sheet\n\n' +

    '_Automatizado:_ a las 19hs todos los días recibís un aviso si tenés un débito automático en 2 días.';

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: mainMenu });
}
bot.command('start', cmdStart);

// /ping
bot.command('ping', async (ctx) => {
  try {
    const categorias = await getCategories();
    ctx.reply(`Conexión OK. Categorías: ${categorias.map(c => c.name).join(', ')}`);
  } catch (error) {
    console.error('Error conectando a Google Sheets:', error.message);
    ctx.reply('Error conectando a Google Sheets. Revisá los logs.');
  }
});

// /balance — balance compartido del mes actual
async function cmdBalance(ctx) {
  try {
    const { month, year } = getNowBA();
    const data = await getBalance();
    const mes = data.meses[month - 1];

    if (!mes || mes.total === 0) {
      return ctx.reply(`📊 *Balance Compartido — ${MESES_CORTO[month - 1]} ${year}*\n\nNo hay gastos compartidos este mes.`, { parse_mode: 'Markdown' });
    }

    const text =
      `📊 *Balance Compartido — ${MESES_CORTO[month - 1]} ${year}*\n\n` +
      `Total compartido: ${fmtMonto(mes.total, 'ARS')}\n` +
      `Pagó Moises: ${fmtMonto(mes.pagoMoises, 'ARS')}\n` +
      `Pagó Oriana: ${fmtMonto(mes.pagoOriana, 'ARS')}\n\n` +
      `Corresponde Moises: ${fmtMonto(mes.corrMoises, 'ARS')}\n` +
      `Corresponde Oriana: ${fmtMonto(mes.corrOriana, 'ARS')}\n\n` +
      `→ ${mes.resultado || 'Están a mano'}` +
      (data.saldoAcumulado ? `\n\nSaldo acumulado: ${data.saldoAcumulado}` : '');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /balance:', error.message);
    ctx.reply('Error consultando el balance. Revisá los logs.');
  }
}
bot.command('balance', cmdBalance);

// /resumen [mes] — resumen de gastos del mes
async function cmdResumen(ctx) {
  try {
    const arg = ctx.match;
    const { month, year } = parseMonth(arg);
    const transactions = await getMonthlyTransactions(month, year);

    if (transactions.length === 0) {
      return ctx.reply(`📈 *Resumen — ${MESES_CORTO[month - 1]} ${year}*\n\nNo hay transacciones este mes.`, { parse_mode: 'Markdown' });
    }

    // Totales por moneda
    let totalArs = 0, totalUsd = 0;
    const porCategoria = {};
    const porTipo = {};
    const porMetodo = {};

    for (const tx of transactions) {
      if (tx.moneda === 'USD') totalUsd += tx.monto;
      else totalArs += tx.monto;

      porCategoria[tx.categoria] = (porCategoria[tx.categoria] || 0) + tx.monto;
      porTipo[tx.tipo] = (porTipo[tx.tipo] || 0) + tx.monto;
      porMetodo[tx.metodoPago] = (porMetodo[tx.metodoPago] || 0) + tx.monto;
    }

    let text = `📈 *Resumen — ${MESES_CORTO[month - 1]} ${year}*\n\n`;
    text += `💰 Total: ${fmtMonto(totalArs, 'ARS')}`;
    if (totalUsd > 0) text += ` | ${fmtMonto(totalUsd, 'USD')}`;
    text += `\n📝 ${transactions.length} transacciones\n`;

    // Por categoria (ordenado por monto desc)
    const catEntries = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]);
    text += '\n*Por categoría:*\n';
    for (const [cat, monto] of catEntries) {
      text += `• ${cat}: ${fmtMonto(monto, 'ARS')}\n`;
    }

    // Por tipo
    const tipoEntries = Object.entries(porTipo).sort((a, b) => b[1] - a[1]);
    text += '\n*Por tipo:*\n';
    for (const [tipo, monto] of tipoEntries) {
      text += `• ${tipo}: ${fmtMonto(monto, 'ARS')}\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /resumen:', error.message);
    ctx.reply('Error consultando el resumen. Revisá los logs.');
  }
}
bot.command('resumen', cmdResumen);

// /gastosfijos — estado de gastos fijos del mes actual
async function cmdGastosFijos(ctx) {
  try {
    const { month, year } = getNowBA();
    const allGastos = await getGastosFijos();
    const gastos = filterGastosByFrequency(allGastos, month);

    if (gastos.length === 0) {
      return ctx.reply('No hay gastos fijos para este mes.');
    }

    let text = `📋 *Gastos Fijos — ${MESES_CORTO[month - 1]} ${year}*\n\n`;
    let faltantes = 0;

    for (const g of gastos) {
      const estado = g.registrado ? '✅' : '❌';
      if (!g.registrado) faltantes++;
      const monto = g.montoEstimado ? ` — ${fmtMonto(g.montoEstimado, g.moneda)}` : '';
      text += `${estado} ${g.descripcion}${monto}\n`;
    }

    text += `\n${faltantes === 0 ? 'Todos registrados' : `Faltan ${faltantes} de ${gastos.length}`}`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /gastosfijos:', error.message);
    ctx.reply('Error consultando gastos fijos. Revisá los logs.');
  }
}
bot.command('gastosfijos', cmdGastosFijos);

// Grupos heurísticos para detectar suscripciones redundantes
const SUSC_GROUPS = [
  { name: 'Apple', keywords: ['apple', 'icloud'] },
  { name: 'IA / Asistentes', keywords: ['gpt', 'chatgpt', 'claude', 'anthropic', 'openai'] },
  { name: 'Streaming video', keywords: ['netflix', 'hbo', 'disney', 'paramount', 'star', 'youtube premium'] },
  { name: 'Streaming música', keywords: ['spotify', 'apple music', 'tidal', 'deezer'] },
  { name: 'Gaming', keywords: ['xbox', 'playstation', 'steam', 'epic', 'nintendo'] },
  { name: 'Productividad', keywords: ['microsoft', 'office', 'notion', '1password', 'krisp', 'loom'] },
  { name: 'Discord', keywords: ['discord'] },
];

// /suscripciones — analiza peso de cada subscription y detecta posibles redundancias
async function cmdSuscripciones(ctx) {
  try {
    const userId = ctx.from.id;
    const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
    const allGastos = await getGastosFijos();
    const userGastos = filterGastosForUser(allGastos, userId);

    if (userGastos.length === 0) {
      return ctx.reply(`No tenés gastos fijos cargados, ${quien}.`);
    }

    // Separar por frecuencia
    const mensuales = userGastos.filter(g => (g.frecuencia || 'Mensual') === 'Mensual');
    const trimestrales = userGastos.filter(g => g.frecuencia === 'Trimestral');
    const anuales = userGastos.filter(g => g.frecuencia === 'Anual');

    // Totales mensuales por moneda (mensuales + prorrateo de trimestral/anual)
    let totalArs = 0, totalUsd = 0;
    for (const g of mensuales) {
      if (g.moneda === 'USD') totalUsd += g.montoEstimado;
      else totalArs += g.montoEstimado;
    }
    for (const g of trimestrales) {
      if (g.moneda === 'USD') totalUsd += g.montoEstimado / 3;
      else totalArs += g.montoEstimado / 3;
    }
    for (const g of anuales) {
      if (g.moneda === 'USD') totalUsd += g.montoEstimado / 12;
      else totalArs += g.montoEstimado / 12;
    }

    let text = `🔍 *Suscripciones — ${quien}*\n\n`;
    text += `💰 *Total mensual equivalente:*\n`;
    if (totalArs > 0) text += `• ${fmtMonto(totalArs, 'ARS')}\n`;
    if (totalUsd > 0) text += `• ${fmtMonto(totalUsd, 'USD')}\n`;
    text += `\n`;

    // Top mensuales ARS
    const mensualesArs = mensuales.filter(g => g.moneda === 'ARS').sort((a, b) => b.montoEstimado - a.montoEstimado);
    if (mensualesArs.length > 0) {
      text += `*Top mensuales ARS:*\n`;
      for (const g of mensualesArs.slice(0, 8)) {
        const tipo = g.tipo === 'Compartido' ? ' _(compartido)_' : '';
        text += `• ${g.descripcion} — ${fmtMonto(g.montoEstimado, 'ARS')}${tipo}\n`;
      }
      if (mensualesArs.length > 8) text += `_…y ${mensualesArs.length - 8} más_\n`;
      text += '\n';
    }

    // Top mensuales USD
    const mensualesUsd = mensuales.filter(g => g.moneda === 'USD').sort((a, b) => b.montoEstimado - a.montoEstimado);
    if (mensualesUsd.length > 0) {
      text += `*Top mensuales USD:*\n`;
      for (const g of mensualesUsd.slice(0, 8)) {
        text += `• ${g.descripcion} — ${fmtMonto(g.montoEstimado, 'USD')}\n`;
      }
      if (mensualesUsd.length > 8) text += `_…y ${mensualesUsd.length - 8} más_\n`;
      text += '\n';
    }

    // No mensuales (trimestrales + anuales)
    if (trimestrales.length + anuales.length > 0) {
      text += `*No mensuales:*\n`;
      for (const g of trimestrales) {
        text += `• ${g.descripcion} — ${fmtMonto(g.montoEstimado, g.moneda)} cada 3 meses\n`;
      }
      for (const g of anuales) {
        text += `• ${g.descripcion} — ${fmtMonto(g.montoEstimado, g.moneda)} anual\n`;
      }
      text += '\n';
    }

    // Detección de grupos sospechosos
    const sospechosos = [];
    for (const grupo of SUSC_GROUPS) {
      const matches = userGastos.filter(g => {
        const desc = (g.descripcion || '').toLowerCase();
        return grupo.keywords.some(k => desc.includes(k));
      });
      if (matches.length >= 2) {
        sospechosos.push({ grupo: grupo.name, items: matches });
      }
    }

    if (sospechosos.length > 0) {
      text += `💡 *Posibles redundancias:*\n`;
      for (const s of sospechosos) {
        const nombres = s.items.map(g => g.descripcion).join(', ');
        text += `• *${s.grupo}*: ${nombres}\n`;
      }
      text += `_¿Realmente usás todas? Revisá si podés consolidar._\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /suscripciones:', error.message);
    ctx.reply('Error analizando suscripciones. Revisá los logs.');
  }
}
bot.command('suscripciones', cmdSuscripciones);

// /ultimas [n] — ultimas N transacciones
async function cmdUltimas(ctx) {
  try {
    let n = parseInt(ctx.match) || 5;
    if (n < 1) n = 5;
    if (n > 10) n = 10;

    const transactions = await getLastTransactions(n);

    if (transactions.length === 0) {
      return ctx.reply('No hay transacciones registradas.');
    }

    let text = `📋 *Últimas ${transactions.length} transacciones*\n\n`;

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const fechaCorta = tx.fecha.substring(0, 5); // DD/MM
      const compartido = tx.tipo === 'Compartido' ? ' 🤝' : '';
      text += `${i + 1}. ${fechaCorta} — ${tx.descripcion} — ${fmtMonto(tx.monto, tx.moneda)} (${tx.categoria})${compartido}\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /ultimas:', error.message);
    ctx.reply('Error consultando transacciones. Revisá los logs.');
  }
}
bot.command('ultimas', cmdUltimas);

// /tarjeta [mes] — resumen de gastos con tarjeta de crédito
async function cmdTarjeta(ctx) {
  try {
    const arg = ctx.match;
    const { month, year } = parseMonth(arg);
    const transactions = await getMonthlyTransactions(month, year);
    const tarjeta = transactions.filter(tx => isTarjeta(tx.metodoPago));

    if (tarjeta.length === 0) {
      return ctx.reply(`💳 *Tarjetas — ${MESES_CORTO[month - 1]} ${year}*\n\nNo hay gastos con tarjeta este mes.`, { parse_mode: 'Markdown' });
    }

    let total = 0;
    const porCategoria = {};
    const porTarjeta = {};
    for (const tx of tarjeta) {
      total += tx.monto;
      porCategoria[tx.categoria] = (porCategoria[tx.categoria] || 0) + tx.monto;
      porTarjeta[tx.metodoPago] = (porTarjeta[tx.metodoPago] || 0) + tx.monto;
    }

    let text = `💳 *Tarjetas — ${MESES_CORTO[month - 1]} ${year}*\n\n`;
    text += `💰 Total: ${fmtMonto(total, 'ARS')}\n`;
    text += `📝 ${tarjeta.length} transacciones\n`;

    // Desglose por tarjeta (solo si hay mas de un tipo)
    const tarjetaEntries = Object.entries(porTarjeta).sort((a, b) => b[1] - a[1]);
    if (tarjetaEntries.length > 1) {
      text += '\n*Por tarjeta:*\n';
      for (const [card, monto] of tarjetaEntries) {
        text += `• ${card}: ${fmtMonto(monto, 'ARS')}\n`;
      }
    }

    // Por categoría
    const catEntries = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]);
    text += '\n*Por categoría:*\n';
    for (const [cat, monto] of catEntries) {
      text += `• ${cat}: ${fmtMonto(monto, 'ARS')}\n`;
    }

    // Listado con nombre de tarjeta si hay multiples
    const multiCard = tarjetaEntries.length > 1;
    text += '\n*Detalle:*\n';
    for (const tx of tarjeta) {
      const fechaCorta = tx.fecha.substring(0, 5);
      const cardLabel = multiCard ? ` (${tx.metodoPago})` : '';
      text += `• ${fechaCorta} — ${tx.descripcion} — ${fmtMonto(tx.monto, tx.moneda)}${cardLabel}\n`;
    }

    await replyChunked(ctx, text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /tarjeta:', error.message);
    ctx.reply('Error consultando gastos de tarjeta. Revisá los logs.');
  }
}
bot.command('tarjeta', cmdTarjeta);

// /flujo [mes] — flujo financiero: ingresos vs gastos vs sobrante
async function cmdFlujo(ctx) {
  try {
    const arg = ctx.match;
    const { month, year } = parseMonth(arg);
    const flow = await getFlowData(month, year);

    const tieneIngresos = flow.totalIngresadoArs > 0 || flow.salarioTotalUsd > 0;

    if (!tieneIngresos && flow.gastadoArs === 0 && flow.gastadoUsd === 0) {
      return ctx.reply(`💰 *Flujo — ${MESES_CORTO[month - 1]} ${year}*\n\nNo hay datos para este mes.`, { parse_mode: 'Markdown' });
    }

    let text = `💰 *Flujo — ${MESES_CORTO[month - 1]} ${year}*\n\n`;

    // Sección ARS
    if (tieneIngresos) {
      text += `*📥 Ingresos ARS:*\n`;
      if (flow.moises.recibidoArs > 0) text += `  Moises: ${fmtMonto(flow.moises.recibidoArs, 'ARS')}\n`;
      if (flow.oriana.recibidoArs > 0) text += `  Oriana: ${fmtMonto(flow.oriana.recibidoArs, 'ARS')}\n`;
      text += `  Total: ${fmtMonto(flow.totalIngresadoArs, 'ARS')}\n\n`;
    }

    text += `*📤 Gastos ARS:* ${fmtMonto(flow.gastadoArs, 'ARS')}\n`;
    if (flow.gastoBancoEfectivo > 0) {
      text += `  — Banco + Efectivo: ${fmtMonto(flow.gastoBancoEfectivo, 'ARS')}\n`;
    }
    if (flow.gastadoDeelCard > 0) {
      text += `  — Deel Card (USD): ${fmtMonto(flow.gastadoDeelCard, 'ARS')}\n`;
    }
    if (flow.gastadoTarjeta > 0) {
      text += `  — Tarjeta este mes (pago mes prox): ${fmtMonto(flow.gastadoTarjeta, 'ARS')}\n`;
    }
    if (flow.pagosTC.totalPagosTC > 0) {
      text += `  — Pagos resúmenes TC: ${fmtMonto(flow.pagosTC.totalPagosTC, 'ARS')}\n`;
    }

    if (tieneIngresos) {
      text += `\n*📊 Sobrante ARS:* ${fmtMonto(flow.sobranteArs, 'ARS')}\n`;
      if (flow.pagosTC.saldoAnterior > 0) {
        text += `  _Saldo ant: ${fmtMonto(flow.pagosTC.saldoAnterior, 'ARS')}`;
        if (flow.pagosTC.otrosIngresos > 0) text += ` + otros: ${fmtMonto(flow.pagosTC.otrosIngresos, 'ARS')}`;
        text += `_\n`;
      }
    }

    // Sección USD
    if (flow.salarioTotalUsd > 0 || flow.gastadoUsd > 0) {
      text += `\n*💵 USD:*\n`;
      if (flow.salarioTotalUsd > 0) text += `  Salario total: ${fmtMonto(flow.salarioTotalUsd, 'USD')}\n`;
      if (flow.transferidoTotal > 0) text += `  Transferido a ARS: ${fmtMonto(flow.transferidoTotal, 'USD')}\n`;
      if (flow.gastadoUsd > 0) text += `  Gastado USD: ${fmtMonto(flow.gastadoUsd, 'USD')}\n`;
      if (flow.quedaDeelTotal > 0) text += `  Queda en Deel: ${fmtMonto(flow.quedaDeelTotal, 'USD')}\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /flujo:', error.message);
    ctx.reply('Error consultando el flujo. Revisá los logs.');
  }
}
bot.command('flujo', cmdFlujo);

// /pago_tarjeta — registra el total del resumen de una tarjeta de crédito
// Uso: /pago_tarjeta Visa Galicia 1085559.70 [mes]
async function cmdPagoTarjeta(ctx) {
  try {
    const arg = (ctx.match || '').trim();
    if (!arg) {
      return ctx.reply(
        '💳 *Registrar pago de resumen TC*\n\n' +
        'Uso: `/pago_tarjeta <tarjeta> <monto> [mes]`\n\n' +
        'Ejemplo:\n' +
        '`/pago_tarjeta Visa Galicia 1085559.70`\n' +
        '`/pago_tarjeta Master Galicia 287947.02 febrero`\n\n' +
        'Tarjetas válidas: Visa Galicia, Master Galicia, Visa BBVA, Master BBVA',
        { parse_mode: 'Markdown' }
      );
    }

    // Parsear: buscar el monto numérico y separar tarjeta de mes
    const tarjetas = ['Visa Galicia', 'Master Galicia', 'Visa BBVA', 'Master BBVA'];
    let tarjeta = null;
    let resto = arg;
    for (const t of tarjetas) {
      if (arg.toLowerCase().startsWith(t.toLowerCase())) {
        tarjeta = t;
        resto = arg.slice(t.length).trim();
        break;
      }
    }
    if (!tarjeta) {
      return ctx.reply('Tarjeta no reconocida. Opciones: Visa Galicia, Master Galicia, Visa BBVA, Master BBVA');
    }

    // Separar monto y mes opcional
    const parts = resto.split(/\s+/);
    const montoStr = parts[0];
    const mesStr = parts.slice(1).join(' ');

    const monto = parseFloat(montoStr.replace(/\./g, '').replace(',', '.'));
    if (isNaN(monto) || monto <= 0) {
      return ctx.reply('Monto inválido. Ejemplo: `/pago_tarjeta Visa Galicia 1085559.70`', { parse_mode: 'Markdown' });
    }

    const { month } = mesStr ? parseMonth(mesStr) : getNowBA();

    await registrarPagoTC(month, tarjeta, monto);
    await ctx.reply(
      `✅ Pago registrado: *${tarjeta}* — ${fmtMonto(monto, 'ARS')}\n` +
      `Mes: ${MESES_CORTO[month - 1]}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error en /pago_tarjeta:', error.message);
    ctx.reply('Error registrando el pago. Revisá los logs.');
  }
}
bot.command('pago_tarjeta', cmdPagoTarjeta);

// /registrar_fijos — registra todos los gastos fijos pendientes del mes
async function cmdRegistrarFijos(ctx) {
  try {
    const { month, year } = getNowBA();
    const [gastos, cuotas] = await Promise.all([getGastosFijos(), getCuotas()]);

    const pendientesGF = filterGastosForUser(filterGastosByFrequency(gastos.filter(g => !g.registrado), month), ctx.from.id);
    const pendientesCuotas = filterCuotasForUser(getPendingCuotasForMonth(cuotas, month, year), ctx.from.id);

    if (pendientesGF.length === 0 && pendientesCuotas.length === 0) {
      return ctx.reply('✅ Todos tus gastos fijos y cuotas del mes ya están registrados.');
    }

    cleanMap(pendingFijos);
    const fijoId = ++txCounter;

    pendingFijos.set(fijoId, {
      gastos: pendientesGF,
      cuotas: pendientesCuotas,
      userId: ctx.from.id,
      createdAt: Date.now(),
    });

    const text = pendientesCuotas.length > 0
      ? buildFijosAndCuotasText(pendientesGF, pendientesCuotas)
      : buildFijosText(pendientesGF);

    const keyboard = new InlineKeyboard()
      .text('✅ Registrar todos', `fijos_ok:${fijoId}`)
      .row()
      .text('✏️ Editar monto', `fijos_edit:${fijoId}`)
      .text('❌ Cancelar', `fijos_no:${fijoId}`);

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /registrar_fijos:', error.message);
    ctx.reply('Error consultando gastos fijos. Revisá los logs.');
  }
}
bot.command('registrar_fijos', cmdRegistrarFijos);

// /cuotas — muestra estado de todas las cuotas
async function cmdCuotas(ctx) {
  try {
    const allCuotas = await getCuotas();

    if (allCuotas.length === 0) {
      return ctx.reply('No hay cuotas registradas.');
    }

    const userCuotas = filterCuotasForUser(allCuotas, ctx.from.id);
    const activas = userCuotas.filter(c => c.cuotasRegistradas < c.cuotasTotales);
    const completadas = userCuotas.filter(c => c.cuotasRegistradas >= c.cuotasTotales);

    let text = `💳 *Cuotas*\n\n`;

    if (activas.length > 0) {
      text += '*Activas:*\n';
      for (const c of activas) {
        text += `• ${c.descripcion} — ${c.cuotasRegistradas}/${c.cuotasTotales} cuotas — ${fmtMonto(c.montoCuota, c.moneda)}/mes (${c.tarjeta})\n`;
      }
    }

    if (completadas.length > 0) {
      text += '\n*Completadas:*\n';
      for (const c of completadas) {
        text += `• ✅ ${c.descripcion} — ${c.cuotasTotales} cuotas (${c.tarjeta})\n`;
      }
    }

    if (activas.length > 0) {
      const totalMensual = activas.reduce((sum, c) => sum + c.montoCuota, 0);
      text += `\n📊 *Total mensual en cuotas:* ${fmtMonto(totalMensual, 'ARS')}`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /cuotas:', error.message);
    ctx.reply('Error consultando cuotas. Revisá los logs.');
  }
}
bot.command('cuotas', cmdCuotas);

// /finalizan — cuotas que terminan próximamente y ahorro proyectado
async function cmdFinalizan(ctx) {
  try {
    const allCuotas = await getCuotas();
    if (allCuotas.length === 0) {
      return ctx.reply('No hay cuotas registradas.');
    }

    const userId = ctx.from.id;
    const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
    const userCuotas = filterCuotasForUser(allCuotas, userId);
    const activas = userCuotas.filter(c => c.cuotasRegistradas < c.cuotasTotales);

    if (activas.length === 0) {
      return ctx.reply(`🏁 No tenés cuotas activas, ${quien}.`);
    }

    const today = getNowBA();

    // Para cada cuota: calcular mes/año de la última cuota
    const cuotasConFin = activas.map(c => {
      const primera = parseMesAnio(c.primeraCuota);
      let finMonth = primera.month + (c.cuotasTotales - 1);
      let finYear = primera.year;
      while (finMonth > 12) { finMonth -= 12; finYear += 1; }
      return { ...c, finMonth, finYear };
    }).sort((a, b) =>
      monthsDiff({ month: a.finMonth, year: a.finYear }, { month: b.finMonth, year: b.finYear })
    ).reverse();
    // Reverse para que estén por orden ascendente
    cuotasConFin.sort((a, b) =>
      monthsDiff({ month: today.month, year: today.year }, { month: a.finMonth, year: a.finYear }) -
      monthsDiff({ month: today.month, year: today.year }, { month: b.finMonth, year: b.finYear })
    );

    // Compromiso mensual actual (por moneda)
    let compromisoArs = 0, compromisoUsd = 0;
    for (const c of activas) {
      if (c.moneda === 'USD') compromisoUsd += c.montoCuota;
      else compromisoArs += c.montoCuota;
    }

    // Cuotas que finalizan en los próximos 3 meses
    const proximos3 = cuotasConFin.filter(c => {
      const diff = monthsDiff(today, { month: c.finMonth, year: c.finYear });
      return diff >= 0 && diff < 3;
    });

    let text = `🏁 *Cuotas que terminan — ${quien}*\n\n`;

    if (proximos3.length === 0) {
      text += `_No hay cuotas que finalicen en los próximos 3 meses._\n\n`;
    } else {
      text += `📍 *Finalizan en los próximos 3 meses:*\n`;
      for (const c of proximos3) {
        const mesLabel = `${MESES_CORTO[c.finMonth - 1]} ${String(c.finYear).slice(2)}`;
        const cuotasRestantes = c.cuotasTotales - c.cuotasRegistradas;
        text += `• ${c.descripcion} — quedan ${cuotasRestantes} cuotas, cierra *${mesLabel}*\n`;
        text += `  Ahorro: ${fmtMonto(c.montoCuota, c.moneda)}/mes desde el mes siguiente\n`;
      }
      text += '\n';
    }

    text += `💰 *Compromiso mensual actual:*\n`;
    if (compromisoArs > 0) text += `• ${fmtMonto(compromisoArs, 'ARS')}\n`;
    if (compromisoUsd > 0) text += `• ${fmtMonto(compromisoUsd, 'USD')}\n`;

    // Proyectar compromiso restante después de 3 meses
    const en3plus = cuotasConFin.filter(c => monthsDiff(today, { month: c.finMonth, year: c.finYear }) >= 3);
    let restArs = 0, restUsd = 0;
    for (const c of en3plus) {
      if (c.moneda === 'USD') restUsd += c.montoCuota;
      else restArs += c.montoCuota;
    }
    text += `\n🚀 *Compromiso en 3 meses:*\n`;
    if (compromisoArs > 0) text += `• ${fmtMonto(restArs, 'ARS')} _(ahorro: ${fmtMonto(compromisoArs - restArs, 'ARS')}/mes)_\n`;
    if (compromisoUsd > 0) text += `• ${fmtMonto(restUsd, 'USD')} _(ahorro: ${fmtMonto(compromisoUsd - restUsd, 'USD')}/mes)_\n`;

    text += `\n📋 Lista completa: /cuotas`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /finalizan:', error.message);
    ctx.reply('Error consultando cuotas que finalizan. Revisá los logs.');
  }
}
bot.command('finalizan', cmdFinalizan);

// /proximo — estimación de pago de tarjetas del mes próximo
async function cmdProximo(ctx) {
  try {
    const userId = ctx.from.id;
    const esMoises = userId === config.moisesId;
    const quien = esMoises ? 'Moises' : 'Oriana';
    const { month, year } = getNowBA();

    // Mes siguiente
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;

    // 1. Gastos fijos con tarjeta (filtrados por usuario y frecuencia)
    const allGastos = await getGastosFijos();
    const gastosTarjeta = filterGastosByFrequency(
      filterGastosForUser(allGastos.filter(g => isTarjeta(g.metodoPago)), userId),
      nextMonth
    );

    // 2. Cuotas pendientes para el mes siguiente
    const allCuotas = await getCuotas();
    const userCuotas = filterCuotasForUser(allCuotas, userId);
    const cuotasProximo = [];
    for (const c of userCuotas) {
      if (!c.primeraCuota || c.cuotasRegistradas >= c.cuotasTotales) continue;
      const primera = parseMesAnio(c.primeraCuota);
      const diff = monthsDiff(primera, { month: nextMonth, year: nextYear });
      if (diff < 0 || diff >= c.cuotasTotales) continue;
      cuotasProximo.push({ ...c, cuotaNumero: diff + 1 });
    }

    // 3. Consumos variables del mes actual con tarjeta (usuario)
    const transactions = await getMonthlyTransactions(month, year);
    const tarjetasUsuario = esMoises
      ? config.tarjetas[config.moisesId]
      : config.tarjetas[config.orianaId];
    const consumosVar = transactions.filter(tx => {
      if (!tarjetasUsuario.includes(tx.metodoPago)) return false;
      // Excluir gastos fijos y cuotas ya contados arriba
      const notas = (tx.notas || '').toLowerCase();
      if (notas.includes('gasto fijo') || notas.includes('cuota')) return false;
      return true;
    });

    // Agrupar totales por tarjeta
    const porTarjeta = {};
    function addToCard(card, moneda, monto) {
      if (!porTarjeta[card]) porTarjeta[card] = { ars: 0, usd: 0, fijos: 0, cuotas: 0, consumos: 0 };
      if (moneda === 'USD') porTarjeta[card].usd += monto;
      else porTarjeta[card].ars += monto;
    }

    for (const g of gastosTarjeta) {
      addToCard(g.metodoPago, g.moneda, g.montoEstimado);
      if (!porTarjeta[g.metodoPago]) porTarjeta[g.metodoPago] = { ars: 0, usd: 0, fijos: 0, cuotas: 0, consumos: 0 };
      porTarjeta[g.metodoPago].fijos++;
    }
    for (const c of cuotasProximo) {
      addToCard(c.tarjeta, c.moneda, c.montoCuota);
      if (!porTarjeta[c.tarjeta]) porTarjeta[c.tarjeta] = { ars: 0, usd: 0, fijos: 0, cuotas: 0, consumos: 0 };
      porTarjeta[c.tarjeta].cuotas++;
    }
    for (const tx of consumosVar) {
      addToCard(tx.metodoPago, tx.moneda, tx.monto);
      if (!porTarjeta[tx.metodoPago]) porTarjeta[tx.metodoPago] = { ars: 0, usd: 0, fijos: 0, cuotas: 0, consumos: 0 };
      porTarjeta[tx.metodoPago].consumos++;
    }

    const mesLabel = `${MESES_CORTO[nextMonth - 1]} ${nextYear}`;
    let text = `🔮 *Estimación tarjetas ${mesLabel} — ${quien}*\n\n`;

    if (Object.keys(porTarjeta).length === 0) {
      text += 'No hay gastos estimados con tarjeta para el próximo mes.';
      return ctx.reply(text, { parse_mode: 'Markdown' });
    }

    let grandTotalArs = 0, grandTotalUsd = 0;

    for (const [card, data] of Object.entries(porTarjeta).sort((a, b) => (b[1].ars + b[1].usd * 1000) - (a[1].ars + a[1].usd * 1000))) {
      text += `*${card}:*`;
      if (data.ars > 0) text += ` ${fmtMonto(data.ars, 'ARS')}`;
      if (data.usd > 0) text += ` + ${fmtMonto(data.usd, 'USD')}`;
      const detalles = [];
      if (data.fijos > 0) detalles.push(`${data.fijos} fijos`);
      if (data.cuotas > 0) detalles.push(`${data.cuotas} cuotas`);
      if (data.consumos > 0) detalles.push(`${data.consumos} consumos`);
      text += `\n  _${detalles.join(' + ')}_\n\n`;

      grandTotalArs += data.ars;
      grandTotalUsd += data.usd;
    }

    text += `🏦 *TOTAL ESTIMADO:*`;
    if (grandTotalArs > 0) text += ` ${fmtMonto(grandTotalArs, 'ARS')}`;
    if (grandTotalUsd > 0) text += ` + ${fmtMonto(grandTotalUsd, 'USD')}`;

    text += `\n\n_Consumos variables basados en ${MESES_CORTO[month - 1]}._`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /proximo:', error.message);
    ctx.reply('Error estimando tarjetas del próximo mes. Revisá los logs.');
  }
}
bot.command('proximo', cmdProximo);

// /puedo — verifica si una compra hipotética encaja con la meta de ahorro mensual
async function cmdPuedo(ctx) {
  try {
    const userId = ctx.from.id;
    const today = getNowBA();
    const text = (ctx.match || '').trim();

    if (!text) {
      return ctx.reply(
        '🛒 *Verificar compra*\n\n' +
        'Escribí qué pensás comprar y te digo si encaja con tu meta de ahorro mensual.\n\n' +
        'Ejemplos:\n' +
        '• `/puedo zapatillas 90000 visa galicia 6 cuotas`\n' +
        '• `/puedo licuadora 50000 banco`\n' +
        '• `/puedo cena 30000 compartido master galicia`\n' +
        '• `/puedo tv 800000 12 cuotas`',
        { parse_mode: 'Markdown' },
      );
    }

    if (!isAiConfigured()) {
      return ctx.reply('IA no configurada — falta OPENAI_API_KEY para parsear la compra.');
    }

    // Reusar el parser de IA existente (las categorías y tarjetas se cargan igual que en registro)
    const cats = await getCategories();
    const cardsUsuario = userId === config.moisesId
      ? config.tarjetas[config.moisesId]
      : config.tarjetas[config.orianaId];
    const parsed = await parseExpense(text, cats.map(c => c.name), cardsUsuario);

    if (parsed.error || !parsed.monto) {
      return ctx.reply(
        '❓ No pude entender la compra.\n\n' +
        'Probá algo como: `/puedo zapatillas 90000 visa galicia 6 cuotas`',
        { parse_mode: 'Markdown' },
      );
    }

    const sim = await simulateAffordability(parsed, userId, today, {
      getFlowData,
      getMonthlyTransactions,
      getPresupuestos,
      getGastosFijos,
      getCuotas,
      filterGastosForUser,
      filterGastosByFrequency,
      filterCuotasForUser,
      getPendingCuotasForMonth,
    });

    await ctx.reply(formatAffordabilityResponse(sim, today), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /puedo:', error.message);
    ctx.reply('Error verificando la compra. Revisá los logs.');
  }
}
bot.command('puedo', cmdPuedo);

// Formatea la respuesta del comando /puedo en Markdown
function formatAffordabilityResponse(sim, today) {
  const { parsed, metodoPago, results, worst, savingsTarget, quien, verdictGlobal } = sim;
  const moneda = parsed.moneda || 'ARS';
  const totalCuotas = results.length > 0 ? results[0].totalCuotas : 1;
  const cuotaMensual = results.length > 0 ? results[0].montoCuota : parsed.monto;

  const tipoLower = (parsed.tipo || '').toLowerCase();
  const compartido = tipoLower === 'compartido';

  let text = `🛒 *Verificar compra — ${quien}*\n`;
  text += `${parsed.descripcion || 'Compra'} — ${fmtMonto(parsed.monto, moneda)}`;
  if (totalCuotas > 1) text += ` en ${totalCuotas} cuotas`;
  if (compartido) text += ` (compartido — tu mitad)`;
  text += `\n`;

  if (metodoPago) {
    text += `💳 Método: ${metodoPago}`;
    if (totalCuotas > 1) text += ` · Cuota mensual: ${fmtMonto(cuotaMensual, moneda)}`;
    text += `\n`;
  }
  text += `🎯 Meta de ahorro: ${fmtMonto(savingsTarget, moneda)}/mes\n\n`;

  // Detalle por mes impactado
  text += `📅 *Impacto por mes:*\n`;
  for (const r of results) {
    const mesLabel = `${MESES_CORTO[r.month - 1]} ${String(r.year).slice(2)}`;
    const emoji = AFFORD_EMOJI[r.verdict];
    const cuotaLabel = r.totalCuotas > 1 ? ` (${r.cuotaNumero}/${r.totalCuotas})` : '';
    text += `• *${mesLabel}*${cuotaLabel}: sobrante ~${fmtMonto(r.sobrante, moneda)}`;
    text += ` − cuota ${fmtMonto(r.montoCuota, moneda)}`;
    text += ` − meta ${fmtMonto(savingsTarget, moneda)}`;
    text += ` = *${fmtMonto(r.libreFinal, moneda)}* ${emoji}\n`;
  }

  text += `\n`;
  const emojiGlobal = AFFORD_EMOJI[verdictGlobal];

  if (verdictGlobal === 'SI') {
    text += `${emojiGlobal} *SÍ podés*\n`;
    text += `Mejor mes: ${fmtMonto(worst.libreFinal, moneda)} libres después de meta y compra.\n`;
  } else if (verdictGlobal === 'JUSTO') {
    const mesPeor = `${MESES_CORTO[worst.month - 1]} ${String(worst.year).slice(2)}`;
    text += `${emojiGlobal} *JUSTO*\n`;
    text += `Peor mes (${mesPeor}): ${fmtMonto(worst.libreFinal, moneda)} libres. Margen muy ajustado.\n`;
  } else {
    const mesPeor = `${MESES_CORTO[worst.month - 1]} ${String(worst.year).slice(2)}`;
    text += `${emojiGlobal} *NO conviene*\n`;
    text += `Peor mes (${mesPeor}): ${fmtMonto(worst.libreFinal, moneda)} (rompe la meta de ahorro).\n`;

    // Sugerencia: probar con más cuotas
    if (totalCuotas < 12 && metodoPago && affordEsTarjeta(metodoPago)) {
      const desc = parsed.descripcion || 'compra';
      text += `\n💡 _Probá: \`/puedo ${desc.toLowerCase()} ${parsed.monto} ${metodoPago.toLowerCase()} 12 cuotas\`_`;
    }
  }

  text += `\n_Estimación basada en datos del Sheet + promedios de últimos meses. Variable real puede diferir._`;
  return text;
}

// /proyeccion [mes] — proyección financiera per-user para un mes futuro
async function cmdProyeccion(ctx) {
  try {
    const userId = ctx.from.id;
    const today = getNowBA();
    const arg = (ctx.match || '').trim();

    let target;
    if (!arg) {
      target = today.month === 12
        ? { month: 1, year: today.year + 1 }
        : { month: today.month + 1, year: today.year };
    } else {
      target = parseMonth(arg);
    }

    const { buildProjection, VERDICT_EMOJI: verdictEmoji } = require('./projection');
    const [fijosRaw, cuotasRaw] = await Promise.all([getGastosFijos(), getCuotas()]);

    const fijosUser = filterGastosForUser(filterGastosByFrequency(fijosRaw, target.month), userId);
    const cuotasUser = filterCuotasForUser(getPendingCuotasForMonth(cuotasRaw, target.month, target.year), userId);

    const proj = await buildProjection(
      target.month, target.year, userId,
      fijosUser, cuotasUser,
      { getFlowData, getMonthlyTransactions, getPresupuestos, cuotasRaw }
    );

    const mesLabel = `${MESES_NOMBRE[target.month - 1]} ${target.year}`;
    const emojiVerdict = verdictEmoji[proj.verdictArs];

    let text = `📅 *Proyección ${mesLabel} — ${proj.quien}*\n\n`;

    // Ingresos
    text += `💰 *INGRESOS*\n`;
    text += `• ARS: ${fmtMonto(proj.incomeArs, 'ARS')}${proj.incomeSource === 'historial' ? ' _(historial)_' : ''}\n`;
    if (proj.incomeUsd > 0) {
      text += `• USD: ${fmtMonto(proj.incomeUsd, 'USD')}`;
      if (proj.tc > 0) {
        const arsDeConversion = proj.usdACambiar * proj.tc;
        text += ` → ${fmtMonto(arsDeConversion, 'ARS')} ARS _(TC ~${fmtMonto(proj.tc, 'ARS')})_`;
      }
      text += `\n`;
      if (proj.quedaDeel > 0) text += `• Queda en Deel: ${fmtMonto(proj.quedaDeel, 'USD')}\n`;
    }
    text += '\n';

    // Gastos fijos
    if (proj.fijoItems.length > 0) {
      text += `📌 *GASTOS FIJOS* (${proj.fijoItems.length} items)\n`;
      for (const f of proj.fijoItems) {
        const tag = f.isCompartido ? ' _(comp. 50%)_' : '';
        text += `• ${f.descripcion}${tag}: ${fmtMonto(f.montoUsuario, f.moneda)}\n`;
      }
      let totalLabel = fmtMonto(proj.fijosArs, 'ARS');
      if (proj.fijosUsd > 0) totalLabel += ` | ${fmtMonto(proj.fijosUsd, 'USD')}`;
      text += `*Total fijos:* ${totalLabel}\n\n`;
    }

    // Cuotas
    if (proj.cuotaItems.length > 0) {
      text += `📦 *CUOTAS ACTIVAS* (${proj.cuotaItems.length} cuotas)\n`;
      for (const c of proj.cuotaItems) {
        const tag = c.isCompartido ? ' _(comp. 50%)_' : '';
        text += `• ${c.descripcion} ${c.cuotaNumero}/${c.cuotasTotales} – ${c.tarjeta}${tag}: ${fmtMonto(c.montoUsuario, 'ARS')}\n`;
      }
      text += `*Total cuotas:* ${fmtMonto(proj.cuotasArs, 'ARS')}\n\n`;
    }

    // Variables estimadas
    const varLabel = proj.fromMonths > 0 ? `prom. ${proj.fromMonths} meses` : 'sin historial';
    text += `📊 *VARIABLES* _(${varLabel})_\n`;
    text += `• ARS: ${fmtMonto(proj.variablesArs, 'ARS')}\n`;
    if (proj.incomeUsd > 0) text += `• USD: ${fmtMonto(proj.variablesUsd, 'USD')}\n`;
    text += '\n';

    // Resumen ARS
    text += `──────────────────────\n`;
    text += `📋 *RESUMEN ARS*\n`;
    text += `Ingresos:     ${fmtMonto(proj.incomeArs, 'ARS')}\n`;
    text += `Gastos est.: −${fmtMonto(proj.gastosArs, 'ARS')}\n`;
    text += `Sobrante:     ${fmtMonto(proj.sobranteArs, 'ARS')}\n`;
    if (proj.metaAhorro > 0) text += `Meta ahorro: −${fmtMonto(proj.metaAhorro, 'ARS')}\n`;
    text += `*Libre: ${fmtMonto(proj.libreArs, 'ARS')} ${emojiVerdict}*\n`;

    // Resumen USD
    if (proj.incomeUsd > 0) {
      text += `\n💵 *RESUMEN USD*\n`;
      text += `Queda Deel:  ${fmtMonto(proj.quedaDeel, 'USD')}\n`;
      text += `Gastos USD: −${fmtMonto(proj.gastosUsd, 'USD')}\n`;
      text += `*Sobrante: ${fmtMonto(proj.sobranteUsd, 'USD')}*\n`;
    }

    text += `\n_Fijos y cuotas: datos del Sheet. Variables: promedio histórico._`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Error en /proyeccion:', e.message);
    ctx.reply('Error calculando proyección. Revisá los logs.');
  }
}
bot.command('proyeccion', cmdProyeccion);

// Construye barra de progreso ASCII (10 caracteres)
function progressBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// /meta — progreso de ahorro vs meta del mes con proyección
async function cmdMeta(ctx) {
  try {
    const userId = ctx.from.id;
    const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
    const today = getNowBA();
    const meta = MESES_CORTO[today.month - 1];

    // Meta de ahorro ARS
    const presupuestos = await getPresupuestos();
    const metaKey = `Ahorro / Inversión|Individual ${quien}|ARS`;
    const goalArs = presupuestos.get(metaKey) || 0;

    if (goalArs === 0) {
      return ctx.reply(
        `🎯 No tenés meta de ahorro configurada en el Presupuesto, ${quien}.\n\n` +
        `Configurala en la hoja "Presupuesto ARS" → tu sección → "Ahorro / Inversión".`
      );
    }

    // Ahorro actual del mes (aportes ARS + aportes USD convertidos por TC)
    const tc = await getLastTC();
    const transactions = await getMonthlyTransactions(today.month, today.year);
    const tipoFilter = `Individual ${quien}`;
    const ahorradoArs = ahorradoEnArs(transactions, tipoFilter, tc);

    // Días del mes y restantes
    const diasMes = new Date(today.year, today.month, 0).getDate();
    const diasPasados = today.day;
    const diasRestantes = diasMes - today.day;

    // Métricas
    const pct = (ahorradoArs / goalArs) * 100;
    const proyeccion = diasPasados > 0 ? (ahorradoArs / diasPasados) * diasMes : 0;
    const faltante = goalArs - ahorradoArs;
    const diarioNecesario = diasRestantes > 0 ? faltante / diasRestantes : faltante;

    let estado, emoji;
    if (ahorradoArs >= goalArs) { estado = '✅ Meta cumplida'; emoji = '✅'; }
    else if (proyeccion >= goalArs) { estado = 'En camino ✓'; emoji = '📈'; }
    else if (pct >= 80) { estado = '⚠️ Justo'; emoji = '⚠️'; }
    else { estado = '❌ Atrasado'; emoji = '❌'; }

    let text = `🎯 *Meta de ahorro — ${meta} ${today.year} (${quien})*\n\n`;
    text += `Meta mensual: *${fmtMonto(goalArs, 'ARS')}*\n`;
    text += `Ahorrado a hoy (${today.day}/${today.month}): *${fmtMonto(ahorradoArs, 'ARS')}*\n`;
    text += `Progreso: \`${progressBar(pct)}\` ${Math.round(pct)}%\n`;
    text += `Días restantes: ${diasRestantes}\n\n`;

    text += `📈 *Al ritmo actual:*\n`;
    text += `• Proyección fin de mes: ${fmtMonto(proyeccion, 'ARS')}\n`;
    text += `• Estado: ${estado}\n\n`;

    if (faltante > 0 && diasRestantes > 0) {
      text += `💡 Necesitás *${fmtMonto(diarioNecesario, 'ARS')}*/día para llegar a la meta.\n\n`;
    } else if (faltante <= 0) {
      text += `🎉 Ya cumpliste la meta (excedente: ${fmtMonto(-faltante, 'ARS')}).\n\n`;
    }

    // Histórico últimos 3 meses
    const historico = [];
    let hm = today.month, hy = today.year;
    for (let i = 0; i < 3; i++) {
      if (hm === 1) { hm = 12; hy--; } else hm--;
      try {
        const txs = await getMonthlyTransactions(hm, hy);
        const tot = ahorradoEnArs(txs, tipoFilter, tc);
        historico.push({ m: hm, y: hy, tot });
      } catch (e) { /* skip */ }
    }

    if (historico.length > 0) {
      text += `📊 *Histórico:*\n`;
      for (const h of historico.reverse()) {
        const histPct = goalArs > 0 ? Math.round((h.tot / goalArs) * 100) : 0;
        const histEmoji = h.tot >= goalArs ? '✅' : histPct >= 80 ? '⚠️' : '❌';
        text += `• ${MESES_CORTO[h.m - 1]} ${String(h.y).slice(2)}: ${histEmoji} ${fmtMonto(h.tot, 'ARS')} _(${histPct}%)_\n`;
      }
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error en /meta:', error.message);
    ctx.reply('Error consultando meta de ahorro. Revisá los logs.');
  }
}
bot.command('meta', cmdMeta);

// /borrar — muestra ultimas transacciones para elegir cual borrar
async function cmdBorrar(ctx) {
  try {
    const transactions = await getLastTransactions(5);

    if (transactions.length === 0) {
      return ctx.reply('No hay transacciones para borrar.');
    }

    cleanMap(pendingDeletes);
    const delId = ++txCounter;

    pendingDeletes.set(delId, {
      transactions,
      userId: ctx.from.id,
      createdAt: Date.now(),
    });

    let text = '🗑️ *¿Cuál querés borrar?*\n\n';
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const fechaCorta = tx.fecha.substring(0, 5);
      text += `${i + 1}. ${fechaCorta} — ${tx.descripcion} — ${fmtMonto(tx.monto, tx.moneda)}\n`;
    }

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < transactions.length; i++) {
      keyboard.text(`${i + 1}`, `del_pick:${delId}:${i}`);
    }
    keyboard.text('❌ Cancelar', `del_no:${delId}`);

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /borrar:', error.message);
    ctx.reply('Error consultando transacciones. Revisá los logs.');
  }
}
bot.command('borrar', cmdBorrar);

// /saldar — muestra gastos compartidos pendientes para marcar como saldados
async function cmdSaldar(ctx) {
  try {
    const unsettled = await getSharedUnsettled();

    if (unsettled.length === 0) {
      return ctx.reply('✅ No hay gastos compartidos pendientes de saldar.');
    }

    cleanMap(pendingSettle);
    const salId = ++txCounter;

    // Máximo 10 items más recientes
    const items = unsettled.slice(0, 10);

    pendingSettle.set(salId, {
      items,
      userId: ctx.from.id,
      createdAt: Date.now(),
    });

    // Agrupar por mes/año para mostrar organizado
    const groups = {};
    for (const tx of items) {
      const parts = tx.fecha.split('/');
      const key = parts.length === 3 ? `${parts[1]}/${parts[2]}` : 'Otro';
      if (!groups[key]) groups[key] = [];
      groups[key].push(tx);
    }

    let text = '🤝 *Saldar gastos compartidos*\n';
    let idx = 0;
    for (const [mesAnio, txs] of Object.entries(groups)) {
      const parts = mesAnio.split('/');
      const mesNum = parseInt(parts[0]);
      const mesNombre = MESES_CORTO[mesNum - 1] || mesAnio;
      const anio = parts[1] || '';
      text += `\n*${mesNombre} ${anio}:*\n`;
      for (const tx of txs) {
        const fechaCorta = tx.fecha.substring(0, 5);
        // Calcular deuda: quien NO pagó debe su porcentaje
        let deuda;
        if (tx.pagadoPor === 'Moises') {
          deuda = `Oriana debe ${fmtMonto(tx.monto * tx.splitOriana / 100, 'ARS')}`;
        } else {
          deuda = `Moises debe ${fmtMonto(tx.monto * tx.splitMoises / 100, 'ARS')}`;
        }
        text += `${idx + 1}. ${fechaCorta} — ${tx.descripcion} — ${fmtMonto(tx.monto, 'ARS')} (${deuda})\n`;
        idx++;
      }
    }

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < items.length; i++) {
      keyboard.text(`${i + 1}`, `sal_pick:${salId}:${i}`);
      if ((i + 1) % 5 === 0) keyboard.row();
    }
    if (items.length % 5 !== 0) keyboard.row();
    keyboard.text('✅ Saldar todo', `sal_all:${salId}`).text('❌ Cancelar', `sal_no:${salId}`);

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /saldar:', error.message);
    ctx.reply('Error consultando gastos compartidos. Revisá los logs.');
  }
}
bot.command('saldar', cmdSaldar);


// ============================================
// /crypto — Portafolio de criptomonedas
// ============================================

function fmtUsd(n) {
  return 'US$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function cmdCrypto(ctx) {
  try {
    cleanMap(pendingCrypto);
    const holdings = await getCryptoHoldings();
    const activos = holdings.filter(h => h.cantidad > 0);

    if (activos.length === 0) {
      const keyboard = new InlineKeyboard()
        .text('➕ Compra', 'crypto_buy');
      return ctx.reply(
        '💎 *Portafolio Crypto*\n\nNo hay holdings registrados.',
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }

    let text = '💎 *Portafolio Crypto*\n\n';
    let totalUsd = 0;

    for (const h of activos) {
      text += `*${h.nombre} (${h.simbolo})*\n`;
      text += `📊 ${h.cantidad} ${h.simbolo}\n`;
      if (h.precioUsd > 0) {
        text += `💲 Precio: ${fmtUsd(h.precioUsd)}\n`;
        text += `💰 Valor: ${fmtUsd(h.valorUsd)}\n`;
      } else {
        text += `💲 Precio: N/A\n`;
      }
      text += `📍 ${h.plataforma}\n\n`;
      totalUsd += h.valorUsd || 0;
    }

    text += `*Total: ${fmtUsd(totalUsd)}*`;

    const keyboard = new InlineKeyboard()
      .text('➕ Compra', 'crypto_buy')
      .text('➖ Venta', 'crypto_sell')
      .row()
      .text('📜 Historial', 'crypto_hist');

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /crypto:', error.message);
    ctx.reply('Error consultando crypto. Revisá los logs.');
  }
}
bot.command('crypto', cmdCrypto);

// Callback: iniciar compra crypto
bot.callbackQuery('crypto_buy', async (ctx) => {
  pendingCrypto.set(ctx.from.id, { action: 'buy_waiting', createdAt: Date.now() });
  await ctx.editMessageText(
    '➕ *Compra Crypto*\n\n' +
    'Escribí la compra:\n' +
    '`cantidad simbolo precio plataforma`\n\n' +
    'Ejemplo: `0.05 ETH 2650 Bybit`',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Callback: iniciar venta crypto
bot.callbackQuery('crypto_sell', async (ctx) => {
  pendingCrypto.set(ctx.from.id, { action: 'sell_waiting', createdAt: Date.now() });
  await ctx.editMessageText(
    '➖ *Venta Crypto*\n\n' +
    'Escribí la venta:\n' +
    '`cantidad simbolo precio plataforma`\n\n' +
    'Ejemplo: `0.02 ETH 2800 Bybit`',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Callback: historial crypto
bot.callbackQuery('crypto_hist', async (ctx) => {
  try {
    const transactions = await getCryptoTransactions(10);
    if (transactions.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Sin movimientos' });
      return;
    }
    let text = '📜 *Últimos movimientos crypto*\n\n';
    for (const tx of transactions) {
      const emoji = tx.tipo === 'Compra' ? '🟢' : '🔴';
      text += `${emoji} ${tx.fecha} — ${tx.tipo} ${tx.cantidad} ${tx.crypto} a ${fmtUsd(tx.precioUsd)} (${tx.plataforma})\n`;
    }
    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error('Error historial crypto:', error.message);
    await ctx.answerCallbackQuery({ text: 'Error' });
  }
});

// Callback: confirmar operación crypto
bot.callbackQuery(/^crypto_ok:(\d+)$/, async (ctx) => {
  const cryptoId = parseInt(ctx.match[1]);
  const pending = pendingCrypto.get(cryptoId);
  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'No autorizado.' });

  pendingCrypto.delete(cryptoId);

  try {
    const { month, year, day } = getNowBA();
    const fechaStr = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    const now = new Date();
    const horaStr = now.toLocaleTimeString('en-US', {
      timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false,
    });

    await appendCryptoTransaction({
      fecha: fechaStr,
      hora: horaStr,
      tipo: pending.tipo,
      crypto: pending.simbolo,
      cantidad: pending.cantidad,
      precioUsd: pending.precio,
      plataforma: pending.plataforma,
      notas: '',
    });

    // Si es crypto nueva, agregarla a holdings
    const holdings = await getCryptoHoldings();
    const exists = holdings.some(h => h.simbolo === pending.simbolo);
    if (!exists) {
      await addCryptoHolding(pending.simbolo, pending.plataforma);
    }

    const emoji = pending.tipo === 'Compra' ? '🟢' : '🔴';
    await ctx.editMessageText(
      `✅ *${pending.tipo} registrada*\n\n` +
      `${emoji} ${pending.cantidad} ${pending.simbolo} a ${fmtUsd(pending.precio)} = ${fmtUsd(pending.total)}\n` +
      `📍 ${pending.plataforma}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: `${pending.tipo} registrada` });
  } catch (error) {
    console.error('Error registrando crypto:', error.message);
    await ctx.editMessageText('Error registrando. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error' });
  }
});

// Callback: cancelar operación crypto
bot.callbackQuery(/^crypto_no:(\d+)$/, async (ctx) => {
  const cryptoId = parseInt(ctx.match[1]);
  pendingCrypto.delete(cryptoId);
  await ctx.editMessageText('Operación cancelada.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});


// ============================================
// /inversiones — Portafolio de inversiones (PPI)
// ============================================

async function cmdInversiones(ctx) {
  try {
    cleanMap(pendingInversiones);
    const { tipos, total } = await getInversiones();

    if (tipos.length === 0 && total === 0) {
      return ctx.reply(
        '📈 *Portafolio de Inversiones*\n\nNo hay inversiones registradas.',
        { parse_mode: 'Markdown' }
      );
    }

    let text = '📈 *Portafolio de Inversiones*\n\n';
    text += `💼 *Total: ${fmtMonto(total, 'ARS')}*\n`;
    text += '📍 PPI (Portfolio Personal)\n\n';

    if (tipos.length > 0) {
      text += '*Composición:*\n';
      for (const t of tipos) {
        const pct = (t.porcentaje * 100).toFixed(2).replace('.', ',');
        text += `📊 ${t.tipo} — ${pct}% (${fmtMonto(t.valorArs, 'ARS')})\n`;
      }
      text += '\n';
    }

    // Última actualización del historial
    const hist = await getInversionesHistorial(1);
    if (hist.length > 0) {
      text += `📅 Última act: ${hist[0].fecha}`;
    }

    const keyboard = new InlineKeyboard()
      .text('📝 Actualizar', 'inv_update')
      .text('📜 Historial', 'inv_hist');

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /inversiones:', error.message);
    ctx.reply('Error consultando inversiones. Revisá los logs.');
  }
}
bot.command('inversiones', cmdInversiones);

// Callback: iniciar actualización de inversiones
bot.callbackQuery('inv_update', async (ctx) => {
  pendingInversiones.set(ctx.from.id, { action: 'update_waiting', createdAt: Date.now() });
  await ctx.editMessageText(
    '📝 *Actualizar Inversiones*\n\n' +
    'Escribí el valor total actual.\n' +
    'Opcionalmente incluí los porcentajes.\n\n' +
    'Ejemplos:\n' +
    '`650000`\n' +
    '`650000 15 28 57`',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Callback: historial de inversiones
bot.callbackQuery('inv_hist', async (ctx) => {
  try {
    const entries = await getInversionesHistorial(10);
    if (entries.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Sin historial' });
      return;
    }
    let text = '📜 *Historial de inversiones*\n\n';
    for (const e of entries) {
      const variacion = e.variacion > 0 ? `+${fmtMonto(e.variacion, 'ARS')}` :
                         e.variacion < 0 ? fmtMonto(e.variacion, 'ARS') : '';
      const varText = variacion ? ` (${variacion})` : '';
      text += `📅 ${e.fecha} — ${fmtMonto(e.valorTotal, 'ARS')}${varText}\n`;
      if (e.notas) text += `   _${e.notas}_\n`;
    }
    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error('Error historial inversiones:', error.message);
    await ctx.answerCallbackQuery({ text: 'Error' });
  }
});

// Callback: confirmar actualización de inversiones
bot.callbackQuery(/^inv_ok:(\d+)$/, async (ctx) => {
  const invId = parseInt(ctx.match[1]);
  const pending = pendingInversiones.get(invId);
  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'No autorizado.' });

  pendingInversiones.delete(invId);

  try {
    const { month, year, day } = getNowBA();
    const fechaStr = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;

    await updateInversiones(pending.total, pending.porcentajes);
    await appendInversionesHistorial(fechaStr, pending.total, pending.notas || '');

    let text = `✅ *Inversiones actualizadas*\n\n💼 Total: ${fmtMonto(pending.total, 'ARS')}`;
    if (pending.porcentajes) {
      text += '\n\n*Porcentajes actualizados:*';
      const nombres = ['Acciones', 'CEDEARs', 'FCIs'];
      for (let i = 0; i < pending.porcentajes.length; i++) {
        const nombre = nombres[i] || `Tipo ${i + 1}`;
        text += `\n📊 ${nombre} — ${pending.porcentajes[i]}%`;
      }
    }

    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: 'Actualizado' });
  } catch (error) {
    console.error('Error actualizando inversiones:', error.message);
    await ctx.editMessageText('Error actualizando. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error' });
  }
});

// Callback: cancelar actualización de inversiones
bot.callbackQuery(/^inv_no:(\d+)$/, async (ctx) => {
  const invId = parseInt(ctx.match[1]);
  pendingInversiones.delete(invId);
  await ctx.editMessageText('Actualización cancelada.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});


// ============================================
// /ahorro — Ahorro total: Deel USD + ARS Banco + Crypto + Inversiones
// ============================================

async function cmdAhorro(ctx) {
  try {
    cleanMap(pendingAhorro);

    const [cuentas, tc, holdings, inv] = await Promise.all([
      getAhorroCuentas(),
      getLastTC(),
      getCryptoHoldings(),
      getInversiones(),
    ]);

    const { month, year } = getNowBA();
    const mesStr = MESES_NOMBRE[month - 1].charAt(0).toUpperCase() + MESES_NOMBRE[month - 1].slice(1);

    const cryptoTotalUsd = holdings.reduce((sum, h) => sum + h.valorUsd, 0);
    const tcEfectivo = tc > 0 ? tc : 1;

    const deelArs = cuentas.deelUsd.saldo * tcEfectivo;
    const cryptoArs = cryptoTotalUsd * tcEfectivo;
    const invArs = inv.total;
    const totalArs = deelArs + cuentas.arsBanco.saldo + cryptoArs + invArs;
    const totalUsd = cuentas.deelUsd.saldo + (cuentas.arsBanco.saldo / tcEfectivo) + cryptoTotalUsd + (invArs / tcEfectivo);

    let text = `🏦 *Ahorro Total — ${mesStr} ${year}*\n\n`;

    text += `💵 *Cuentas líquidas*\n`;
    text += `• Deel USD: ${fmtMonto(cuentas.deelUsd.saldo, 'USD')}`;
    if (tc > 0) text += ` → ~${fmtMonto(deelArs, 'ARS')}`;
    text += '\n';
    if (cuentas.deelUsd.fecha && cuentas.deelUsd.fecha !== '-') {
      text += `  _Act: ${cuentas.deelUsd.fecha}_\n`;
    }
    text += `• ARS Banco: ${fmtMonto(cuentas.arsBanco.saldo, 'ARS')}\n`;
    if (cuentas.arsBanco.fecha && cuentas.arsBanco.fecha !== '-') {
      text += `  _Act: ${cuentas.arsBanco.fecha}_\n`;
    }

    text += `\n📊 *Portafolio*\n`;
    text += `• Crypto: ${fmtMonto(cryptoTotalUsd, 'USD')}`;
    if (tc > 0 && cryptoTotalUsd > 0) text += ` → ~${fmtMonto(cryptoArs, 'ARS')}`;
    text += '\n';
    text += `• Inversiones PPI: ${fmtMonto(invArs, 'ARS')}\n`;

    text += `\n💼 *Total estimado*\n`;
    text += `~${fmtMonto(totalArs, 'ARS')} / ~${fmtMonto(totalUsd, 'USD')}`;
    if (tc > 0) text += `\n_(TC: ${fmtMonto(tc, 'ARS')})_`;

    const keyboard = new InlineKeyboard()
      .text('📥 Registré aporte', 'sav_aporte').row()
      .text('💵 Actualizar Deel USD', 'sav_deel').row()
      .text('🏦 Actualizar ARS Banco', 'sav_banco');

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /ahorro:', error.message);
    ctx.reply('Error consultando ahorro. Revisá los logs.');
  }
}
bot.command('ahorro', cmdAhorro);

// Callback: solicitar nuevo saldo Deel USD
bot.callbackQuery('sav_deel', async (ctx) => {
  pendingAhorro.set(ctx.from.id, { cuenta: 'deelUsd', action: 'update_waiting', createdAt: Date.now() });
  await ctx.editMessageText(
    '💵 *Actualizar Deel USD*\n\nEscribí el saldo actual en USD.\nEjemplo: `3500` o `3500,50`',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Callback: solicitar nuevo saldo ARS Banco
bot.callbackQuery('sav_banco', async (ctx) => {
  pendingAhorro.set(ctx.from.id, { cuenta: 'arsBanco', action: 'update_waiting', createdAt: Date.now() });
  await ctx.editMessageText(
    '🏦 *Actualizar ARS Banco*\n\nEscribí el saldo actual en ARS.\nEjemplo: `250000` o `250.000`',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Callback: confirmar actualización de ahorro
bot.callbackQuery(/^sav_ok:(\d+)$/, async (ctx) => {
  const savId = parseInt(ctx.match[1]);
  const pending = pendingAhorro.get(savId);
  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'No autorizado.' });

  pendingAhorro.delete(savId);

  try {
    const { month, year, day } = getNowBA();
    const fechaStr = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    await updateAhorroCuenta(pending.cuenta, pending.saldo, fechaStr);

    const nombreCuenta = pending.cuenta === 'deelUsd' ? 'Deel USD' : 'ARS Banco';
    const moneda = pending.cuenta === 'deelUsd' ? 'USD' : 'ARS';
    await ctx.editMessageText(
      `✅ *Ahorro actualizado*\n\n${nombreCuenta}: ${fmtMonto(pending.saldo, moneda)}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: 'Actualizado' });
  } catch (error) {
    console.error('Error actualizando ahorro:', error.message);
    await ctx.editMessageText('Error actualizando. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error' });
  }
});

// Callback: cancelar actualización de ahorro
bot.callbackQuery(/^sav_no:(\d+)$/, async (ctx) => {
  const savId = parseInt(ctx.match[1]);
  pendingAhorro.delete(savId);
  await ctx.editMessageText('Actualización cancelada.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});

// Callback: registrar aporte de ahorro → elegir cuenta
bot.callbackQuery('sav_aporte', async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text('💵 Deel USD', 'apo_deel').row()
    .text('🏦 ARS Banco', 'apo_banco');
  await ctx.editMessageText(
    '📥 *Registrar aporte de ahorro*\n\n¿A qué cuenta lo apartaste?',
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
  await ctx.answerCallbackQuery();
});

// Callbacks: elegir cuenta del aporte y pedir monto
bot.callbackQuery('apo_deel', async (ctx) => {
  pendingAhorro.set(ctx.from.id, { cuenta: 'deelUsd', action: 'aporte_waiting', createdAt: Date.now() });
  await ctx.editMessageText(
    '💵 *Aporte a Deel USD*\n\nEscribí cuánto aportaste en USD.\nEjemplo: `500` o `500,50`',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('apo_banco', async (ctx) => {
  pendingAhorro.set(ctx.from.id, { cuenta: 'arsBanco', action: 'aporte_waiting', createdAt: Date.now() });
  await ctx.editMessageText(
    '🏦 *Aporte a ARS Banco*\n\nEscribí cuánto aportaste en ARS.\nEjemplo: `600000` o `600.000`',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Callback: confirmar aporte → crea transacción de ahorro + suma al saldo de la cuenta
bot.callbackQuery(/^apo_ok:(\d+)$/, async (ctx) => {
  const apoId = parseInt(ctx.match[1]);
  const pending = pendingAhorro.get(apoId);
  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'No autorizado.' });

  pendingAhorro.delete(apoId);

  try {
    const { month, year, day } = getNowBA();
    const fecha = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    const hora = new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false });
    const quien = pending.userId === config.moisesId ? 'Moises' : 'Oriana';
    const isDeelUsd = pending.cuenta === 'deelUsd';
    const moneda = isDeelUsd ? 'USD' : 'ARS';
    const metodoPago = isDeelUsd ? 'Deel USD' : 'Banco';

    // 1. Registrar la transacción que alimenta la meta de ahorro
    await appendTransaction({
      fecha, hora,
      descripcion: 'Aporte ahorro',
      categoria: 'Ahorro / Inversión',
      monto: pending.monto,
      moneda,
      metodoPago,
      tipo: `Individual ${quien}`,
      pagadoPor: quien,
      splitMoises: quien === 'Moises' ? 100 : 0,
      splitOriana: quien === 'Oriana' ? 100 : 0,
      notas: '',
    });

    // 2. Sumar el aporte al saldo de la cuenta en la hoja Ahorro
    const cuentas = await getAhorroCuentas();
    const saldoActual = cuentas[pending.cuenta].saldo;
    const nuevoSaldo = saldoActual + pending.monto;
    await updateAhorroCuenta(pending.cuenta, nuevoSaldo, fecha);

    const nombreCuenta = isDeelUsd ? 'Deel USD' : 'ARS Banco';
    let text = `✅ *Aporte registrado*\n\n` +
      `${nombreCuenta}: +${fmtMonto(pending.monto, moneda)}\n` +
      `Nuevo saldo: ${fmtMonto(nuevoSaldo, moneda)}`;
    if (isDeelUsd) {
      const tc = await getLastTC();
      if (tc > 0) text += `\n\n_Cuenta para la meta como ~${fmtMonto(pending.monto * tc, 'ARS')} (TC ${fmtMonto(tc, 'ARS')})._`;
    }
    text += `\n\nMirá tu progreso con /meta`;

    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: 'Aporte registrado' });
  } catch (error) {
    console.error('Error registrando aporte:', error.message);
    await ctx.editMessageText('Error registrando el aporte. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error' });
  }
});

// Callback: cancelar aporte
bot.callbackQuery(/^apo_no:(\d+)$/, async (ctx) => {
  const apoId = parseInt(ctx.match[1]);
  pendingAhorro.delete(apoId);
  await ctx.editMessageText('Aporte cancelado.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});


// /gasto — wizard interactivo para carga manual paso a paso
async function cmdGasto(ctx) {
  try {
    const userId = ctx.from.id;
    pendingManual.delete(userId);
    cleanMap(pendingManual);

    const categories = await getCategories();
    const manualId = ++txCounter;
    pendingManual.set(userId, {
      id: manualId,
      step: 'category',
      data: {},
      createdAt: Date.now(),
    });

    const keyboard = new InlineKeyboard();
    categories.forEach((cat, i) => {
      keyboard.text(cat.name, `mg_cat:${manualId}:${i}`);
      if (i % 2 === 1) keyboard.row();
    });
    if (categories.length % 2 === 1) keyboard.row();
    keyboard.text('❌ Cancelar', `mg_no:${manualId}`);

    const method = ctx.callbackQuery ? 'editMessageText' : 'reply';
    await ctx[method](
      '📋 *Nuevo gasto — Paso 1/6*\n\nElegí la categoría:',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  } catch (error) {
    console.error('Error en cmdGasto:', error.message);
    ctx.reply('Error iniciando el wizard. Revisá los logs.');
  }
}
bot.command('gasto', cmdGasto);

// Submenú Registrar: muestra opciones "Nuevo gasto" y "Gastos fijos"
async function cmdRegistrarMenu(ctx) {
  const keyboard = new InlineKeyboard()
    .text('💰 Nuevo gasto', 'registrar_gasto')
    .text('📋 Gastos fijos', 'registrar_fijos_btn');
  await ctx.reply('*¿Qué querés registrar?*', { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.callbackQuery('registrar_gasto', async (ctx) => {
  await ctx.answerCallbackQuery();
  await cmdGasto(ctx);
});

bot.callbackQuery('registrar_fijos_btn', async (ctx) => {
  await ctx.answerCallbackQuery();
  await cmdRegistrarFijos(ctx);
});

// Mapa de handlers para el menú persistente
const CMD_HANDLERS = {
  start: cmdStart,
  balance: cmdBalance,
  resumen: cmdResumen,
  ultimas: cmdUltimas,
  flujo: cmdFlujo,
  registrar_fijos: cmdRegistrarFijos,
  registrar_menu: cmdRegistrarMenu,
  gasto: cmdGasto,
  saldar: cmdSaldar,
  proximo: cmdProximo,
  proyeccion: cmdProyeccion,
  ahorro: cmdAhorro,
};

// /ingreso [monto] [descripcion] — registrar ingreso extra
bot.command('ingreso', async (ctx) => {
  try {
    const args = (ctx.match || '').trim().split(/\s+/);
    const montoStr = args[0];
    const descripcion = args.slice(1).join(' ') || 'Ingreso extra';

    if (!montoStr) {
      return ctx.reply(
        'Formato: /ingreso [monto] [descripción]\n\n' +
        'Ejemplos:\n' +
        '• /ingreso 500 bonus\n' +
        '• /ingreso 50000 freelance'
      );
    }

    // Parsear monto (soportar punto miles y coma decimal)
    let monto;
    if (/^\d{1,3}(\.\d{3})+$/.test(montoStr)) {
      monto = parseFloat(montoStr.replace(/\./g, ''));
    } else if (/^\d+,\d+$/.test(montoStr)) {
      monto = parseFloat(montoStr.replace(',', '.'));
    } else {
      monto = parseFloat(montoStr);
    }

    if (!monto || monto <= 0) {
      return ctx.reply('Monto inválido.');
    }

    const isMoises = ctx.from.id === config.moisesId;
    const moneda = isMoises ? 'USD' : 'ARS';
    const quien = isMoises ? 'Moises' : 'Oriana';

    cleanMap(pendingIncome);
    const incId = ++txCounter;
    const { month, year } = getNowBA();

    pendingIncome.set(incId, {
      monto,
      moneda,
      quien: isMoises ? 'moises' : 'oriana',
      month,
      descripcion,
      userId: ctx.from.id,
      createdAt: Date.now(),
    });

    const text =
      `💰 *Ingreso extra*\n\n` +
      `👤 ${quien}\n` +
      `💵 ${fmtMonto(monto, moneda)}\n` +
      `📝 ${descripcion}\n` +
      `Se suma al ingreso de ${MESES_CORTO[month - 1]} ${year}\n\n` +
      `¿Confirmar?`;

    const keyboard = new InlineKeyboard()
      .text('✅ Confirmar', `inc_ok:${incId}`)
      .text('❌ Cancelar', `inc_no:${incId}`);

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /ingreso:', error.message);
    ctx.reply('Error procesando el ingreso. Revisá los logs.');
  }
});

// /cotizacion [monto] — registra ingresos del mes con la cotizacion del dia
bot.command('cotizacion', async (ctx) => {
  try {
    const inc = config.income;
    if (!inc.moisesSalaryUsd || !inc.moisesSalaryArs) {
      return ctx.reply('Faltan variables de entorno: MOISES_SALARY_USD y MOISES_SALARY_ARS.');
    }

    const parts = (ctx.match || '').trim().split(/\s+/);
    const tcStr = parts[0] || '';
    const overrideStr = parts[1] || '';

    if (!tcStr) {
      return ctx.reply(
        'Formato: /cotizacion [tipo de cambio] [usd a cambiar]\n\n' +
        'Ejemplo: /cotizacion 1350\n' +
        'Ejemplo: /cotizacion 1350 1500  ← fuerza 1500 USD a cambiar\n\n' +
        'El segundo parámetro es opcional. Si no se pone, calcula automáticamente.'
      );
    }

    // Parsear TC (soportar punto miles)
    let tc;
    if (/^\d{1,3}(\.\d{3})+$/.test(tcStr)) {
      tc = parseFloat(tcStr.replace(/\./g, ''));
    } else if (/^\d+,\d+$/.test(tcStr)) {
      tc = parseFloat(tcStr.replace(',', '.'));
    } else {
      tc = parseFloat(tcStr);
    }

    if (!tc || tc <= 0) {
      return ctx.reply('Cotización inválida.');
    }

    // Parsear override de USD a cambiar (opcional, aplica a quien ejecuta el comando)
    let overrideUsd = null;
    if (overrideStr) {
      const parsed = parseFloat(overrideStr.replace(/\./g, '').replace(',', '.'));
      if (parsed && parsed > 0) overrideUsd = parsed;
    }
    const isMoises = ctx.from.id === config.moisesId;
    const mOverrideUsd = isMoises ? overrideUsd : null;
    const oOverrideUsd = !isMoises ? overrideUsd : null;

    const { month, year } = getNowBA();

    // Verificar si ya hay ingresos registrados para este mes
    const status = await getIncomeStatus(month);
    const isUpdate = status.moises;

    // Calcular breakdown para Moises
    const mUsdExacto = inc.moisesSalaryArs / tc;
    let mUsdRedondeado, mExtraUsd, mQuedaDeel;
    if (mOverrideUsd) {
      mUsdRedondeado = mOverrideUsd;
      mExtraUsd = 0;
      mQuedaDeel = inc.moisesSalaryUsd - mUsdRedondeado;
    } else {
      mUsdRedondeado = Math.ceil(mUsdExacto / 50) * 50;
      mExtraUsd = mUsdRedondeado - mUsdExacto;
      mQuedaDeel = inc.moisesSalaryUsd - mUsdRedondeado;
    }

    // Calcular breakdown para Oriana (si tiene datos)
    let oUsdExacto = 0, oUsdRedondeado = 0, oExtraUsd = 0, oQuedaDeel = 0;
    const hasOriana = inc.orianaSalaryUsd && inc.orianaSalaryArs;
    if (hasOriana) {
      oUsdExacto = inc.orianaSalaryArs / tc;
      if (oOverrideUsd) {
        oUsdRedondeado = oOverrideUsd;
        oExtraUsd = 0;
        oQuedaDeel = inc.orianaSalaryUsd - oUsdRedondeado;
      } else {
        oUsdRedondeado = Math.ceil(oUsdExacto / 50) * 50;
        oExtraUsd = oUsdRedondeado - oUsdExacto;
        oQuedaDeel = inc.orianaSalaryUsd - oUsdRedondeado;
      }
    }

    const totalExtraUsd = mExtraUsd + oExtraUsd;

    const cotizId = ++txCounter;
    cleanMap(pendingIncome);

    pendingIncome.set(cotizId, {
      type: 'cotizacion',
      month,
      year,
      tc,
      moises: { usdRedondeado: mUsdRedondeado, quedaDeel: mQuedaDeel, extraUsd: mExtraUsd },
      oriana: hasOriana ? { usdRedondeado: oUsdRedondeado, quedaDeel: oQuedaDeel, extraUsd: oExtraUsd } : null,
      totalExtraUsd,
      isUpdate,
      userId: ctx.from.id,
      createdAt: Date.now(),
    });

    // Construir preview
    let text =
      `💱 *Cotización ${MESES_CORTO[month - 1]} ${year}*\n\n` +
      `TC: $${tc.toLocaleString('es-AR')}\n\n` +
      `*Moises:*\n` +
      `• Salario: ${fmtMonto(inc.moisesSalaryUsd, 'USD')}\n` +
      `• Salario ARS: ${fmtMonto(inc.moisesSalaryArs, 'ARS')}\n` +
      `• USD exacto: ${fmtMonto(mUsdExacto, 'USD')}\n` +
      `• USD a cambiar: ${fmtMonto(mUsdRedondeado, 'USD')} ${mOverrideUsd ? '(manual)' : '(redondeado ↑50)'}\n` +
      `• Queda en Deel: ${fmtMonto(mQuedaDeel, 'USD')}\n`;

    if (mExtraUsd > 0.01) {
      text += `• Extra: ${fmtMonto(mExtraUsd, 'USD')}\n`;
    }

    if (hasOriana) {
      text += `\n*Oriana:*\n` +
        `• Salario: ${fmtMonto(inc.orianaSalaryUsd, 'USD')}\n` +
        `• Salario ARS: ${fmtMonto(inc.orianaSalaryArs, 'ARS')}\n` +
        `• USD exacto: ${fmtMonto(oUsdExacto, 'USD')}\n` +
        `• USD a cambiar: ${fmtMonto(oUsdRedondeado, 'USD')} ${oOverrideUsd ? '(manual)' : '(redondeado ↑50)'}\n` +
        `• Queda en Deel: ${fmtMonto(oQuedaDeel, 'USD')}\n`;

      if (oExtraUsd > 0.01) {
        text += `• Extra: ${fmtMonto(oExtraUsd, 'USD')}\n`;
      }
    }

    if (totalExtraUsd > 0.01) {
      text += `\n📝 Extra total: ${fmtMonto(totalExtraUsd, 'USD')} (se registra como transacción)\n`;
    }

    if (isUpdate) {
      text += '\n⚠️ Ya hay ingresos registrados para este mes. Se van a actualizar los datos anteriores.';
      text += '\n\n¿Actualizar ingresos del mes?';
    } else {
      text += '\n¿Registrar ingresos del mes?';
    }

    const keyboard = new InlineKeyboard()
      .text(isUpdate ? '✅ Actualizar' : '✅ Registrar', `cotiz_ok:${cotizId}`)
      .text('❌ Cancelar', `cotiz_no:${cotizId}`);

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (error) {
    console.error('Error en /cotizacion:', error.message);
    ctx.reply('Error procesando la cotización. Revisá los logs.');
  }
});

// ============================================
// HELPERS IA — construir tx y preview desde resultado de IA
// ============================================

// Métodos de pago para botones de selección
const AI_PAYMENT_METHODS = ['Tarjeta', 'Banco', 'Efectivo', 'Deel Card'];

// Construye un objeto tx a partir del resultado de parseExpense/analyzeReceipt.
function buildTxFromAi(aiResult, senderId) {
  const pagadoPor = senderId === config.orianaId ? 'Oriana' : 'Moises';

  // Tipo: si la IA dijo "Compartido", usar. Si null, default individual.
  let tipo;
  if (aiResult.tipo === 'Compartido') {
    tipo = 'Compartido';
  } else {
    tipo = senderId === config.orianaId ? 'Individual Oriana' : 'Individual Moises';
  }

  let splitMoises, splitOriana;
  if (tipo === 'Compartido') {
    splitMoises = 50; splitOriana = 50;
  } else if (tipo === 'Individual Oriana') {
    splitMoises = 0; splitOriana = 100;
  } else {
    splitMoises = 100; splitOriana = 0;
  }

  // Método de pago: normalizar lo que diga la IA
  let metodoPago = aiResult.metodoPago || null;
  if (metodoPago) {
    // Si la IA devolvió un nombre exacto de tarjeta, usarlo directo
    if (config.todasLasTarjetas.includes(metodoPago)) {
      // OK, es nombre exacto
    } else {
      const mp = metodoPago.toLowerCase();
      if (mp.includes('efectivo')) metodoPago = 'Efectivo';
      else if (mp.includes('deel') && mp.includes('usd')) metodoPago = 'Deel USD';
      else if (mp.includes('deel')) metodoPago = 'Deel Card';
      else if (mp.includes('banco') || mp.includes('debito') || mp.includes('débito') || mp.includes('transferencia')) metodoPago = 'Banco';
      else if (mp.includes('tarjeta') || mp.includes('credito') || mp.includes('crédito') || mp.includes('visa') || mp.includes('master')) {
        // Intentar resolver a tarjeta específica por marca
        const userCards = config.tarjetas[senderId] || [];
        const brand = mp.includes('visa') ? 'visa' : mp.includes('master') ? 'master' : null;
        if (brand) {
          const matches = userCards.filter(c => c.toLowerCase().includes(brand));
          metodoPago = matches.length === 1 ? matches[0] : 'Tarjeta';
        } else {
          metodoPago = 'Tarjeta';
        }
      }
      else metodoPago = null; // no reconocido, preguntar
    }
  }

  const descripcion = aiResult.descripcion
    ? aiResult.descripcion.charAt(0).toUpperCase() + aiResult.descripcion.slice(1)
    : 'Gasto';

  const now = new Date();
  const baOpts = { timeZone: 'America/Argentina/Buenos_Aires' };
  const fecha = now.toLocaleDateString('es-AR', { ...baOpts, day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = now.toLocaleTimeString('es-AR', { ...baOpts, hour: '2-digit', minute: '2-digit', hour12: false });

  return {
    fecha, hora, descripcion,
    categoria: aiResult.categoria || 'Otros',
    monto: aiResult.monto,
    moneda: aiResult.moneda || 'ARS',
    metodoPago,
    tipo, pagadoPor,
    splitMoises, splitOriana,
    notas: aiResult.notas || '',
    cuotas: aiResult.cuotas || null,
  };
}

// Muestra preview de tx con botones apropiados. Si falta método de pago, pregunta.
// emoji: "🎙️" para audio, "📷" para foto.
async function showAiTxPreview(ctx, tx, emoji) {
  cleanMap(pendingTx);
  const txId = ++txCounter;
  pendingTx.set(txId, { ...tx, userId: ctx.from.id, createdAt: Date.now() });

  // Si falta método de pago → preguntar con botones (incluye toggle Compartido)
  if (!tx.metodoPago) {
    const preview =
      `*Nuevo gasto* ${emoji}\n\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `👤 ${tx.tipo}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '') +
      `\n\n💳 *¿Con qué pagaste?*`;

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < AI_PAYMENT_METHODS.length; i++) {
      keyboard.text(AI_PAYMENT_METHODS[i], `ap:${txId}:${i}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (AI_PAYMENT_METHODS.length % 2 === 1) keyboard.row();
    const toggleLabel = tx.tipo === 'Compartido' ? '👤 Individual' : '🔄 Compartido';
    keyboard.text(toggleLabel, `photo_shared:${txId}`).row();
    keyboard.text('❌ Cancelar', `tx_no:${txId}`);

    return ctx.reply(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  // Cuotas → pedir tarjeta
  if (tx.cuotas) {
    tx.metodoPago = 'Tarjeta';
    const montoCuota = Math.round(tx.monto / tx.cuotas * 100) / 100;
    pendingTx.set(txId, { ...tx, montoCuota, userId: ctx.from.id, createdAt: Date.now() });

    const preview =
      `*Nueva compra en cuotas* ${emoji}\n\n` +
      `📅 ${tx.fecha}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)} → ${tx.cuotas} cuotas de ${formatAmount(montoCuota, tx.moneda)}\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '') +
      `\n\n💳 Elegí tarjeta:`;

    const userCards = config.tarjetas[ctx.from.id] || [];
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < userCards.length; i++) {
      keyboard.text(`💳 ${userCards[i]}`, `cuota_card_${i}_${txId}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (userCards.length % 2 === 1) keyboard.row();
    const toggleLabel = tx.tipo === 'Compartido' ? '👤 Individual' : '🔄 Compartido';
    keyboard.text(toggleLabel, `photo_shared:${txId}`).row();
    keyboard.text('❌ Cancelar', `tx_no:${txId}`);

    return ctx.reply(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  // Tarjeta → pedir cuál
  if (tx.metodoPago === 'Tarjeta') {
    const preview =
      `*Nueva transacción* ${emoji}\n\n` +
      `📅 ${tx.fecha} ${tx.hora}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '') +
      `\n\n💳 Elegí tarjeta:`;

    const userCards = config.tarjetas[ctx.from.id] || [];
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < userCards.length; i++) {
      keyboard.text(`💳 ${userCards[i]}`, `card_${i}_${txId}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (userCards.length % 2 === 1) keyboard.row();
    keyboard.text('💳 Deel Card', `card_deel_${txId}`).row();
    keyboard.text('🔄 Compartido', `photo_shared:${txId}`)
      .text('💰 Otro método', `ap_change:${txId}`).row();
    keyboard.text('❌ Cancelar', `tx_no:${txId}`);

    return ctx.reply(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  // Método definido (no tarjeta) → confirmar directo
  const preview =
    `*Nueva transacción* ${emoji}\n\n` +
    `📅 ${tx.fecha} ${tx.hora}\n` +
    `📋 ${tx.descripcion}\n` +
    `🏷️ ${tx.categoria}\n` +
    `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
    `💳 ${tx.metodoPago}\n` +
    `👤 ${tx.tipo}\n` +
    `🙋 Pagado por: ${tx.pagadoPor}` +
    (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '');

  const keyboard = new InlineKeyboard()
    .text('✅ Confirmar', `tx_ok:${txId}`)
    .text('🔄 Compartido', `photo_shared:${txId}`)
    .row()
    .text('💰 Cambiar método', `ap_change:${txId}`)
    .text('❌ Cancelar', `tx_no:${txId}`);

  return ctx.reply(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// ============================================
// AUDIO — transcribir y parsear con IA
// ============================================

bot.on('message:voice', async (ctx) => {
  try {
    if (!isAiConfigured()) {
      return ctx.reply('Audio no disponible. Falta configurar OPENAI_API_KEY.');
    }

    const statusMsg = await ctx.reply('🎙️ Transcribiendo audio...');

    // Descargar y transcribir
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribeAudio(buffer);
    if (!transcription || !transcription.trim()) {
      return ctx.reply('No pude entender el audio. Intentá de nuevo o escribí el gasto.');
    }

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `🎙️ _${transcription}_`, { parse_mode: 'Markdown' });

    // Parsear con IA
    const categories = await getCategories();
    const categoryNames = categories.map(c => c.name);
    const userCardNames = config.tarjetas[ctx.from.id] || [];
    const aiResult = await parseExpense(transcription, categoryNames, userCardNames);

    if (aiResult.error) {
      return ctx.reply(
        `No pude interpretar el audio como gasto.\n\n${aiResult.error}`,
        { reply_markup: mainMenu }
      );
    }

    if (!aiResult.monto || aiResult.monto <= 0) {
      return ctx.reply('No detecté un monto en el audio. Intentá de nuevo.', { reply_markup: mainMenu });
    }

    const tx = buildTxFromAi(aiResult, ctx.from.id);
    await showAiTxPreview(ctx, tx, '🎙️');
  } catch (error) {
    console.error('Error procesando audio:', error.message);
    ctx.reply('Error procesando el audio. Revisá los logs.');
  }
});

// ============================================
// FOTO — analizar recibo con IA
// ============================================

bot.on('message:photo', async (ctx) => {
  try {
    if (!isAiConfigured()) {
      return ctx.reply('Fotos no disponible. Falta configurar OPENAI_API_KEY.');
    }

    const statusMsg = await ctx.reply('📷 Analizando recibo...');

    // Obtener foto de mayor resolución
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

    // Analizar con IA (incluye categorías y tarjetas del usuario)
    const categories = await getCategories();
    const categoryNames = categories.map(c => c.name);
    const userCardNames = config.tarjetas[ctx.from.id] || [];
    const result = await analyzeReceipt(fileUrl, categoryNames, userCardNames);

    if (result.error) {
      return ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `📷 ${result.error}`);
    }

    if (!result.monto || result.monto <= 0) {
      return ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '📷 No pude detectar el monto del recibo.');
    }

    const aiResult = { ...result, moneda: 'ARS', tipo: null, cuotas: null };
    const tx = buildTxFromAi(aiResult, ctx.from.id);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `📷 Recibo: _${tx.descripcion}_`, { parse_mode: 'Markdown' });
    await showAiTxPreview(ctx, tx, '📷');
  } catch (error) {
    console.error('Error procesando foto:', error.message);
    ctx.reply('Error procesando la foto. Revisá los logs.');
  }
});

// ============================================
// DOCUMENTO PDF — reconciliar resumen TC con transacciones cargadas
// ============================================

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type || doc.mime_type !== 'application/pdf') {
    return ctx.reply('Solo acepto PDFs (resúmenes de tarjeta).');
  }
  if (!isAiConfigured()) {
    return ctx.reply('PDF no disponible. Falta configurar OPENAI_API_KEY.');
  }

  const statusMsg = await ctx.reply('📄 Analizando resumen...');

  try {
    // Descargar PDF de Telegram
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Parsear con IA
    const userCards = config.tarjetas[ctx.from.id] || [];
    const stmt = await analyzeStatementPdf(buffer, userCards);

    if (stmt.error) {
      return ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `📄 ${stmt.error}`);
    }

    if (!userCards.includes(stmt.tarjeta)) {
      return ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
        `📄 Tarjeta detectada: *${stmt.tarjeta}*.\nNo coincide con tus tarjetas: ${userCards.join(', ')}.`,
        { parse_mode: 'Markdown' });
    }

    // Parsear fecha de cierre
    const [, cierreMonthStr, cierreYearStr] = stmt.cierre.split('/');
    const cierreMonth = parseInt(cierreMonthStr);
    const cierreYear = parseInt(cierreYearStr);

    // Reconciliar: traer transacciones del mes del cierre + mes anterior (cubre el período)
    const prevMonth = cierreMonth === 1 ? 12 : cierreMonth - 1;
    const prevYear = cierreMonth === 1 ? cierreYear - 1 : cierreYear;
    const [txCierre, txPrev] = await Promise.all([
      getMonthlyTransactions(cierreMonth, cierreYear),
      getMonthlyTransactions(prevMonth, prevYear),
    ]);
    const allTxs = [...txCierre, ...txPrev].filter(t => t.metodoPago === stmt.tarjeta);

    // Match: monto + fecha ±2 días + moneda. Marcamos los usados para evitar doble-match.
    const usedTxRows = new Set();
    const matched = [];
    const unmatched = [];
    for (const item of stmt.items) {
      if (item.esCuota) continue; // las cuotas viejas las maneja la hoja Cuotas
      const itemDateParts = item.fecha.split('/');
      const itemDateObj = new Date(parseInt(itemDateParts[2]), parseInt(itemDateParts[1]) - 1, parseInt(itemDateParts[0]));

      const match = allTxs.find(tx => {
        if (usedTxRows.has(tx.row)) return false;
        if (tx.moneda !== item.moneda) return false;
        if (Math.abs(tx.monto - item.monto) > 1) return false;
        const [d, m, y] = tx.fecha.split('/').map(x => parseInt(x));
        const txDate = new Date(y, m - 1, d);
        const diffDays = Math.abs((txDate - itemDateObj) / (1000 * 60 * 60 * 24));
        return diffDays <= 2;
      });

      if (match) { matched.push({ item, tx: match }); usedTxRows.add(match.row); }
      else unmatched.push(item);
    }

    const cuotasInPdf = stmt.items.filter(i => i.esCuota);

    // Construir reporte
    let text = `📄 *Resumen ${stmt.tarjeta}*\n\n`;
    text += `📅 Cierre: ${stmt.cierre} · Vto: ${stmt.vencimiento}\n`;
    text += `💰 Total: ${fmtMonto(stmt.totalArs, 'ARS')}`;
    if (stmt.totalUsd > 0) text += ` + ${fmtMonto(stmt.totalUsd, 'USD')}`;
    text += `\n\n📊 *Reconciliación:*\n`;
    text += `✅ ${matched.length} ítems cuadran\n`;
    if (cuotasInPdf.length > 0) text += `ℹ️ ${cuotasInPdf.length} cuotas viejas (ver /cuotas)\n`;

    if (unmatched.length > 0) {
      const totalUnmatched = unmatched.reduce((s, u) => s + u.monto, 0);
      text += `\n⚠️ *${unmatched.length} ítems sin registrar:*\n`;
      for (const u of unmatched.slice(0, 10)) {
        const desc = (u.descripcion || '').substring(0, 32);
        text += `• ${u.fecha} ${desc} — ${fmtMonto(u.monto, u.moneda)}\n`;
      }
      if (unmatched.length > 10) text += `_…y ${unmatched.length - 10} más_\n`;
      text += `\n💵 Total sin registrar: ${fmtMonto(totalUnmatched, 'ARS')}\n`;
    } else {
      text += `🎉 *Todo cuadra* — no te falta cargar nada.\n`;
    }

    text += `\n¿Cargar el total en Pagos TC?`;

    // Guardar pending
    cleanMap(pendingPdf);
    const pdfId = ++txCounter;
    pendingPdf.set(pdfId, {
      userId: ctx.from.id,
      tarjeta: stmt.tarjeta,
      totalArs: stmt.totalArs,
      cierreMonth, cierreYear,
      createdAt: Date.now(),
    });

    const keyboard = new InlineKeyboard()
      .text(`📥 Cargar ${fmtMonto(stmt.totalArs, 'ARS')}`, `pdf_load:${pdfId}`)
      .text('❌ No cargar', `pdf_no:${pdfId}`);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error('Error procesando PDF:', err.message);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `📄 Error procesando el PDF: ${err.message}`);
  }
});

bot.callbackQuery(/^pdf_load:(\d+)$/, async (ctx) => {
  const pdfId = parseInt(ctx.match[1]);
  const pending = pendingPdf.get(pdfId);
  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien subió puede confirmar' });

  try {
    await registrarPagoTC(pending.cierreMonth, pending.tarjeta, pending.totalArs);
    pendingPdf.delete(pdfId);
    await ctx.editMessageText(
      `✅ *Cargado en Pagos TC*\n\n${pending.tarjeta} — ${fmtMonto(pending.totalArs, 'ARS')}\nMes: ${MESES_CORTO[pending.cierreMonth - 1]} ${pending.cierreYear}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: 'Cargado' });
  } catch (err) {
    console.error('Error registrando Pago TC desde PDF:', err.message);
    await ctx.answerCallbackQuery({ text: 'Error al cargar' });
  }
});

bot.callbackQuery(/^pdf_no:(\d+)$/, async (ctx) => {
  const pdfId = parseInt(ctx.match[1]);
  pendingPdf.delete(pdfId);
  await ctx.editMessageText('❌ Reconciliación descartada.');
  await ctx.answerCallbackQuery();
});

// ============================================
// MENSAJE DE TEXTO — parsear como transaccion
// ============================================

bot.on('message:text', async (ctx) => {
  try {
    const text = ctx.message.text.trim();

    // Menú persistente: si el texto coincide con un botón, ejecutar el comando
    const menuCmd = MENU_MAP[text];
    if (menuCmd && CMD_HANDLERS[menuCmd]) {
      return CMD_HANDLERS[menuCmd](ctx);
    }

    // Interceptar wizard de carga manual (paso descripción o monto)
    const manual = pendingManual.get(ctx.from.id);
    if (manual && Date.now() - manual.createdAt < TX_TTL) {
      if (manual.step === 'description') {
        manual.data.descripcion = text.charAt(0).toUpperCase() + text.slice(1);
        manual.step = 'amount';
        return ctx.reply(
          `📋 *Nuevo gasto — Paso 3/6*\n\n` +
          `🏷️ ${manual.data.categoria}\n` +
          `📝 ${manual.data.descripcion}\n\n` +
          `Escribí el monto:`,
          { parse_mode: 'Markdown' }
        );
      }

      if (manual.step === 'amount') {
        const monto = parseLocalNumber(text);
        if (!monto || monto <= 0) {
          return ctx.reply('Monto inválido. Escribí un número (ej: 15000, 15.000, 1500,50).');
        }
        manual.data.monto = monto;
        manual.step = 'currency';

        const keyboard = new InlineKeyboard()
          .text('🇦🇷 ARS', `mg_cur:${manual.id}:ARS`)
          .text('🇺🇸 USD', `mg_cur:${manual.id}:USD`)
          .row()
          .text('❌ Cancelar', `mg_no:${manual.id}`);

        return ctx.reply(
          `📋 *Nuevo gasto — Paso 4/6*\n\n` +
          `🏷️ ${manual.data.categoria}\n` +
          `📝 ${manual.data.descripcion}\n` +
          `💰 ${formatAmount(monto, 'ARS')}\n\n` +
          `Elegí la moneda:`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }
    }

    // Interceptar si el usuario tiene una tx de audio/foto esperando método de pago
    // metodoPago null = preguntó "¿Con qué pagaste?", 'Tarjeta' = preguntó "Elegí tarjeta"
    const pendingPayment = [...pendingTx.entries()].find(
      ([_, v]) => v.userId === ctx.from.id && (v.metodoPago === null || v.metodoPago === 'Tarjeta') && Date.now() - v.createdAt < TX_TTL
    );
    if (pendingPayment) {
      const [txId, tx] = pendingPayment;
      const lower = text.toLowerCase();

      // Matchear tarjeta específica del usuario (nombre completo: "visa bbva")
      const userCards = config.tarjetas[ctx.from.id] || [];
      let matchedCard = null;
      for (const card of userCards) {
        const cardParts = card.toLowerCase().split(' ');
        if (cardParts.every(part => lower.includes(part))) {
          matchedCard = card;
          break;
        }
      }

      // Matchear por marca parcial: "visa" → Visa BBVA si es la única visa del usuario
      if (!matchedCard) {
        const brand = lower.includes('visa') ? 'visa' : lower.includes('master') ? 'master' : null;
        if (brand) {
          const matches = userCards.filter(c => c.toLowerCase().includes(brand));
          if (matches.length === 1) matchedCard = matches[0];
        }
      }

      if (matchedCard) {
        tx.metodoPago = matchedCard;
        pendingTx.set(txId, { ...tx, userId: ctx.from.id, createdAt: Date.now() });
        return showFinalConfirmation(ctx.reply.bind(ctx), tx, txId);
      }

      // Si ya estaba en fase "elegí tarjeta" y no matcheó nombre → recordar
      if (tx.metodoPago === 'Tarjeta') {
        return ctx.reply(
          '💳 No pude identificar la tarjeta.\n\nUsá los botones de arriba o escribí el nombre (ej: *visa bbva*).',
          { parse_mode: 'Markdown' }
        );
      }

      // Matchear método de pago general (solo si metodoPago era null)
      let matchedMethod = null;
      if (lower.includes('efectivo')) matchedMethod = 'Efectivo';
      else if (lower.includes('banco') || lower.includes('transferencia') || lower.includes('debito') || lower.includes('débito')) matchedMethod = 'Banco';
      else if (lower.includes('deel') && lower.includes('usd')) matchedMethod = 'Deel USD';
      else if (lower.includes('deel')) matchedMethod = 'Deel Card';
      else if (lower.includes('tarjeta') || lower.includes('credito') || lower.includes('crédito')) matchedMethod = 'Tarjeta';

      if (matchedMethod === 'Tarjeta') {
        tx.metodoPago = 'Tarjeta';
        const keyboard = new InlineKeyboard();
        for (let i = 0; i < userCards.length; i++) {
          keyboard.text(`💳 ${userCards[i]}`, `card_${i}_${txId}`);
          if (i % 2 === 1) keyboard.row();
        }
        if (userCards.length % 2 === 1) keyboard.row();
        keyboard.text('❌ Cancelar', `tx_no:${txId}`);

        return ctx.reply(
          `*Nueva transacción*\n\n` +
          `📅 ${tx.fecha} ${tx.hora}\n` +
          `📋 ${tx.descripcion}\n` +
          `🏷️ ${tx.categoria}\n` +
          `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
          `👤 ${tx.tipo}\n` +
          `🙋 Pagado por: ${tx.pagadoPor}` +
          (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '') +
          `\n\n💳 Elegí tarjeta:`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }

      if (matchedMethod) {
        tx.metodoPago = matchedMethod;
        pendingTx.set(txId, { ...tx, userId: ctx.from.id, createdAt: Date.now() });
        return showFinalConfirmation(ctx.reply.bind(ctx), tx, txId);
      }

      // No se reconoció método → recordar usar botones
      return ctx.reply(
        '💳 No pude identificar el método de pago.\n\nUsá los botones de arriba o escribí: *tarjeta*, *banco*, *efectivo* o *deel*.',
        { parse_mode: 'Markdown' }
      );
    }

    // Interceptar si el usuario está registrando compra/venta crypto
    const cryptoPending = pendingCrypto.get(ctx.from.id);
    if (cryptoPending && (cryptoPending.action === 'buy_waiting' || cryptoPending.action === 'sell_waiting')) {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        return ctx.reply('Formato: `cantidad simbolo precio [plataforma]`\nEjemplo: `0.05 ETH 2650 Bybit`', { parse_mode: 'Markdown' });
      }

      const cantidad = parseFloat(parts[0]);
      const simbolo = parts[1].toUpperCase();
      const precio = parseFloat(parts[2]);
      const plataforma = parts.slice(3).join(' ') || 'Bybit';

      if (isNaN(cantidad) || cantidad <= 0 || isNaN(precio) || precio <= 0) {
        return ctx.reply('Cantidad y precio deben ser números positivos.');
      }

      const tipo = cryptoPending.action === 'buy_waiting' ? 'Compra' : 'Venta';

      // Validar cantidad disponible para ventas
      if (tipo === 'Venta') {
        const holdings = await getCryptoHoldings();
        const holding = holdings.find(h => h.simbolo === simbolo);
        if (!holding || holding.cantidad < cantidad) {
          const disponible = holding ? holding.cantidad : 0;
          return ctx.reply(`No tenés suficiente ${simbolo}. Disponible: ${disponible}`);
        }
      }

      const total = cantidad * precio;
      pendingCrypto.delete(ctx.from.id);

      const cryptoId = ++txCounter;
      pendingCrypto.set(cryptoId, {
        tipo, simbolo, cantidad, precio, plataforma, total,
        userId: ctx.from.id,
        createdAt: Date.now(),
      });

      const emoji = tipo === 'Compra' ? '🟢' : '🔴';
      const keyboard = new InlineKeyboard()
        .text('✅ Confirmar', `crypto_ok:${cryptoId}`)
        .text('❌ Cancelar', `crypto_no:${cryptoId}`);

      return ctx.reply(
        `${emoji} *${tipo} Crypto*\n\n` +
        `Crypto: *${simbolo}*\n` +
        `Cantidad: ${cantidad}\n` +
        `Precio: ${fmtUsd(precio)}\n` +
        `Total: ${fmtUsd(total)}\n` +
        `Plataforma: ${plataforma}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }

    // Interceptar si el usuario está actualizando inversiones
    const invPending = pendingInversiones.get(ctx.from.id);
    if (invPending && invPending.action === 'update_waiting') {
      const parts = text.split(/\s+/);

      // Parsear monto total (primer número, soporta locale argentino)
      let totalStr = parts[0];
      let total;
      if (/^\d{1,3}(\.\d{3})+$/.test(totalStr)) {
        total = parseFloat(totalStr.replace(/\./g, ''));
      } else if (/^\d+,\d+$/.test(totalStr)) {
        total = parseFloat(totalStr.replace(',', '.'));
      } else {
        total = parseFloat(totalStr);
      }

      if (isNaN(total) || total <= 0) {
        return ctx.reply('Monto inválido. Escribí el valor total.\nEjemplo: `650000` o `650000 15 28 57`', { parse_mode: 'Markdown' });
      }

      // Parsear porcentajes opcionales
      let porcentajes = null;
      if (parts.length >= 4) {
        const pcts = parts.slice(1, 4).map(p => parseFloat(p.replace(',', '.')));
        if (pcts.some(p => isNaN(p) || p < 0)) {
          return ctx.reply('Porcentajes inválidos. Deben ser números positivos.\nEjemplo: `650000 15 28 57`', { parse_mode: 'Markdown' });
        }
        const suma = pcts.reduce((a, b) => a + b, 0);
        if (Math.abs(suma - 100) > 2) {
          return ctx.reply(`Los porcentajes suman ${suma.toFixed(1)}%. Deben sumar ~100%.`);
        }
        porcentajes = pcts;
      }

      pendingInversiones.delete(ctx.from.id);

      const invId = ++txCounter;
      pendingInversiones.set(invId, {
        total, porcentajes,
        userId: ctx.from.id,
        createdAt: Date.now(),
      });

      let confirmText = `📈 *Actualizar Inversiones*\n\n💼 Total: ${fmtMonto(total, 'ARS')}`;
      if (porcentajes) {
        const nombres = ['Acciones', 'CEDEARs', 'FCIs'];
        confirmText += '\n\n*Nuevos porcentajes:*';
        for (let i = 0; i < porcentajes.length; i++) {
          confirmText += `\n📊 ${nombres[i] || `Tipo ${i + 1}`} — ${porcentajes[i]}%`;
        }
      } else {
        confirmText += '\n_(porcentajes sin cambios)_';
      }
      confirmText += '\n\n¿Confirmar?';

      const keyboard = new InlineKeyboard()
        .text('✅ Confirmar', `inv_ok:${invId}`)
        .text('❌ Cancelar', `inv_no:${invId}`);

      return ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    // Interceptar si el usuario está actualizando saldo o registrando aporte de ahorro
    const ahoroPending = pendingAhorro.get(ctx.from.id);
    if (ahoroPending && (ahoroPending.action === 'update_waiting' || ahoroPending.action === 'aporte_waiting')) {
      const input = text.trim();
      let monto;
      // Soporta "250.000" (miles), "250.000,50" (miles+decimales), "250000"
      if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(input)) {
        monto = parseFloat(input.replace(/\./g, '').replace(',', '.'));
      } else if (/^\d+,\d+$/.test(input)) {
        monto = parseFloat(input.replace(',', '.'));
      } else {
        monto = parseFloat(input);
      }

      if (isNaN(monto) || monto <= 0) {
        return ctx.reply('Monto inválido. Enviá un número positivo.');
      }

      pendingAhorro.delete(ctx.from.id);

      const nombreCuenta = ahoroPending.cuenta === 'deelUsd' ? 'Deel USD' : 'ARS Banco';
      const moneda = ahoroPending.cuenta === 'deelUsd' ? 'USD' : 'ARS';
      const opId = ++txCounter;

      if (ahoroPending.action === 'aporte_waiting') {
        pendingAhorro.set(opId, {
          cuenta: ahoroPending.cuenta,
          monto,
          userId: ctx.from.id,
          createdAt: Date.now(),
        });
        const keyboard = new InlineKeyboard()
          .text('✅ Confirmar', `apo_ok:${opId}`)
          .text('❌ Cancelar', `apo_no:${opId}`);
        return ctx.reply(
          `📥 *Registrar aporte*\n\n${nombreCuenta}: +${fmtMonto(monto, moneda)}\n\n¿Confirmar?`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }

      pendingAhorro.set(opId, {
        cuenta: ahoroPending.cuenta,
        saldo: monto,
        userId: ctx.from.id,
        createdAt: Date.now(),
      });
      const keyboard = new InlineKeyboard()
        .text('✅ Confirmar', `sav_ok:${opId}`)
        .text('❌ Cancelar', `sav_no:${opId}`);
      return ctx.reply(
        `🏦 *Actualizar Ahorro*\n\n${nombreCuenta}: ${fmtMonto(monto, moneda)}\n\n¿Confirmar?`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }

    // Interceptar si el usuario está ajustando monto de cuota (con interés)
    const cuotaEdit = [...pendingCuotaEdit.entries()].find(
      ([_, v]) => v.userId === ctx.from.id && v.waitingForAmount && Date.now() - v.createdAt < TX_TTL
    );
    if (cuotaEdit) {
      const [editId, editData] = cuotaEdit;
      const input = ctx.message.text.trim();
      let nuevoMonto;
      if (/^\d{1,3}(\.\d{3})+$/.test(input)) {
        nuevoMonto = parseFloat(input.replace(/\./g, ''));
      } else if (/^\d+,\d+$/.test(input)) {
        nuevoMonto = parseFloat(input.replace(',', '.'));
      } else {
        nuevoMonto = parseFloat(input);
      }
      if (!nuevoMonto || nuevoMonto <= 0) {
        return ctx.reply('Monto inválido. Enviá un número.');
      }
      await updateCuotaMonto(editData.cuotaRow, nuevoMonto);
      const montoAnterior = editData.montoCuota;
      pendingCuotaEdit.delete(editId);
      return ctx.reply(
        `✅ Monto de cuota actualizado: ${fmtMonto(montoAnterior, editData.moneda)} → ${fmtMonto(nuevoMonto, editData.moneda)}`
      );
    }

    // Interceptar si el usuario está editando un monto de gasto fijo o cuota
    const editState = pendingFixedEdit.get(ctx.from.id);
    if (editState && Date.now() - editState.createdAt < TX_TTL) {
      const pending = pendingFijos.get(editState.fijoId);
      if (pending) {
        const input = ctx.message.text.trim();
        let nuevoMonto;
        if (/^\d{1,3}(\.\d{3})+$/.test(input)) {
          nuevoMonto = parseFloat(input.replace(/\./g, ''));
        } else if (/^\d+,\d+$/.test(input)) {
          nuevoMonto = parseFloat(input.replace(',', '.'));
        } else {
          nuevoMonto = parseFloat(input);
        }

        if (!nuevoMonto || nuevoMonto <= 0) {
          return ctx.reply('Monto inválido. Enviá un número.');
        }

        let descripcion, montoAnterior, moneda;
        const cuotasArr = pending.cuotas || [];

        if (editState.isCuota) {
          // Editar monto de cuota
          const cuota = cuotasArr[editState.gastoIndex - pending.gastos.length];
          montoAnterior = cuota.montoCuota;
          cuota.montoCuota = nuevoMonto;
          descripcion = cuota.descripcion;
          moneda = cuota.moneda;
          await updateCuotaMonto(cuota.row, nuevoMonto);
        } else {
          // Editar monto de gasto fijo
          const gasto = pending.gastos[editState.gastoIndex];
          montoAnterior = gasto.montoEstimado;
          gasto.montoEstimado = nuevoMonto;
          descripcion = gasto.descripcion;
          moneda = gasto.moneda;
          await updateGastoFijoMonto(gasto.row, nuevoMonto);
        }

        pendingFixedEdit.delete(ctx.from.id);

        const keyboard = new InlineKeyboard()
          .text('✅ Registrar todos', `fijos_ok:${editState.fijoId}`)
          .row()
          .text('✏️ Editar monto', `fijos_edit:${editState.fijoId}`)
          .text('❌ Cancelar', `fijos_no:${editState.fijoId}`);

        const listText = cuotasArr.length > 0
          ? buildFijosAndCuotasText(pending.gastos, cuotasArr)
          : buildFijosText(pending.gastos);

        const text = listText +
          `\n\n✅ ${descripcion}: ${fmtMonto(montoAnterior, moneda)} → ${fmtMonto(nuevoMonto, moneda)}`;

        return ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
      }
      pendingFixedEdit.delete(ctx.from.id);
    }

    // IA unificada: texto, audio y fotos usan el mismo flujo
    if (!isAiConfigured()) {
      return ctx.reply('IA no configurada. Agregá OPENAI_API_KEY en las variables de entorno.');
    }

    const categories = await getCategories();
    const categoryNames = categories.map(c => c.name);
    const userCardNames = config.tarjetas[ctx.from.id] || [];

    const aiResult = await parseExpense(text, categoryNames, userCardNames);

    if (aiResult.error) {
      return ctx.reply(
        'No pude interpretar ese mensaje.\n\n' +
        'Enviá algo como: uber 3500\n' +
        'O: super 15000 compartido',
        { reply_markup: mainMenu }
      );
    }

    if (!aiResult.monto || aiResult.monto <= 0) {
      return ctx.reply('No encontré un monto válido en el mensaje.', { reply_markup: mainMenu });
    }

    const tx = buildTxFromAi(aiResult, ctx.from.id);
    await showAiTxPreview(ctx, tx, '💬');
  } catch (error) {
    console.error('Error procesando mensaje:', error.message);
    ctx.reply('Error procesando el mensaje. Revisá los logs.');
  }
});

// ============================================
// CALLBACKS — Wizard carga manual (/gasto)
// ============================================

// Selección de categoría
bot.callbackQuery(/^mg_cat:(\d+):(\d+)$/, async (ctx) => {
  const manualId = parseInt(ctx.match[1]);
  const catIdx = parseInt(ctx.match[2]);
  const pending = pendingManual.get(ctx.from.id);

  if (!pending || pending.id !== manualId)
    return ctx.answerCallbackQuery({ text: 'Expirado.' });

  const categories = await getCategories();
  pending.data.categoria = categories[catIdx]?.name || 'Otros';
  pending.step = 'description';

  await ctx.editMessageText(
    `📋 *Nuevo gasto — Paso 2/6*\n\n` +
    `🏷️ Categoría: ${pending.data.categoria}\n\n` +
    `Escribí la descripción:`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Selección de moneda
bot.callbackQuery(/^mg_cur:(\d+):(ARS|USD)$/, async (ctx) => {
  const manualId = parseInt(ctx.match[1]);
  const moneda = ctx.match[2];
  const pending = pendingManual.get(ctx.from.id);

  if (!pending || pending.id !== manualId)
    return ctx.answerCallbackQuery({ text: 'Expirado.' });

  pending.data.moneda = moneda;

  // USD → método Deel Card por defecto, saltar a tipo
  if (moneda === 'USD') {
    pending.data.metodoPago = 'Deel Card';
    pending.step = 'type';
    const kb = new InlineKeyboard()
      .text('👤 Individual', `mg_type:${manualId}:individual`)
      .text('👥 Compartido', `mg_type:${manualId}:compartido`)
      .row()
      .text('❌ Cancelar', `mg_no:${manualId}`);

    await ctx.editMessageText(
      `📋 *Nuevo gasto — Paso 6/6*\n\n` +
      `🏷️ ${pending.data.categoria}\n` +
      `📝 ${pending.data.descripcion}\n` +
      `💰 ${formatAmount(pending.data.monto, moneda)}\n` +
      `💳 Deel Card\n\n` +
      `Elegí el tipo:`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
    return ctx.answerCallbackQuery();
  }

  // ARS → mostrar métodos de pago
  pending.step = 'payment';
  const keyboard = new InlineKeyboard();
  AI_PAYMENT_METHODS.forEach((method, i) => {
    keyboard.text(method, `mg_pay:${manualId}:${i}`);
    if (i % 2 === 1) keyboard.row();
  });
  if (AI_PAYMENT_METHODS.length % 2 === 1) keyboard.row();
  keyboard.text('❌ Cancelar', `mg_no:${manualId}`);

  await ctx.editMessageText(
    `📋 *Nuevo gasto — Paso 5/6*\n\n` +
    `🏷️ ${pending.data.categoria}\n` +
    `📝 ${pending.data.descripcion}\n` +
    `💰 ${formatAmount(pending.data.monto, moneda)}\n\n` +
    `Elegí el método de pago:`,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
  await ctx.answerCallbackQuery();
});

// Selección de método de pago
bot.callbackQuery(/^mg_pay:(\d+):(\d+)$/, async (ctx) => {
  const manualId = parseInt(ctx.match[1]);
  const methodIdx = parseInt(ctx.match[2]);
  const pending = pendingManual.get(ctx.from.id);

  if (!pending || pending.id !== manualId)
    return ctx.answerCallbackQuery({ text: 'Expirado.' });

  const metodo = AI_PAYMENT_METHODS[methodIdx];

  // Si eligió "Tarjeta", mostrar tarjetas específicas
  if (metodo === 'Tarjeta') {
    pending.step = 'card';
    const userCards = config.tarjetas[ctx.from.id] || [];
    const kb = new InlineKeyboard();
    userCards.forEach((card, i) => {
      kb.text(`💳 ${card}`, `mg_crd:${manualId}:${i}`);
      if (i % 2 === 1) kb.row();
    });
    if (userCards.length % 2 === 1) kb.row();
    kb.text('💳 Deel Card', `mg_crd_deel:${manualId}`).row();
    kb.text('❌ Cancelar', `mg_no:${manualId}`);

    await ctx.editMessageText(
      `📋 *Nuevo gasto — Paso 5/6*\n\n` +
      `Elegí la tarjeta:`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
    return ctx.answerCallbackQuery();
  }

  // Otro método → pasar a tipo
  pending.data.metodoPago = metodo;
  pending.step = 'type';

  const kb = new InlineKeyboard()
    .text('👤 Individual', `mg_type:${manualId}:individual`)
    .text('👥 Compartido', `mg_type:${manualId}:compartido`)
    .row()
    .text('❌ Cancelar', `mg_no:${manualId}`);

  await ctx.editMessageText(
    `📋 *Nuevo gasto — Paso 6/6*\n\n` +
    `🏷️ ${pending.data.categoria}\n` +
    `📝 ${pending.data.descripcion}\n` +
    `💰 ${formatAmount(pending.data.monto, pending.data.moneda)}\n` +
    `💳 ${metodo}\n\n` +
    `Elegí el tipo:`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
});

// Selección de tarjeta específica
bot.callbackQuery(/^mg_crd:(\d+):(\d+)$/, async (ctx) => {
  const manualId = parseInt(ctx.match[1]);
  const cardIdx = parseInt(ctx.match[2]);
  const pending = pendingManual.get(ctx.from.id);

  if (!pending || pending.id !== manualId)
    return ctx.answerCallbackQuery({ text: 'Expirado.' });

  const userCards = config.tarjetas[ctx.from.id] || [];
  pending.data.metodoPago = userCards[cardIdx];
  pending.step = 'type';

  const kb = new InlineKeyboard()
    .text('👤 Individual', `mg_type:${manualId}:individual`)
    .text('👥 Compartido', `mg_type:${manualId}:compartido`)
    .row()
    .text('❌ Cancelar', `mg_no:${manualId}`);

  await ctx.editMessageText(
    `📋 *Nuevo gasto — Paso 6/6*\n\n` +
    `🏷️ ${pending.data.categoria}\n` +
    `📝 ${pending.data.descripcion}\n` +
    `💰 ${formatAmount(pending.data.monto, pending.data.moneda)}\n` +
    `💳 ${pending.data.metodoPago}\n\n` +
    `Elegí el tipo:`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
});

// Selección de Deel Card desde submenu de tarjetas (flujo manual)
bot.callbackQuery(/^mg_crd_deel:(\d+)$/, async (ctx) => {
  const manualId = parseInt(ctx.match[1]);
  const pending = pendingManual.get(ctx.from.id);

  if (!pending || pending.id !== manualId)
    return ctx.answerCallbackQuery({ text: 'Expirado.' });

  pending.data.metodoPago = 'Deel Card';
  pending.step = 'type';

  const kb = new InlineKeyboard()
    .text('👤 Individual', `mg_type:${manualId}:individual`)
    .text('👥 Compartido', `mg_type:${manualId}:compartido`)
    .row()
    .text('❌ Cancelar', `mg_no:${manualId}`);

  await ctx.editMessageText(
    `📋 *Nuevo gasto — Paso 6/6*\n\n` +
    `🏷️ ${pending.data.categoria}\n` +
    `📝 ${pending.data.descripcion}\n` +
    `💰 ${formatAmount(pending.data.monto, pending.data.moneda)}\n` +
    `💳 Deel Card\n\n` +
    `Elegí el tipo:`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
});

// Selección de tipo (individual/compartido) → preview final
bot.callbackQuery(/^mg_type:(\d+):(individual|compartido)$/, async (ctx) => {
  const manualId = parseInt(ctx.match[1]);
  const tipoChoice = ctx.match[2];
  const pending = pendingManual.get(ctx.from.id);

  if (!pending || pending.id !== manualId)
    return ctx.answerCallbackQuery({ text: 'Expirado.' });

  const isMoises = ctx.from.id === config.moisesId;
  const pagadoPor = isMoises ? 'Moises' : 'Oriana';

  let tipo, splitMoises, splitOriana;
  if (tipoChoice === 'compartido') {
    tipo = 'Compartido';
    splitMoises = 50;
    splitOriana = 50;
  } else {
    tipo = isMoises ? 'Individual Moises' : 'Individual Oriana';
    splitMoises = isMoises ? 100 : 0;
    splitOriana = isMoises ? 0 : 100;
  }

  // Fecha/hora en timezone Buenos Aires
  const now = new Date();
  const baOpts = { timeZone: 'America/Argentina/Buenos_Aires' };
  const fecha = now.toLocaleDateString('es-AR', { ...baOpts, day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = now.toLocaleTimeString('es-AR', { ...baOpts, hour: '2-digit', minute: '2-digit', hour12: false });

  // Construir tx completa y mover a pendingTx para reusar callbacks existentes
  const tx = {
    fecha, hora,
    descripcion: pending.data.descripcion,
    categoria: pending.data.categoria,
    monto: pending.data.monto,
    moneda: pending.data.moneda,
    metodoPago: pending.data.metodoPago,
    tipo, pagadoPor,
    splitMoises, splitOriana,
    notas: '',
  };

  cleanMap(pendingTx);
  const txId = ++txCounter;
  pendingTx.set(txId, { ...tx, userId: ctx.from.id, createdAt: Date.now() });
  pendingManual.delete(ctx.from.id);

  const preview =
    `✅ *Confirmar gasto*\n\n` +
    `📅 ${fecha} ${hora}\n` +
    `📋 ${tx.descripcion}\n` +
    `🏷️ ${tx.categoria}\n` +
    `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
    `💳 ${tx.metodoPago}\n` +
    `👤 ${tx.tipo}\n` +
    `🙋 Pagado por: ${pagadoPor}` +
    (tipo === 'Compartido' ? `\n📊 Split: Moises ${splitMoises}% / Oriana ${splitOriana}%` : '');

  const keyboard = new InlineKeyboard()
    .text('✅ Confirmar', `tx_ok:${txId}`)
    .text('🔄 Compartido', `photo_shared:${txId}`)
    .row()
    .text('❌ Cancelar', `tx_no:${txId}`);

  await ctx.editMessageText(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery();
});

// Cancelar wizard
bot.callbackQuery(/^mg_no:(\d+)$/, async (ctx) => {
  const manualId = parseInt(ctx.match[1]);
  const pending = pendingManual.get(ctx.from.id);
  if (pending && pending.id === manualId) {
    pendingManual.delete(ctx.from.id);
  }
  await ctx.editMessageText('❌ Carga cancelada.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});

// ============================================
// CALLBACKS — Transacciones
// ============================================

bot.callbackQuery(/^tx_ok:(\d+)$/, async (ctx) => {
  const txId = parseInt(ctx.match[1]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción expirada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede confirmar.' });

  pendingTx.delete(txId);

  try {
    // Si es compra en cuotas → guardar en hoja Cuotas
    if (tx.cuotas && tx.cuotas > 1) {
      const now = getNowBA();
      const cierreDay = config.cierreTarjetas[tx.metodoPago] || 0;
      const primera = calcPrimeraCuota(now, cierreDay);
      const primeraCuotaStr = formatMesAnio(primera.month, primera.year);
      const montoCuota = tx.montoCuota || Math.round(tx.monto / tx.cuotas * 100) / 100;

      await appendCuota({
        descripcion: tx.descripcion,
        categoria: tx.categoria,
        montoTotal: tx.monto,
        cuotasTotales: tx.cuotas,
        montoCuota,
        moneda: tx.moneda,
        tarjeta: tx.metodoPago,
        tipo: tx.tipo,
        pagadoPor: tx.pagadoPor,
        fechaCompra: tx.fecha,
        primeraCuota: primeraCuotaStr,
      });
      checkBudgetAlert(ctx.from.id, tx);

      // Última cuota
      let ultMes = primera.month + tx.cuotas - 2;
      let ultAnio = primera.year;
      while (ultMes > 12) { ultMes -= 12; ultAnio++; }
      while (ultMes < 1) { ultMes += 12; ultAnio--; }
      const primeraLabel = `${MESES_CORTO[primera.month - 1]} ${primera.year}`;
      const ultimaLabel = `${MESES_CORTO[ultMes - 1]} ${ultAnio}`;

      const confirmText =
        `✅ *Cuotas registradas*\n\n` +
        `📋 ${tx.descripcion}\n` +
        `💰 ${tx.cuotas} cuotas de ${formatAmount(montoCuota, tx.moneda)}\n` +
        `💳 ${tx.metodoPago}\n` +
        `📅 ${primeraLabel} → ${ultimaLabel}`;

      // Guardar referencia para ajuste de monto post-confirmación
      const cuotaConfirmId = ++txCounter;
      const allCuotas = await getCuotas();
      const lastCuota = allCuotas[allCuotas.length - 1];
      pendingCuotaEdit.set(cuotaConfirmId, {
        cuotaRow: lastCuota ? lastCuota.row : null,
        montoCuota,
        moneda: tx.moneda,
        userId: ctx.from.id,
        createdAt: Date.now(),
      });

      const keyboard = new InlineKeyboard()
        .text('✅ OK', `cuota_done:${cuotaConfirmId}`)
        .text('💰 Ajustar monto cuota', `cuota_adjust:${cuotaConfirmId}`);

      await ctx.editMessageText(confirmText, { parse_mode: 'Markdown', reply_markup: keyboard });
      await ctx.answerCallbackQuery({ text: 'Cuotas guardadas' });
      return;
    }

    // Transacción normal
    await appendTransaction(tx);
    checkBudgetAlert(ctx.from.id, tx);
    await ctx.editMessageText(
      `✅ *Guardada*\n\n` +
      `📋 ${tx.descripcion}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💳 ${tx.metodoPago}\n` +
      `👤 ${tx.tipo}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: 'Guardada en el Sheet' });
  } catch (error) {
    console.error('Error guardando transacción:', error.message);
    await ctx.editMessageText('❌ Error guardando en Google Sheets. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error al guardar' });
  }
});

// Helper: muestra preview final post-selección de método con toggle Compartido + ✅ Confirmar.
// Asegura que el usuario pueda cambiar tipo (Individual/Compartido) antes de guardar.
// replyFn: ctx.editMessageText.bind(ctx) si vienen de callback; ctx.reply.bind(ctx) si vienen de mensaje de texto.
async function showFinalConfirmation(replyFn, tx, txId) {
  const toggleLabel = tx.tipo === 'Compartido' ? '👤 Individual' : '🔄 Compartido';
  const hasCuotas = tx.cuotas && tx.cuotas > 1;

  let preview;
  if (hasCuotas) {
    const montoCuota = tx.montoCuota || Math.round(tx.monto / tx.cuotas * 100) / 100;
    preview =
      `*Confirmá la compra en cuotas*\n\n` +
      `📅 ${tx.fecha}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)} → ${tx.cuotas} cuotas de ${formatAmount(montoCuota, tx.moneda)}\n` +
      `💳 ${tx.metodoPago}\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '');
  } else {
    preview =
      `*Confirmá la transacción*\n\n` +
      `📅 ${tx.fecha} ${tx.hora}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `💳 ${tx.metodoPago}\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '');
  }

  const keyboard = new InlineKeyboard()
    .text('✅ Confirmar', `tx_ok:${txId}`)
    .text(toggleLabel, `photo_shared:${txId}`)
    .row()
    .text('💰 Cambiar método', `ap_change:${txId}`)
    .text('❌ Cancelar', `tx_no:${txId}`);

  await replyFn(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// Seleccion de tarjeta especifica → muestra confirmación final (no guarda directo)
bot.callbackQuery(/^card_(\d+)_(\d+)$/, async (ctx) => {
  const cardIdx = parseInt(ctx.match[1]);
  const txId = parseInt(ctx.match[2]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción expirada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede confirmar.' });

  const userCards = config.tarjetas[ctx.from.id] || [];
  const cardName = userCards[cardIdx];
  if (!cardName) return ctx.answerCallbackQuery({ text: 'Tarjeta no encontrada.' });

  tx.metodoPago = cardName;
  pendingTx.set(txId, { ...tx, userId: ctx.from.id, createdAt: Date.now() });

  await showFinalConfirmation(ctx.editMessageText.bind(ctx), tx, txId);
  await ctx.answerCallbackQuery({ text: cardName });
});

// Seleccion de Deel Card → muestra confirmación final (no guarda directo)
bot.callbackQuery(/^card_deel_(\d+)$/, async (ctx) => {
  const txId = parseInt(ctx.match[1]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción expirada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede confirmar.' });

  tx.metodoPago = 'Deel Card';
  pendingTx.set(txId, { ...tx, userId: ctx.from.id, createdAt: Date.now() });

  await showFinalConfirmation(ctx.editMessageText.bind(ctx), tx, txId);
  await ctx.answerCallbackQuery({ text: 'Deel Card' });
});

// Seleccion de tarjeta para compra en cuotas → muestra confirmación final (no guarda directo)
bot.callbackQuery(/^cuota_card_(\d+)_(\d+)$/, async (ctx) => {
  const cardIdx = parseInt(ctx.match[1]);
  const txId = parseInt(ctx.match[2]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción expirada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede confirmar.' });

  const userCards = config.tarjetas[ctx.from.id] || [];
  const cardName = userCards[cardIdx];
  if (!cardName) return ctx.answerCallbackQuery({ text: 'Tarjeta no encontrada.' });

  tx.metodoPago = cardName;
  pendingTx.set(txId, { ...tx, userId: ctx.from.id, createdAt: Date.now() });

  await showFinalConfirmation(ctx.editMessageText.bind(ctx), tx, txId);
  await ctx.answerCallbackQuery({ text: cardName });
});

// Confirmar cuota sin ajuste (remueve botones)
bot.callbackQuery(/^cuota_done:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  pendingCuotaEdit.delete(id);
  const currentText = ctx.callbackQuery.message?.text || '';
  await ctx.editMessageText(currentText, { parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery({ text: 'Listo' });
});

// Iniciar ajuste de monto cuota (para compras con interés)
bot.callbackQuery(/^cuota_adjust:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pending = pendingCuotaEdit.get(id);

  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede ajustar.' });

  pending.waitingForAmount = true;

  await ctx.editMessageText(
    `💰 *Ajustar monto de cuota*\n\n` +
    `Monto actual por cuota: ${fmtMonto(pending.montoCuota, pending.moneda)}\n\n` +
    `Enviá el nuevo monto por cuota:`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^tx_no:(\d+)$/, async (ctx) => {
  const txId = parseInt(ctx.match[1]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Ya fue cancelada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede cancelar.' });

  pendingTx.delete(txId);
  await ctx.editMessageText('❌ Transacción cancelada.');
  await ctx.answerCallbackQuery({ text: 'Cancelada' });
});

// Selección de método de pago para audio/foto (cuando la IA no lo detectó)
bot.callbackQuery(/^ap:(\d+):(\d+)$/, async (ctx) => {
  const txId = parseInt(ctx.match[1]);
  const methodIdx = parseInt(ctx.match[2]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción expirada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede confirmar.' });

  const metodo = AI_PAYMENT_METHODS[methodIdx];
  if (!metodo) return ctx.answerCallbackQuery({ text: 'Método no encontrado.' });

  tx.metodoPago = metodo;

  // Si es Tarjeta → pedir cuál tarjeta específica
  if (metodo === 'Tarjeta') {
    const userCards = config.tarjetas[ctx.from.id] || [];
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < userCards.length; i++) {
      keyboard.text(`💳 ${userCards[i]}`, `card_${i}_${txId}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (userCards.length % 2 === 1) keyboard.row();
    keyboard.text('💳 Deel Card', `card_deel_${txId}`).row();
    keyboard.text('🔄 Compartido', `photo_shared:${txId}`)
      .text('💰 Otro método', `ap_change:${txId}`).row();
    keyboard.text('❌ Cancelar', `tx_no:${txId}`);

    const preview =
      `*Nueva transacción*\n\n` +
      `📅 ${tx.fecha} ${tx.hora}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '') +
      `\n\n💳 Elegí tarjeta:`;

    await ctx.editMessageText(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
    return ctx.answerCallbackQuery();
  }

  // Otro método → confirmar directo
  const preview =
    `*Nueva transacción*\n\n` +
    `📅 ${tx.fecha} ${tx.hora}\n` +
    `📋 ${tx.descripcion}\n` +
    `🏷️ ${tx.categoria}\n` +
    `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
    `💳 ${tx.metodoPago}\n` +
    `👤 ${tx.tipo}\n` +
    `🙋 Pagado por: ${tx.pagadoPor}` +
    (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '');

  const keyboard = new InlineKeyboard()
    .text('✅ Confirmar', `tx_ok:${txId}`)
    .text('🔄 Compartido', `photo_shared:${txId}`)
    .row()
    .text('💰 Cambiar método', `ap_change:${txId}`)
    .text('❌ Cancelar', `tx_no:${txId}`);

  await ctx.editMessageText(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery({ text: metodo });
});

// Cambiar método de pago (volver a la selección de 4 opciones)
bot.callbackQuery(/^ap_change:(\d+)$/, async (ctx) => {
  const txId = parseInt(ctx.match[1]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción expirada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede modificar.' });

  tx.metodoPago = null;

  const preview =
    `*Nuevo gasto*\n\n` +
    `📋 ${tx.descripcion}\n` +
    `🏷️ ${tx.categoria}\n` +
    `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
    `👤 ${tx.tipo}\n\n` +
    `💳 *¿Con qué pagaste?*`;

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < AI_PAYMENT_METHODS.length; i++) {
    keyboard.text(AI_PAYMENT_METHODS[i], `ap:${txId}:${i}`);
    if (i % 2 === 1) keyboard.row();
  }
  if (AI_PAYMENT_METHODS.length % 2 === 1) keyboard.row();
  keyboard.text('❌ Cancelar', `tx_no:${txId}`);

  await ctx.editMessageText(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery();
});

// Toggle compartido en transacciones de foto/audio
bot.callbackQuery(/^photo_shared:(\d+)$/, async (ctx) => {
  const txId = parseInt(ctx.match[1]);
  const tx = pendingTx.get(txId);

  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción expirada.' });
  if (ctx.from.id !== tx.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede modificar.' });

  // Toggle entre compartido e individual
  if (tx.tipo === 'Compartido') {
    tx.tipo = tx.pagadoPor === 'Oriana' ? 'Individual Oriana' : 'Individual Moises';
    tx.splitMoises = tx.pagadoPor === 'Oriana' ? 0 : 100;
    tx.splitOriana = tx.pagadoPor === 'Oriana' ? 100 : 0;
  } else {
    tx.tipo = 'Compartido';
    tx.splitMoises = 50;
    tx.splitOriana = 50;
  }

  const toggleLabel = tx.tipo === 'Compartido' ? '👤 Individual' : '🔄 Compartido';

  let preview, keyboard;

  if (!tx.metodoPago) {
    // Aún sin método elegido → mostrar misma pregunta con toggle
    preview =
      `*Nuevo gasto* 📷\n\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `👤 ${tx.tipo}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '') +
      `\n\n💳 *¿Con qué pagaste?*`;

    keyboard = new InlineKeyboard();
    for (let i = 0; i < AI_PAYMENT_METHODS.length; i++) {
      keyboard.text(AI_PAYMENT_METHODS[i], `ap:${txId}:${i}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (AI_PAYMENT_METHODS.length % 2 === 1) keyboard.row();
    keyboard.text(toggleLabel, `photo_shared:${txId}`).row();
    keyboard.text('❌ Cancelar', `tx_no:${txId}`);
  } else if (tx.cuotas) {
    // Compra en cuotas → mostrar tarjetas del usuario con prefijo cuota_card_
    const montoCuota = tx.montoCuota || Math.round(tx.monto / tx.cuotas * 100) / 100;
    preview =
      `*Nueva compra en cuotas* 📷\n\n` +
      `📅 ${tx.fecha}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)} → ${tx.cuotas} cuotas de ${formatAmount(montoCuota, tx.moneda)}\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '') +
      `\n\n💳 Elegí tarjeta:`;

    const userCards = config.tarjetas[ctx.from.id] || [];
    keyboard = new InlineKeyboard();
    for (let i = 0; i < userCards.length; i++) {
      keyboard.text(`💳 ${userCards[i]}`, `cuota_card_${i}_${txId}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (userCards.length % 2 === 1) keyboard.row();
    keyboard.text(toggleLabel, `photo_shared:${txId}`).row();
    keyboard.text('❌ Cancelar', `tx_no:${txId}`);
  } else if (tx.metodoPago === 'Tarjeta') {
    preview =
      `*Nueva transacción* 📷\n\n` +
      `📅 ${tx.fecha} ${tx.hora}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `💳 Elegí tarjeta ↓\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '');

    const userCards = config.tarjetas[ctx.from.id] || [];
    keyboard = new InlineKeyboard();
    for (let i = 0; i < userCards.length; i++) {
      keyboard.text(`💳 ${userCards[i]}`, `card_${i}_${txId}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (userCards.length % 2 === 1) keyboard.row();
    keyboard.text(toggleLabel, `photo_shared:${txId}`)
      .text('💰 Otro método', `ap_change:${txId}`).row();
    keyboard.text('❌ Cancelar', `tx_no:${txId}`);
  } else {
    preview =
      `*Nueva transacción* 📷\n\n` +
      `📅 ${tx.fecha} ${tx.hora}\n` +
      `📋 ${tx.descripcion}\n` +
      `🏷️ ${tx.categoria}\n` +
      `💰 ${formatAmount(tx.monto, tx.moneda)}\n` +
      `💳 ${tx.metodoPago}\n` +
      `👤 ${tx.tipo}\n` +
      `🙋 Pagado por: ${tx.pagadoPor}` +
      (tx.tipo === 'Compartido' ? `\n📊 Split: Moises ${tx.splitMoises}% / Oriana ${tx.splitOriana}%` : '');

    keyboard = new InlineKeyboard()
      .text('✅ Confirmar', `tx_ok:${txId}`)
      .text(toggleLabel, `photo_shared:${txId}`)
      .row()
      .text('💰 Cambiar método', `ap_change:${txId}`)
      .text('❌ Cancelar', `tx_no:${txId}`);
  }

  await ctx.editMessageText(preview, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery({ text: tx.tipo });
});

// ============================================
// CALLBACKS — Borrado de transacciones
// ============================================

// Seleccion de cual borrar
bot.callbackQuery(/^del_pick:(\d+):(\d+)$/, async (ctx) => {
  const delId = parseInt(ctx.match[1]);
  const txIdx = parseInt(ctx.match[2]);
  const pending = pendingDeletes.get(delId);

  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien pidió borrar puede elegir.' });

  const tx = pending.transactions[txIdx];
  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción no encontrada.' });

  // Guardar la seleccion para confirmacion
  const confirmId = ++txCounter;
  pendingDeletes.set(confirmId, {
    transaction: tx,
    originalDelId: delId,
    userId: ctx.from.id,
    createdAt: Date.now(),
  });

  const text =
    `🗑️ *¿Borrar esta transacción?*\n\n` +
    `📅 ${tx.fecha}\n` +
    `📋 ${tx.descripcion}\n` +
    `💰 ${fmtMonto(tx.monto, tx.moneda)}\n` +
    `🏷️ ${tx.categoria}`;

  const keyboard = new InlineKeyboard()
    .text('✅ Borrar', `del_ok:${confirmId}`)
    .text('❌ Cancelar', `del_cancel:${confirmId}`);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery();
});

// Confirmar borrado
bot.callbackQuery(/^del_ok:(\d+)$/, async (ctx) => {
  const confirmId = parseInt(ctx.match[1]);
  const pending = pendingDeletes.get(confirmId);

  if (!pending || !pending.transaction) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien pidió borrar puede confirmar.' });

  const tx = pending.transaction;
  pendingDeletes.delete(confirmId);
  if (pending.originalDelId) pendingDeletes.delete(pending.originalDelId);

  try {
    await deleteTransaction(tx.row);
    await ctx.editMessageText(
      `✅ *Borrada*\n\n` +
      `📋 ${tx.descripcion} — ${fmtMonto(tx.monto, tx.moneda)}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: 'Transacción borrada' });
  } catch (error) {
    console.error('Error borrando transacción:', error.message);
    await ctx.editMessageText('❌ Error borrando la transacción. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error al borrar' });
  }
});

// Cancelar borrado (desde seleccion o confirmacion)
bot.callbackQuery(/^del_(no|cancel):(\d+)$/, async (ctx) => {
  const delId = parseInt(ctx.match[2]);
  pendingDeletes.delete(delId);
  await ctx.editMessageText('❌ Borrado cancelado.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});

// ============================================
// CALLBACKS — Saldar gastos compartidos
// ============================================

// Seleccionar gasto a saldar
bot.callbackQuery(/^sal_pick:(\d+):(\d+)$/, async (ctx) => {
  const salId = parseInt(ctx.match[1]);
  const txIdx = parseInt(ctx.match[2]);
  const pending = pendingSettle.get(salId);

  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien pidió saldar puede elegir.' });

  const tx = pending.items[txIdx];
  if (!tx) return ctx.answerCallbackQuery({ text: 'Transacción no encontrada.' });

  const confirmId = ++txCounter;
  pendingSettle.set(confirmId, {
    transaction: tx,
    originalSalId: salId,
    userId: ctx.from.id,
    createdAt: Date.now(),
  });

  let deuda;
  if (tx.pagadoPor === 'Moises') {
    deuda = `Oriana debe ${fmtMonto(tx.monto * tx.splitOriana / 100, 'ARS')} a Moises`;
  } else {
    deuda = `Moises debe ${fmtMonto(tx.monto * tx.splitMoises / 100, 'ARS')} a Oriana`;
  }

  const text =
    `🤝 *¿Saldar este gasto?*\n\n` +
    `📅 ${tx.fecha}\n` +
    `📋 ${tx.descripcion}\n` +
    `💰 ${fmtMonto(tx.monto, 'ARS')}\n` +
    `👤 Pagó ${tx.pagadoPor}\n` +
    `→ ${deuda}`;

  const keyboard = new InlineKeyboard()
    .text('✅ Saldar', `sal_ok:${confirmId}`)
    .text('❌ Cancelar', `sal_cancel:${confirmId}`);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery();
});

// Confirmar saldado
bot.callbackQuery(/^sal_ok:(\d+)$/, async (ctx) => {
  const confirmId = parseInt(ctx.match[1]);
  const pending = pendingSettle.get(confirmId);

  if (!pending || !pending.transaction) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien pidió saldar puede confirmar.' });

  const tx = pending.transaction;
  pendingSettle.delete(confirmId);
  if (pending.originalSalId) pendingSettle.delete(pending.originalSalId);

  try {
    await settleTransaction(tx.row);
    await ctx.editMessageText(
      `✅ *Saldado*\n\n` +
      `📋 ${tx.descripcion} — ${fmtMonto(tx.monto, 'ARS')}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: 'Gasto saldado' });
  } catch (error) {
    console.error('Error saldando transacción:', error.message);
    await ctx.editMessageText('❌ Error saldando la transacción. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error al saldar' });
  }
});

// Saldar todos de una vez
bot.callbackQuery(/^sal_all:(\d+)$/, async (ctx) => {
  const salId = parseInt(ctx.match[1]);
  const pending = pendingSettle.get(salId);

  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien pidió saldar puede confirmar.' });

  const items = pending.items;
  pendingSettle.delete(salId);

  try {
    for (const tx of items) {
      await settleTransaction(tx.row);
    }
    await ctx.editMessageText(
      `✅ *Saldados ${items.length} gastos compartidos*`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: `${items.length} gastos saldados` });
  } catch (error) {
    console.error('Error saldando todos:', error.message);
    await ctx.editMessageText('❌ Error saldando las transacciones. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error al saldar' });
  }
});

// Cancelar saldado (desde seleccion o confirmacion)
bot.callbackQuery(/^sal_(no|cancel):(\d+)$/, async (ctx) => {
  const salId = parseInt(ctx.match[2]);
  pendingSettle.delete(salId);
  await ctx.editMessageText('❌ Saldado cancelado.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});

// ============================================
// CALLBACKS — Gastos fijos
// ============================================

// Helper: filtrar gastos fijos relevantes para un usuario
// Moises ve Individual Moises + Compartido, Oriana ve Individual Oriana + Compartido
// Comparación case-insensitive y tolerante a variantes. Items sin tipo → visibles para ambos.
// Filtra gastos fijos que aplican al mes indicado según su frecuencia.
// Mensual → siempre. Anual → solo si month está en meses. Trimestral → idem.
function filterGastosByFrequency(gastos, month) {
  return gastos.filter(g => {
    const freq = (g.frecuencia || 'Mensual').trim();
    if (freq === 'Mensual') return true;
    const meses = (g.meses || '').split(',').map(m => parseInt(m.trim())).filter(m => !isNaN(m));
    if (meses.length === 0) return true;
    return meses.includes(month);
  });
}

function filterGastosForUser(gastos, userId) {
  const esMoises = userId === config.moisesId;
  return gastos.filter(g => {
    const tipo = (g.tipo || '').toLowerCase().trim();
    if (tipo.includes('moises')) return esMoises;
    if (tipo.includes('oriana')) return !esMoises;
    // Compartido, vacío, o desconocido → visible para ambos
    return true;
  });
}

// Helper: derivar pagadoPor y splits segun tipo de gasto
function derivePagador(tipo, userId) {
  const tipoLower = (tipo || '').toLowerCase().trim();
  if (tipoLower.includes('moises')) return { pagadoPor: 'Moises', splitMoises: 100, splitOriana: 0 };
  if (tipoLower.includes('oriana')) return { pagadoPor: 'Oriana', splitMoises: 0, splitOriana: 100 };
  const pagadoPor = userId === config.moisesId ? 'Moises' : 'Oriana';
  return { pagadoPor, splitMoises: 50, splitOriana: 50 };
}

// Helper: construir texto del listado de gastos fijos pendientes
function buildFijosText(gastos) {
  let text = `📋 *Gastos fijos pendientes*\n\n`;
  for (let i = 0; i < gastos.length; i++) {
    const g = gastos[i];
    text += `${i + 1}. ${g.descripcion} — ${fmtMonto(g.montoEstimado, g.moneda)} (${g.metodoPago})\n`;
  }
  text += `\nTotal: ${gastos.length} gastos fijos`;
  return text;
}

// Helper: reconstruir estado pendiente de gastos fijos desde el Sheet.
// Cuando el bot se reinicia, pendingFijos (en memoria) se pierde.
// En vez de devolver "Expirado", reconstruimos la lista de pendientes.
async function reconstructPendingFijos(fijoId, userId) {
  const { month, year } = getNowBA();
  const [gastos, cuotas] = await Promise.all([getGastosFijos(), getCuotas()]);
  const pendientesGF = filterGastosForUser(
    filterGastosByFrequency(gastos.filter(g => !g.registrado), month), userId
  );
  const pendientesCuotas = filterCuotasForUser(
    getPendingCuotasForMonth(cuotas, month, year), userId
  );
  if (pendientesGF.length === 0 && pendientesCuotas.length === 0) return null;
  const pending = { gastos: pendientesGF, cuotas: pendientesCuotas, userId, createdAt: Date.now() };
  pendingFijos.set(fijoId, pending);
  return pending;
}

// Registrar todos los gastos fijos pendientes
bot.callbackQuery(/^fijos_ok:(\d+)$/, async (ctx) => {
  const fijoId = parseInt(ctx.match[1]);
  let pending = pendingFijos.get(fijoId);

  if (!pending) {
    try {
      pending = await reconstructPendingFijos(fijoId, ctx.from.id);
    } catch (err) {
      console.error('Error reconstruyendo pendientes:', err.message);
      return ctx.answerCallbackQuery({ text: 'Error, intentá de nuevo.' });
    }
    if (!pending) {
      await ctx.editMessageText('✅ Todos tus gastos fijos y cuotas del mes ya están registrados.');
      return ctx.answerCallbackQuery({ text: 'Ya estaban registrados' });
    }
  }
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien inició puede confirmar.' });

  pendingFijos.delete(fijoId);
  pendingFixedEdit.delete(ctx.from.id);

  try {
    // Re-leer gastos fijos del Sheet para evitar duplicados
    const gastosActuales = await getGastosFijos();
    const registradosAhora = new Set(
      gastosActuales.filter(g => g.registrado).map(g => g.descripcion)
    );

    const aRegistrar = pending.gastos.filter(g => !registradosAhora.has(g.descripcion));
    const yaRegistrados = pending.gastos.length - aRegistrar.length;

    // Re-leer cuotas para evitar duplicados en compartidos
    const cuotasDelMes = pending.cuotas || [];
    let cuotasARegistrar = cuotasDelMes;
    if (cuotasDelMes.length > 0) {
      const { month, year } = getNowBA();
      const cuotasActuales = await getCuotas();
      const pendientesAhora = getPendingCuotasForMonth(cuotasActuales, month, year);
      const pendientesRows = new Set(pendientesAhora.map(c => c.row));
      cuotasARegistrar = cuotasDelMes.filter(c => pendientesRows.has(c.row));
    }

    if (aRegistrar.length === 0 && cuotasARegistrar.length === 0) {
      let text = '✅ Todo ya fue registrado';
      if (yaRegistrados > 0) text += ` (${yaRegistrados} por el otro usuario)`;
      await ctx.editMessageText(text + '.');
      return ctx.answerCallbackQuery({ text: 'Ya estaban registrados' });
    }

    const now = new Date();
    const options = { timeZone: 'America/Argentina/Buenos_Aires' };
    const fechaStr = now.toLocaleDateString('es-AR', { ...options, day: '2-digit', month: '2-digit', year: 'numeric' });
    const horaStr = now.toLocaleTimeString('es-AR', { ...options, hour: '2-digit', minute: '2-digit', hour12: false });

    // Armar todas las transacciones en batch (evita rate limit)
    const allTx = [];
    for (const g of aRegistrar) {
      // Usar pagadoPor del Sheet si existe; sino derivar del userId
      let pagadoPor, splitMoises, splitOriana;
      if (g.pagadoPor) {
        pagadoPor = g.pagadoPor;
        const tipoLower = (g.tipo || '').toLowerCase();
        if (tipoLower.includes('compartido')) {
          splitMoises = 50; splitOriana = 50;
        } else if (tipoLower.includes('moises')) {
          splitMoises = 100; splitOriana = 0;
        } else {
          splitMoises = 0; splitOriana = 100;
        }
      } else {
        ({ pagadoPor, splitMoises, splitOriana } = derivePagador(g.tipo, pending.userId));
      }
      let metodo = g.metodoPago;
      if (metodo === 'Tarjeta') {
        const userCards = config.tarjetas[pending.userId] || [];
        metodo = userCards[0] || 'Tarjeta';
      }
      allTx.push({
        fecha: fechaStr, hora: horaStr,
        descripcion: g.descripcion, categoria: g.categoria,
        monto: g.montoEstimado, moneda: g.moneda, metodoPago: metodo,
        tipo: g.tipo, pagadoPor, splitMoises, splitOriana,
        notas: 'Gasto fijo',
      });
    }
    for (const c of cuotasARegistrar) {
      const { pagadoPor, splitMoises, splitOriana } = derivePagador(c.tipo, pending.userId);
      allTx.push({
        fecha: fechaStr, hora: horaStr,
        descripcion: c.descripcion, categoria: c.categoria,
        monto: c.montoCuota, moneda: c.moneda, metodoPago: c.tarjeta,
        tipo: c.tipo, pagadoPor, splitMoises, splitOriana,
        notas: `Cuota ${c.cuotaNumero}/${c.cuotasTotales}`,
      });
    }

    // 1 read + 1 write en vez de N×2
    await appendTransactionsBatch(allTx);

    // Actualizar cuotas registradas en batch (1 write)
    if (cuotasARegistrar.length > 0) {
      await updateCuotasBatch(cuotasARegistrar.map(c => ({ row: c.row, count: c.cuotaNumero })));
    }

    // Budget alerts para cada categoría registrada
    const categoriasRegistradas = new Set();
    for (const g of aRegistrar) categoriasRegistradas.add(`${g.categoria}|${g.tipo}|${g.moneda}`);
    for (const c of cuotasARegistrar) categoriasRegistradas.add(`${c.categoria}|${c.tipo}|${c.moneda}`);
    for (const catKey of categoriasRegistradas) {
      const [categoria, tipo, moneda] = catKey.split('|');
      checkBudgetAlert(pending.userId, { categoria, tipo, moneda });
    }

    // Mensaje de confirmación
    const totalRegistrados = aRegistrar.length + cuotasARegistrar.length;
    let text = `✅ *${totalRegistrados} registrados*\n\n`;

    if (aRegistrar.length > 0) {
      text += '*Gastos fijos:*\n';
      for (const g of aRegistrar) {
        text += `• ${g.descripcion} — ${fmtMonto(g.montoEstimado, g.moneda)}\n`;
      }
    }
    if (cuotasARegistrar.length > 0) {
      if (aRegistrar.length > 0) text += '\n';
      text += '*Cuotas:*\n';
      for (const c of cuotasARegistrar) {
        text += `• 💳 ${c.descripcion} (Cuota ${c.cuotaNumero}/${c.cuotasTotales}) — ${fmtMonto(c.montoCuota, c.moneda)}\n`;
      }
    }
    if (yaRegistrados > 0) {
      text += `\nℹ️ ${yaRegistrados} ya habían sido registrados por el otro usuario.`;
    }

    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: 'Registrados' });
  } catch (error) {
    console.error('Error registrando gastos fijos:', error.message);
    await ctx.editMessageText('❌ Error registrando. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error al registrar' });
  }
});

// Entrar en modo edicion de monto
bot.callbackQuery(/^fijos_edit:(\d+)$/, async (ctx) => {
  const fijoId = parseInt(ctx.match[1]);
  let pending = pendingFijos.get(fijoId);

  if (!pending) {
    try {
      pending = await reconstructPendingFijos(fijoId, ctx.from.id);
    } catch (err) {
      console.error('Error reconstruyendo pendientes:', err.message);
      return ctx.answerCallbackQuery({ text: 'Error, intentá de nuevo.' });
    }
    if (!pending) {
      await ctx.editMessageText('✅ Todos tus gastos fijos y cuotas del mes ya están registrados.');
      return ctx.answerCallbackQuery({ text: 'Ya estaban registrados' });
    }
  }
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien inició puede editar.' });

  const cuotasArr = pending.cuotas || [];
  const totalItems = pending.gastos.length + cuotasArr.length;

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < totalItems; i++) {
    keyboard.text(`${i + 1}`, `fijos_pick:${fijoId}:${i}`);
  }
  keyboard.row().text('⬅️ Volver', `fijos_back:${fijoId}`);

  const text = (cuotasArr.length > 0
    ? buildFijosAndCuotasText(pending.gastos, cuotasArr)
    : buildFijosText(pending.gastos)) + '\n\n✏️ *¿Cuál querés editar?*';

  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery();
});

// Seleccionar gasto fijo o cuota para editar monto
bot.callbackQuery(/^fijos_pick:(\d+):(\d+)$/, async (ctx) => {
  const fijoId = parseInt(ctx.match[1]);
  const idx = parseInt(ctx.match[2]);
  let pending = pendingFijos.get(fijoId);

  if (!pending) {
    try {
      pending = await reconstructPendingFijos(fijoId, ctx.from.id);
    } catch (err) {
      console.error('Error reconstruyendo pendientes:', err.message);
      return ctx.answerCallbackQuery({ text: 'Error, intentá de nuevo.' });
    }
    if (!pending) {
      await ctx.editMessageText('✅ Todos tus gastos fijos y cuotas del mes ya están registrados.');
      return ctx.answerCallbackQuery({ text: 'Ya estaban registrados' });
    }
  }
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien inició puede editar.' });

  const gastosCount = pending.gastos.length;
  const cuotasArr = pending.cuotas || [];
  const isCuota = idx >= gastosCount;

  let descripcion, monto, moneda;
  if (isCuota) {
    const cuota = cuotasArr[idx - gastosCount];
    if (!cuota) return ctx.answerCallbackQuery({ text: 'Item no encontrado.' });
    descripcion = cuota.descripcion;
    monto = cuota.montoCuota;
    moneda = cuota.moneda;
  } else {
    const gasto = pending.gastos[idx];
    if (!gasto) return ctx.answerCallbackQuery({ text: 'Gasto no encontrado.' });
    descripcion = gasto.descripcion;
    monto = gasto.montoEstimado;
    moneda = gasto.moneda;
  }

  pendingFixedEdit.set(ctx.from.id, {
    fijoId,
    gastoIndex: idx,
    isCuota,
    createdAt: Date.now(),
  });

  await ctx.editMessageText(
    `✏️ *Editando: ${descripcion}*\n\n` +
    `Monto actual: ${fmtMonto(monto, moneda)}\n\n` +
    `Enviá el nuevo monto:`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Volver al listado desde edicion
bot.callbackQuery(/^fijos_back:(\d+)$/, async (ctx) => {
  const fijoId = parseInt(ctx.match[1]);
  let pending = pendingFijos.get(fijoId);

  if (!pending) {
    try {
      pending = await reconstructPendingFijos(fijoId, ctx.from.id);
    } catch (err) {
      console.error('Error reconstruyendo pendientes:', err.message);
      return ctx.answerCallbackQuery({ text: 'Error, intentá de nuevo.' });
    }
    if (!pending) {
      await ctx.editMessageText('✅ Todos tus gastos fijos y cuotas del mes ya están registrados.');
      return ctx.answerCallbackQuery({ text: 'Ya estaban registrados' });
    }
  }

  // Limpiar estado de edicion
  pendingFixedEdit.delete(ctx.from.id);

  const keyboard = new InlineKeyboard()
    .text('✅ Registrar todos', `fijos_ok:${fijoId}`)
    .row()
    .text('✏️ Editar monto', `fijos_edit:${fijoId}`)
    .text('❌ Cancelar', `fijos_no:${fijoId}`);

  const cuotasArr = pending.cuotas || [];
  const listText = cuotasArr.length > 0
    ? buildFijosAndCuotasText(pending.gastos, cuotasArr)
    : buildFijosText(pending.gastos);
  await ctx.editMessageText(listText, { parse_mode: 'Markdown', reply_markup: keyboard });
  await ctx.answerCallbackQuery();
});

// Cancelar registro de gastos fijos
bot.callbackQuery(/^fijos_no:(\d+)$/, async (ctx) => {
  const fijoId = parseInt(ctx.match[1]);
  pendingFijos.delete(fijoId);
  pendingFixedEdit.delete(ctx.from.id);
  await ctx.editMessageText('❌ Registro de gastos fijos cancelado.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});

// ============================================
// CALLBACKS — Ingresos
// ============================================

// Confirmar ingreso extra
bot.callbackQuery(/^inc_ok:(\d+)$/, async (ctx) => {
  const incId = parseInt(ctx.match[1]);
  const pending = pendingIncome.get(incId);

  if (!pending) return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede confirmar.' });

  pendingIncome.delete(incId);

  try {
    const current = await getCurrentIncome(pending.month);
    const currentVal = pending.quien === 'moises' ? current.moises : current.oriana;
    const newVal = currentVal + pending.monto;
    await updateIncome(pending.month, pending.quien, newVal);

    await ctx.editMessageText(
      `✅ *Ingreso registrado*\n\n` +
      `💵 ${fmtMonto(pending.monto, pending.moneda)} — ${pending.descripcion}\n` +
      `Total ${MESES_CORTO[pending.month - 1]}: ${fmtMonto(newVal, pending.moneda)}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery({ text: 'Ingreso registrado' });
  } catch (error) {
    console.error('Error registrando ingreso:', error.message);
    await ctx.editMessageText('❌ Error registrando el ingreso. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error al registrar' });
  }
});

// Cancelar ingreso extra
bot.callbackQuery(/^inc_no:(\d+)$/, async (ctx) => {
  const incId = parseInt(ctx.match[1]);
  pendingIncome.delete(incId);
  await ctx.editMessageText('❌ Ingreso cancelado.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});

// ============================================
// CALLBACKS — Cotización (registro de ingresos mensual)
// ============================================

bot.callbackQuery(/^cotiz_ok:(\d+)$/, async (ctx) => {
  const cotizId = parseInt(ctx.match[1]);
  const pending = pendingIncome.get(cotizId);

  if (!pending || pending.type !== 'cotizacion') return ctx.answerCallbackQuery({ text: 'Expirado.' });
  if (ctx.from.id !== pending.userId) return ctx.answerCallbackQuery({ text: 'Solo quien registró puede confirmar.' });

  pendingIncome.delete(cotizId);
  const inc = config.income;
  const accion = pending.isUpdate ? 'actualizados' : 'registrados';
  const m = pending.moises;
  const o = pending.oriana;

  try {
    // 1. Si es actualización, borrar las transacciones "Extra cotización" anteriores
    if (pending.isUpdate) {
      const transactions = await getMonthlyTransactions(pending.month, pending.year);
      const oldExtras = transactions.filter(tx => tx.descripcion.startsWith('Extra cotización'));
      for (const old of oldExtras) {
        await deleteTransaction(old.row);
      }
    }

    // 2. Registrar/actualizar ingresos en hoja Ingresos (values.update sobreescribe)
    const moisesData = {
      salario: inc.moisesSalaryUsd,
      deelKeep: m.quedaDeel,
      transfer: m.usdRedondeado,
    };
    const orianaData = o ? {
      salario: inc.orianaSalaryUsd,
      deelKeep: o.quedaDeel,
      transfer: o.usdRedondeado,
    } : null;

    await registerIncome(pending.month, moisesData, orianaData);

    // 3. Escribir TC en la columna E de Ingresos (ambos usan el mismo TC)
    const moisesRow = pending.month + 2;
    const orianaRow = pending.month + 18;
    const sheetsApi = require('./sheets').sheets;

    const tcRequests = [
      sheetsApi.spreadsheets.values.update({
        spreadsheetId: config.sheetId,
        range: `Ingresos!E${moisesRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[pending.tc]] },
      }),
    ];
    if (o) {
      tcRequests.push(sheetsApi.spreadsheets.values.update({
        spreadsheetId: config.sheetId,
        range: `Ingresos!E${orianaRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[pending.tc]] },
      }));
    }
    await Promise.all(tcRequests);

    // 4. Registrar extra USD como transacción si corresponde
    let extraMsg = '';
    if (pending.totalExtraUsd > 0.01) {
      const now = new Date();
      const options = { timeZone: 'America/Argentina/Buenos_Aires' };
      const fechaStr = now.toLocaleDateString('es-AR', { ...options, day: '2-digit', month: '2-digit', year: 'numeric' });
      const horaStr = now.toLocaleTimeString('es-AR', { ...options, hour: '2-digit', minute: '2-digit', hour12: false });

      await appendTransaction({
        fecha: fechaStr,
        hora: horaStr,
        descripcion: `Extra cotización ${MESES_CORTO[pending.month - 1]}`,
        categoria: 'Otros',
        monto: Math.round(pending.totalExtraUsd * 100) / 100,
        moneda: 'USD',
        metodoPago: 'Deel USD',
        tipo: 'Compartido',
        pagadoPor: 'Moises',
        splitMoises: 50,
        splitOriana: 50,
        notas: `TC ${pending.tc}`,
      });
      extraMsg = `\n📝 Extra total ${fmtMonto(pending.totalExtraUsd, 'USD')} registrado como transacción`;
    }

    // 5. Mensaje de confirmación (detallado para ambos)
    let confirmText =
      `✅ *Ingresos de ${MESES_CORTO[pending.month - 1]} ${accion}*\n` +
      `TC: $${pending.tc.toLocaleString('es-AR')}\n\n` +
      `*Moises:*\n` +
      `• Salario: ${fmtMonto(inc.moisesSalaryUsd, 'USD')}\n` +
      `• USD a cambiar: ${fmtMonto(m.usdRedondeado, 'USD')}\n` +
      `• Queda en Deel: ${fmtMonto(m.quedaDeel, 'USD')}\n`;

    if (o) {
      confirmText +=
        `\n*Oriana:*\n` +
        `• Salario: ${fmtMonto(inc.orianaSalaryUsd, 'USD')}\n` +
        `• USD a cambiar: ${fmtMonto(o.usdRedondeado, 'USD')}\n` +
        `• Queda en Deel: ${fmtMonto(o.quedaDeel, 'USD')}\n`;
    }

    confirmText += extraMsg;

    await ctx.editMessageText(confirmText, { parse_mode: 'Markdown' });

    // 6. Notificar al otro usuario con el mismo detalle
    const otherId = ctx.from.id === config.moisesId ? config.orianaId : config.moisesId;
    await bot.api.sendMessage(otherId, confirmText, { parse_mode: 'Markdown' });

    await ctx.answerCallbackQuery({ text: `Ingresos ${accion}` });
  } catch (error) {
    console.error('Error registrando cotización:', error.message);
    await ctx.editMessageText('❌ Error registrando los ingresos. Revisá los logs.');
    await ctx.answerCallbackQuery({ text: 'Error al registrar' });
  }
});

bot.callbackQuery(/^cotiz_no:(\d+)$/, async (ctx) => {
  const cotizId = parseInt(ctx.match[1]);
  pendingIncome.delete(cotizId);
  await ctx.editMessageText('❌ Cotización cancelada.');
  await ctx.answerCallbackQuery({ text: 'Cancelado' });
});

// ============================================
// RECORDATORIO DE INGRESOS AL INICIAR
// ============================================

async function checkIncomeReminder() {
  const inc = config.income;
  // Si no hay defaults configurados, no recordar
  if (!inc.moisesSalaryUsd || !inc.moisesSalaryArs) return;

  try {
    const { month, year } = getNowBA();
    const status = await getIncomeStatus(month);

    // Si ya estan registrados, no recordar
    if (status.moises) return;

    const text =
      `💰 Recordá registrar los ingresos de ${MESES_CORTO[month - 1]} ${year}.\n\n` +
      `Usá /cotizacion [monto] cuando tengas el tipo de cambio.\n` +
      `Ejemplo: /cotizacion 1350`;

    await Promise.all([
      bot.api.sendMessage(config.moisesId, text),
      bot.api.sendMessage(config.orianaId, text),
    ]);
    console.log(`Recordatorio de cotización enviado a ambos para ${MESES_CORTO[month - 1]} ${year}.`);
  } catch (error) {
    console.error('Error verificando ingresos:', error.message);
  }
}

// ============================================
// RECORDATORIO DE GASTOS FIJOS AL INICIAR
// ============================================

async function checkFixedExpensesReminder() {
  try {
    const { month, year } = getNowBA();
    const [gastos, cuotas] = await Promise.all([getGastosFijos(), getCuotas()]);

    const pendientes = filterGastosByFrequency(gastos.filter(g => !g.registrado), month);
    const pendientesCuotas = getPendingCuotasForMonth(cuotas, month, year);

    if (pendientes.length === 0 && pendientesCuotas.length === 0) return;

    const mesLabel = `${MESES_CORTO[month - 1]} ${year}`;

    for (const userId of [config.moisesId, config.orianaId]) {
      const userGastos = filterGastosForUser(pendientes, userId);
      const userCuotas = filterCuotasForUser(pendientesCuotas, userId);
      if (userGastos.length === 0 && userCuotas.length === 0) continue;

      cleanMap(pendingFijos);
      const fijoId = ++txCounter;
      pendingFijos.set(fijoId, {
        gastos: userGastos,
        cuotas: userCuotas,
        userId,
        createdAt: Date.now(),
      });

      const text = userCuotas.length > 0
        ? buildFijosAndCuotasText(userGastos, userCuotas).replace('*Gastos fijos y cuotas pendientes*', `*Pendientes — ${mesLabel}*`)
        : `📋 *Gastos fijos pendientes — ${mesLabel}*\n\n` +
          userGastos.map((g, i) => `${i + 1}. ${g.descripcion} — ${fmtMonto(g.montoEstimado, g.moneda)} (${g.metodoPago})`).join('\n') +
          `\n\nTotal: ${userGastos.length} gastos fijos`;

      const keyboard = new InlineKeyboard()
        .text('✅ Registrar todos', `fijos_ok:${fijoId}`)
        .row()
        .text('✏️ Editar monto', `fijos_edit:${fijoId}`)
        .text('❌ Ahora no', `fijos_no:${fijoId}`);

      await bot.api.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    console.log(`Recordatorio de gastos fijos y cuotas enviado para ${mesLabel}.`);
  } catch (error) {
    console.error('Error verificando gastos fijos:', error.message);
  }
}

// ============================================
// ARRANCAR EL BOT
// ============================================

// Graceful shutdown: Railway envía SIGTERM al re-deployar
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

bot.start({
  onStart: () => {
    console.log('Bot iniciado correctamente.');
    // Iniciar scheduler: startup checks + cron jobs
    startScheduler(bot, {
      pendingFijos,
      pendingFixedEdit,
      getTxId: () => ++txCounter,
      cleanMap,
      filterGastosForUser,
      filterGastosByFrequency,
      filterCuotasForUser,
      fmtMonto,
      getNowBA,
      getPendingCuotasForMonth,
      MESES_CORTO,
      checkIncomeReminder,
      checkFixedExpensesReminder,
      budgetAlertsSent,
    });
  },
});
