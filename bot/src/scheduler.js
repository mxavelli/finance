// Planificador de tareas automáticas.
// Cron jobs: auto-registro gastos fijos diario + resumen semanal.

const cron = require('node-cron');
const { InlineKeyboard } = require('grammy');
const config = require('./config');
const {
  getGastosFijos, getCuotas, getMonthlyTransactions,
  getPresupuestos, getBalance,
} = require('./sheets');

// --- Auto-fijos diario ---
// Revisa si hay gastos fijos con día = hoy. Si hay, manda preview a cada usuario.

async function checkDailyAutoFijos(bot, ctx) {
  const { month, year, day } = ctx.getNowBA();
  const [gastos, cuotas] = await Promise.all([getGastosFijos(), getCuotas()]);

  // Filtrar gastos fijos que vencen HOY y no están registrados
  const dueToday = gastos.filter(g => !g.registrado && parseInt(g.dia) === day);

  // Cuotas pendientes del mes (no tienen día específico, se incluyen si hay gastos fijos hoy)
  const cuotasPendientes = ctx.getPendingCuotasForMonth(cuotas, month, year);

  if (dueToday.length === 0 && cuotasPendientes.length === 0) return;

  const mesLabel = `${ctx.MESES_CORTO[month - 1]} ${year}`;

  for (const userId of [config.moisesId, config.orianaId]) {
    const userGastos = ctx.filterGastosForUser(dueToday, userId);
    const userCuotas = ctx.filterCuotasForUser(cuotasPendientes, userId);
    if (userGastos.length === 0 && userCuotas.length === 0) continue;

    ctx.cleanMap(ctx.pendingFijos);
    const fijoId = ctx.getTxId();
    ctx.pendingFijos.set(fijoId, {
      gastos: userGastos,
      cuotas: userCuotas,
      userId,
      createdAt: Date.now(),
    });

    // Armar texto
    let text;
    if (userCuotas.length > 0) {
      text = `📅 *Gastos del día ${day}/${month} — ${mesLabel}*\n\n`;
      let idx = 1;
      if (userGastos.length > 0) {
        text += '*Gastos fijos:*\n';
        for (const g of userGastos) {
          text += `${idx}. ${g.descripcion} — ${ctx.fmtMonto(g.montoEstimado, g.moneda)} (${g.metodoPago})\n`;
          idx++;
        }
        text += '\n';
      }
      text += '*Cuotas:*\n';
      for (const c of userCuotas) {
        text += `${idx}. 💳 ${c.descripcion} (Cuota ${c.cuotaNumero}/${c.cuotasTotales}) — ${ctx.fmtMonto(c.montoCuota, c.moneda)} (${c.tarjeta})\n`;
        idx++;
      }
      text += `\nTotal: ${userGastos.length + userCuotas.length} pendientes`;
    } else {
      text = `📅 *Gastos fijos del día ${day}/${month} — ${mesLabel}*\n\n`;
      text += userGastos.map((g, i) =>
        `${i + 1}. ${g.descripcion} — ${ctx.fmtMonto(g.montoEstimado, g.moneda)} (${g.metodoPago})`
      ).join('\n');
      text += `\n\nTotal: ${userGastos.length} gastos fijos`;
    }

    const keyboard = new InlineKeyboard()
      .text('✅ Registrar todos', `fijos_ok:${fijoId}`)
      .row()
      .text('✏️ Editar monto', `fijos_edit:${fijoId}`)
      .text('❌ Ahora no', `fijos_no:${fijoId}`);

    await bot.api.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  console.log(`Auto-fijos: ${dueToday.length} gastos del día ${day}/${month} enviados.`);
}


// --- Resumen semanal ---
// Lunes 9 AM: resumen de la última semana para ambos usuarios.

async function sendWeeklySummary(bot, ctx) {
  const { month, year, day } = ctx.getNowBA();

  // Cargar transacciones del mes (y del anterior si estamos en los primeros 7 días)
  let transactions = await getMonthlyTransactions(month, year);
  if (day <= 7) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevTx = await getMonthlyTransactions(prevMonth, prevYear);
    transactions = [...prevTx, ...transactions];
  }

  // Calcular rango: últimos 7 días
  const now = new Date();
  const baOffset = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const today = new Date(baOffset.getFullYear(), baOffset.getMonth(), baOffset.getDate());
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const weekTx = transactions.filter(tx => {
    const parts = tx.fecha.split('/');
    if (parts.length !== 3) return false;
    const txDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    return txDate >= sevenDaysAgo && txDate < today;
  });

  if (weekTx.length === 0) return;

  // Totales
  let totalArs = 0, totalUsd = 0;
  const porCategoria = {};
  const porTipo = {};

  for (const tx of weekTx) {
    if (tx.moneda === 'USD') totalUsd += tx.monto;
    else totalArs += tx.monto;
    porCategoria[tx.categoria] = (porCategoria[tx.categoria] || 0) + tx.monto;
    const tipo = tx.tipo || 'Sin tipo';
    porTipo[tipo] = (porTipo[tipo] || 0) + tx.monto;
  }

  // Top 5 categorías
  const topCats = Object.entries(porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const fmtMonto = ctx.fmtMonto;

  let text = `📊 *Resumen semanal — ${ctx.MESES_CORTO[month - 1]} ${year}*\n\n`;
  text += `💰 *Total semana:* ${fmtMonto(totalArs, 'ARS')}`;
  if (totalUsd > 0) text += ` | ${fmtMonto(totalUsd, 'USD')}`;
  text += `\n📝 ${weekTx.length} transacciones\n`;

  // Top categorías
  if (topCats.length > 0) {
    text += '\n*Top categorías:*\n';
    for (const [cat, monto] of topCats) {
      text += `• ${cat}: ${fmtMonto(monto, 'ARS')}\n`;
    }
  }

  // Por tipo
  const tipoEntries = Object.entries(porTipo).sort((a, b) => b[1] - a[1]);
  if (tipoEntries.length > 0) {
    text += '\n*Por tipo:*\n';
    for (const [tipo, monto] of tipoEntries) {
      text += `• ${tipo}: ${fmtMonto(monto, 'ARS')}\n`;
    }
  }

  // Balance compartido del mes
  try {
    const balance = await getBalance();
    if (balance.meses && balance.meses[month - 1]) {
      const mes = balance.meses[month - 1];
      if (mes.total > 0 && mes.resultado) {
        text += `\n*Balance compartido del mes:*\n`;
        text += `→ ${mes.resultado}\n`;
      }
    }
  } catch (err) {
    console.error('Error obteniendo balance para resumen:', err.message);
  }

  // Alertas de presupuesto (categorías en amarillo/rojo) + estado de ahorro
  try {
    const presupuestos = await getPresupuestos();
    const allMonthTx = await getMonthlyTransactions(month, year);
    const alerts = [];
    const savingsAlerts = [];

    for (const [key, budget] of presupuestos) {
      const [categoria, tipo, moneda] = key.split('|');
      const total = allMonthTx
        .filter(t => t.categoria === categoria && t.tipo === tipo && t.moneda === moneda)
        .reduce((sum, t) => sum + t.monto, 0);
      const pct = budget > 0 ? (total / budget) * 100 : 0;

      if (CATEGORIAS_POSITIVAS.includes(categoria)) {
        // Categorías positivas: mostrar progreso de meta
        const emoji = pct >= 100 ? '✅' : pct >= 80 ? '📈' : '📉';
        savingsAlerts.push(`${emoji} ${categoria} (${tipo}): ${Math.round(pct)}% (${fmtMonto(total, moneda)} / ${fmtMonto(budget, moneda)})`);
      } else if (pct >= 80) {
        const emoji = pct >= 100 ? '🔴' : '🟡';
        alerts.push(`${emoji} ${categoria}: ${Math.round(pct)}% (${fmtMonto(total, moneda)} / ${fmtMonto(budget, moneda)})`);
      }
    }

    if (alerts.length > 0) {
      text += '\n*Presupuesto:*\n';
      for (const a of alerts) text += `${a}\n`;
    }
    if (savingsAlerts.length > 0) {
      text += '\n*Meta de ahorro:*\n';
      for (const a of savingsAlerts) text += `${a}\n`;
    }
  } catch (err) {
    console.error('Error obteniendo presupuestos para resumen:', err.message);
  }

  // Enviar a ambos
  await Promise.all([
    bot.api.sendMessage(config.moisesId, text, { parse_mode: 'Markdown' }),
    bot.api.sendMessage(config.orianaId, text, { parse_mode: 'Markdown' }),
  ]);

  console.log(`Resumen semanal enviado (${weekTx.length} tx de la semana).`);
}


// --- Alerta de ahorro bajo ---
// Del día 25 en adelante, revisa si las categorías positivas (Ahorro / Inversión)
// están por debajo del 80% de la meta. Alerta una vez por mes por categoría.

const CATEGORIAS_POSITIVAS = ['Ahorro / Inversión'];

async function checkSavingsAlert(bot, ctx) {
  const { month, year, day } = ctx.getNowBA();
  if (day < 25) return;

  const presupuestos = await getPresupuestos();
  const transactions = await getMonthlyTransactions(month, year);
  const fmtMonto = ctx.fmtMonto;

  for (const [key, budget] of presupuestos) {
    const [categoria, tipo, moneda] = key.split('|');
    if (!CATEGORIAS_POSITIVAS.includes(categoria)) continue;
    if (budget <= 0) continue;

    const totalAhorrado = transactions
      .filter(t => t.categoria === categoria && t.tipo === tipo && t.moneda === moneda)
      .reduce((sum, t) => sum + t.monto, 0);

    const pct = (totalAhorrado / budget) * 100;
    if (pct >= 80) continue; // Va bien, no alertar

    const alertKey = `savings|${key}|${month}|${year}`;
    if (ctx.budgetAlertsSent.has(alertKey)) continue;
    ctx.budgetAlertsSent.set(alertKey, Date.now());

    const pctStr = Math.round(pct);
    const text =
      `📉 *Meta de ahorro*\n\n` +
      `Vas ${pctStr}% de tu meta de *${categoria}* (${tipo}).\n` +
      `Ahorrado: ${fmtMonto(totalAhorrado, moneda)} / ${fmtMonto(budget, moneda)}\n` +
      `Quedan ${daysLeftInMonth(year, month, day)} días para alcanzar tu meta.`;

    const tipoLower = (tipo || '').toLowerCase();
    const recipients = tipoLower.includes('moises') ? [config.moisesId]
      : tipoLower.includes('oriana') ? [config.orianaId]
      : [config.moisesId, config.orianaId];

    for (const rid of recipients) {
      await bot.api.sendMessage(rid, text, { parse_mode: 'Markdown' });
    }
  }
}

function daysLeftInMonth(year, month, currentDay) {
  const lastDay = new Date(year, month, 0).getDate();
  return lastDay - currentDay;
}


// --- Entry point ---

function startScheduler(bot, ctx) {
  // Startup checks (migrados desde index.js)
  setTimeout(() => ctx.checkIncomeReminder(), 3000);
  setTimeout(() => ctx.checkFixedExpensesReminder(), 5000);

  // Diario 9:00 AM Buenos Aires — auto registro gastos fijos por día
  cron.schedule('0 9 * * *', () => {
    checkDailyAutoFijos(bot, ctx).catch(err =>
      console.error('Error en auto-fijos diario:', err.message)
    );
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Diario 20:00 (8 PM) Buenos Aires — alerta de ahorro bajo (día 25+)
  cron.schedule('0 20 * * *', () => {
    checkSavingsAlert(bot, ctx).catch(err =>
      console.error('Error en alerta de ahorro:', err.message)
    );
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Lunes 9:00 AM Buenos Aires — resumen semanal
  cron.schedule('0 9 * * 1', () => {
    sendWeeklySummary(bot, ctx).catch(err =>
      console.error('Error en resumen semanal:', err.message)
    );
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Primer día de cada mes a medianoche — limpiar alertas de presupuesto
  cron.schedule('0 0 1 * *', () => {
    ctx.budgetAlertsSent.clear();
    console.log('Alertas de presupuesto reseteadas para el nuevo mes.');
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('Scheduler iniciado: auto-fijos 9:00, ahorro 20:00, resumen semanal lunes 9:00.');
}

module.exports = { startScheduler };
