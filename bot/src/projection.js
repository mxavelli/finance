// Proyección financiera per-user para un mes futuro.
// Combina datos exactos del Sheet (fijos, cuotas) con estimaciones históricas (variables).
//
// Modelo de variables:
//   Promedio de transacciones ARS/USD reales del usuario en los últimos 3 meses,
//   menos fijos y cuotas conocidos. Evita usar el estimado de facturas TC (×1.5)
//   que infla los gastos cuando Pagos TC no está cargado en el Sheet.

const config = require('./config');

const VERDICT_EMOJI = { SI: '✅', JUSTO: '⚠️', NO: '❌' };

// Retorna fecha actual en Buenos Aires como { month, year }.
function nowBA() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

// Promedia el gasto histórico real del usuario sumando transacciones de los últimos N meses.
// Incluye: transacciones donde pagadoPor = quien, o tipo = Compartido (al 50%).
// Esto evita el problema del estimado TC × 1.5 de affordability.js.
async function avgTransactionSpend(quien, moneda, monthsBack, today, getMonthlyTransactions) {
  let total = 0, count = 0;
  for (let i = 1; i <= monthsBack; i++) {
    let m = today.month - i, y = today.year;
    if (m <= 0) { m += 12; y--; }
    try {
      const trans = await getMonthlyTransactions(m, y);
      const monthSum = trans
        .filter(t => t.moneda === moneda && (
          t.pagadoPor === quien || (t.tipo || '').toLowerCase().includes('compartido')
        ))
        .reduce((sum, t) => {
          const isComp = (t.tipo || '').toLowerCase().includes('compartido');
          return sum + (isComp ? t.monto * 0.5 : t.monto);
        }, 0);
      if (monthSum > 0) { total += monthSum; count++; }
    } catch (_) { /* mes sin datos */ }
  }
  return { avg: count > 0 ? total / count : 0, fromMonths: count };
}

// buildProjection: calcula todos los componentes de la proyección para un mes/año y usuario.
// fijosUser: ya filtrados por frecuencia+mes Y por usuario (Individual + Compartido).
// cuotasUser: ya filtradas para el mes objetivo Y por usuario, con cuotaNumero inyectado.
// deps = { getFlowData, getMonthlyTransactions, getPresupuestos }
async function buildProjection(targetMonth, targetYear, userId, fijosUser, cuotasUser, deps) {
  const { getFlowData, getMonthlyTransactions, getPresupuestos } = deps;
  const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
  const today = nowBA();

  // 1. Ingreso ARS: config o fallback a último mes con datos
  let incomeArs = 0;
  let incomeSource = 'config';
  const salaryArs = quien === 'Moises' ? config.income.moisesSalaryArs : config.income.orianaSalaryArs;
  if (salaryArs) {
    incomeArs = salaryArs;
  } else {
    incomeSource = 'historial';
    for (let i = 1; i <= 3; i++) {
      let m = today.month - i, y = today.year;
      if (m <= 0) { m += 12; y--; }
      try {
        const flow = await getFlowData(m, y);
        const rec = quien === 'Moises' ? flow?.moises?.recibidoArs : flow?.oriana?.recibidoArs;
        if (rec > 0) { incomeArs = rec; break; }
      } catch (_) { /* ignorado */ }
    }
  }

  // 2. Ingreso USD y TC del último mes con datos
  const salaryUsd = quien === 'Moises' ? config.income.moisesSalaryUsd : config.income.orianaSalaryUsd;
  const incomeUsd = salaryUsd || 0;
  let tc = 0;
  for (let i = 1; i <= 6; i++) {
    let m = today.month - i, y = today.year;
    if (m <= 0) { m += 12; y--; }
    try {
      const flow = await getFlowData(m, y);
      if (flow?.moises?.tc > 0) { tc = flow.moises.tc; break; }
    } catch (_) { /* ignorado */ }
  }

  // USD a convertir = salaryArs / TC redondeado al próximo múltiplo de 50
  let usdACambiar = 0;
  let quedaDeel = incomeUsd;
  if (tc > 0 && salaryArs > 0) {
    usdACambiar = Math.min(incomeUsd, Math.ceil((salaryArs / tc) / 50) * 50);
    quedaDeel = Math.max(0, incomeUsd - usdACambiar);
  }

  // 3. Fijos: separar por moneda, compartido al 50%
  let fijosArs = 0, fijosUsd = 0;
  const fijoItems = [];
  for (const f of fijosUser) {
    const isCompartido = (f.tipo || '').toLowerCase().includes('compartido');
    const factor = isCompartido ? 0.5 : 1.0;
    const montoUsuario = (f.montoEstimado || 0) * factor;
    if (f.moneda === 'USD') fijosUsd += montoUsuario;
    else fijosArs += montoUsuario;
    fijoItems.push({ descripcion: f.descripcion, moneda: f.moneda, metodoPago: f.metodoPago, montoUsuario, isCompartido });
  }

  // 4. Cuotas: siempre ARS, compartido al 50%
  let cuotasArs = 0;
  const cuotaItems = [];
  for (const c of cuotasUser) {
    const isCompartido = (c.tipo || '').toLowerCase().includes('compartido');
    const factor = isCompartido ? 0.5 : 1.0;
    const montoUsuario = (c.montoCuota || 0) * factor;
    cuotasArs += montoUsuario;
    cuotaItems.push({ descripcion: c.descripcion, tarjeta: c.tarjeta, cuotaNumero: c.cuotaNumero, cuotasTotales: c.cuotasTotales, montoUsuario, isCompartido });
  }

  // 5. Variable ARS: promedio de transacciones reales del usuario (últimos 3 meses)
  //    menos fijos y cuotas (ya contabilizados explícitamente arriba).
  //    No usa computeBaseline/pagosTC para evitar inflación por estimado TC × 1.5.
  const { avg: avgTxArs, fromMonths } = await avgTransactionSpend(quien, 'ARS', 3, today, getMonthlyTransactions);
  const variablesArs = Math.max(0, avgTxArs - fijosArs - cuotasArs);

  // 6. Variable USD: igual para USD
  const { avg: avgTxUsd } = await avgTransactionSpend(quien, 'USD', 3, today, getMonthlyTransactions);
  const variablesUsd = Math.max(0, avgTxUsd - fijosUsd);

  // 7. Meta de ahorro
  const presupuestos = await getPresupuestos();
  const metaAhorro = presupuestos.get(`Ahorro / Inversión|Individual ${quien}|ARS`) || 0;

  // 8. Totales ARS
  const gastosArs = fijosArs + cuotasArs + variablesArs;
  const sobranteArs = incomeArs - gastosArs;
  const libreArs = sobranteArs - metaAhorro;
  const verdictArs = libreArs >= 50000 ? 'SI' : libreArs >= 0 ? 'JUSTO' : 'NO';

  // 9. Totales USD
  const gastosUsd = fijosUsd + variablesUsd;
  const sobranteUsd = quedaDeel - gastosUsd;

  return {
    quien, targetMonth, targetYear,
    incomeArs, incomeSource,
    incomeUsd, tc, usdACambiar, quedaDeel,
    fijoItems, fijosArs, fijosUsd,
    cuotaItems, cuotasArs,
    variablesArs, variablesUsd, fromMonths,
    metaAhorro,
    gastosArs, sobranteArs, libreArs, verdictArs,
    gastosUsd, sobranteUsd,
  };
}

module.exports = { buildProjection, VERDICT_EMOJI };
