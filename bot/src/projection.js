// Proyección financiera per-user para un mes futuro.
// Combina datos exactos del Sheet (fijos, cuotas) con estimaciones históricas (variables).

const config = require('./config');
const { computeBaseline } = require('./affordability');

const VERDICT_EMOJI = { SI: '✅', JUSTO: '⚠️', NO: '❌' };

// Retorna fecha actual en Buenos Aires como { month, year }.
function nowBA() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

// buildProjection: calcula todos los componentes de la proyección para un mes/año y usuario.
// fijosUser: ya filtrados por frecuencia+mes Y por usuario (Individual + Compartido).
// cuotasUser: ya filtradas para el mes objetivo Y por usuario, con cuotaNumero inyectado.
// deps = { getFlowData, getMonthlyTransactions, getPresupuestos }
async function buildProjection(targetMonth, targetYear, userId, fijosUser, cuotasUser, deps) {
  const { getFlowData, getMonthlyTransactions, getPresupuestos } = deps;
  const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
  const today = nowBA();

  // 1. Ingreso ARS: config o fallback a historial
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

  // 5. Variable ARS: baseline histórico (bancoEf + pagosTC) menos fijos y cuotas
  const baseline = await computeBaseline(userId, today, { getFlowData, getMonthlyTransactions });
  const historialTotal = baseline.avgBancoEf + baseline.avgPagosTC;
  const variablesArs = Math.max(0, historialTotal - fijosArs - cuotasArs);
  const fromMonths = Math.max(baseline.monthsUsed.be, baseline.monthsUsed.tc);

  // 6. Variable USD: promedio últimos 3 meses de gastos USD del usuario
  let sumUsd = 0, countUsd = 0;
  for (let i = 1; i <= 3; i++) {
    let m = today.month - i, y = today.year;
    if (m <= 0) { m += 12; y--; }
    try {
      const trans = await getMonthlyTransactions(m, y);
      const userUsd = trans
        .filter(t => t.moneda === 'USD' && (
          t.pagadoPor === quien || (t.tipo || '').toLowerCase().includes('compartido')
        ))
        .reduce((sum, t) => {
          const isComp = (t.tipo || '').toLowerCase().includes('compartido');
          return sum + (isComp ? t.monto * 0.5 : t.monto);
        }, 0);
      if (userUsd > 0) { sumUsd += userUsd; countUsd++; }
    } catch (_) { /* ignorado */ }
  }
  const variablesUsd = Math.max(0, countUsd > 0 ? (sumUsd / countUsd) - fijosUsd : 0);

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
