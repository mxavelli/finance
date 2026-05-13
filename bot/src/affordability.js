// Verificación de compras: simula si una compra hipotética encaja con la meta de ahorro mensual.
// El comando /puedo lo usa para responder ✅ SÍ / ⚠️ JUSTO / ❌ NO.

const config = require('./config');

// Margen mínimo en ARS para clasificar como "SÍ". Bajo este umbral pero >= 0 es "JUSTO".
const VERDICT_MARGEN_OK_ARS = 50000;
const VERDICT_MARGEN_OK_USD = 50;

// Markup para estimar la factura TC cuando no hay Pagos TC cargados.
// El consumo del mes M registrado en el bot * markup ≈ factura del mes M+1.
// (cubre cuotas de meses anteriores, percepciones IVA/IIBB, percepción RG 5617 30% sobre USD,
//  consumos no registrados en el bot pero presentes en el resumen real)
const TC_BILL_MARKUP = 1.5;

const HISTORICAL_LOOKBACK = 3;

const VERDICT_EMOJI = { SI: '✅', JUSTO: '⚠️', NO: '❌' };

function esTarjeta(metodo) {
  return metodo === 'Tarjeta' || (config.todasLasTarjetas || []).includes(metodo);
}

function nextMonth(m, y) {
  return m === 12 ? { month: 1, year: y + 1 } : { month: m + 1, year: y };
}

function calcPrimeraCuota(purchaseDate, cierreDay) {
  if (cierreDay === 0 || purchaseDate.day <= cierreDay) {
    return nextMonth(purchaseDate.month, purchaseDate.year);
  }
  const next = nextMonth(purchaseDate.month, purchaseDate.year);
  return nextMonth(next.month, next.year);
}

function isFuture(month, year, today) {
  return year > today.year || (year === today.year && month > today.month);
}

function isCurrent(month, year, today) {
  return month === today.month && year === today.year;
}

// Devuelve la primera tarjeta del usuario (default cuando se detecta tarjeta genérica).
function defaultTarjetaForUser(userId) {
  const cards = config.tarjetas[userId] || [];
  return cards[0] || 'Tarjeta';
}

// Resuelve el método de pago final cuando vino genérico ("Tarjeta") o nulo.
function resolveMetodoPago(parsed, userId) {
  if (parsed.metodoPago && parsed.metodoPago !== 'Tarjeta') return parsed.metodoPago;
  if (parsed.cuotas && parsed.cuotas > 1) return defaultTarjetaForUser(userId);
  if (parsed.metodoPago === 'Tarjeta') return defaultTarjetaForUser(userId);
  return parsed.metodoPago || null;
}

// Calcula los meses afectados por una compra hipotética.
// Retorna array de { month, year, montoCuota, moneda, cuotaNumero, totalCuotas, metodoPago }
function computeImpactedMonths(parsed, today, userId) {
  const { monto, moneda, cuotas, tipo } = parsed;
  const metodoPago = resolveMetodoPago(parsed, userId);

  // Compartido: la mitad le corresponde al usuario (50/50 default)
  const tipoLower = (tipo || '').toLowerCase();
  const split = tipoLower === 'compartido' ? 0.5 : 1.0;
  const montoUsuario = monto * split;

  const totalCuotas = cuotas && cuotas > 1 ? cuotas : 1;
  const esTC = esTarjeta(metodoPago);

  // Si no es tarjeta de crédito → impacto inmediato en el mes actual (sin cuotas)
  if (!esTC) {
    return [{
      month: today.month,
      year: today.year,
      montoCuota: montoUsuario,
      moneda,
      cuotaNumero: 1,
      totalCuotas: 1,
      metodoPago,
    }];
  }

  // Tarjeta crédito: cuotas distribuidas mes a mes desde la primera cuota calculada
  const cierreDay = config.cierreTarjetas[metodoPago] || 0;
  const primera = calcPrimeraCuota(today, cierreDay);
  const cuotaAmount = montoUsuario / totalCuotas;

  const impactos = [];
  let curr = primera;
  for (let i = 0; i < totalCuotas; i++) {
    impactos.push({
      month: curr.month,
      year: curr.year,
      montoCuota: cuotaAmount,
      moneda,
      cuotaNumero: i + 1,
      totalCuotas,
      metodoPago,
    });
    curr = nextMonth(curr.month, curr.year);
  }
  return impactos;
}

// Lee snapshot de datos reales del Sheet para un mes/año.
// Calcula ingreso del usuario, banco/efectivo pagado por él, pago TC del usuario, y transferencia a Oriana.
// Si Pagos TC no está cargado, estima el bill TC desde el consumo del mes anterior * TC_BILL_MARKUP.
async function getMonthSnapshot(month, year, userId, deps) {
  const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
  const cards = config.tarjetas[userId] || [];

  let flow = null;
  try { flow = await deps.getFlowData(month, year); } catch (e) { /* ignored */ }

  let trans = [];
  try { trans = await deps.getMonthlyTransactions(month, year); } catch (e) { /* ignored */ }

  // Ingreso del usuario en ese mes (de Ingresos!recibidoArs)
  const ingreso = userId === config.moisesId
    ? (flow?.moises?.recibidoArs || 0)
    : (flow?.oriana?.recibidoArs || 0);

  // Banco/efectivo pagado por el usuario + balance compartido
  let bancoEf = 0;
  let compMoises = 0, compOriana = 0;
  for (const tx of trans) {
    if (tx.moneda !== 'ARS') continue;
    const esTC = esTarjeta(tx.metodoPago);
    const esDeel = tx.metodoPago === 'Deel Card' || tx.metodoPago === 'Deel USD';
    if (!esTC && !esDeel && tx.pagadoPor === quien) {
      bancoEf += tx.monto;
    }
    if (tx.tipo === 'Compartido') {
      if (tx.pagadoPor === 'Moises') compMoises += tx.monto;
      else if (tx.pagadoPor === 'Oriana') compOriana += tx.monto;
    }
  }

  // Bill TC del usuario: real si Pagos TC está cargado, sino estimado desde consumo prev * markup
  let pagosTC = 0;
  let pagosTCSource = 'real';
  if (flow?.pagosTC?.totalPagosTC > 0) {
    pagosTC = userId === config.moisesId
      ? (flow.pagosTC.pagoVisa || 0) + (flow.pagosTC.pagoMaster || 0)
      : (flow.pagosTC.pagoVisaBBVA || 0) + (flow.pagosTC.pagoMasterBBVA || 0);
  } else {
    pagosTCSource = 'estimado';
    // Consumo del mes anterior con tarjetas del usuario
    const prevM = month === 1 ? 12 : month - 1;
    const prevY = month === 1 ? year - 1 : year;
    let prevTrans = [];
    try { prevTrans = await deps.getMonthlyTransactions(prevM, prevY); } catch (e) { /* ignored */ }
    let consumo = 0;
    for (const tx of prevTrans) {
      if (tx.moneda !== 'ARS') continue;
      if (cards.includes(tx.metodoPago)) consumo += tx.monto;
    }
    pagosTC = consumo * TC_BILL_MARKUP;
  }

  // Balance compartido neto desde la perspectiva del usuario.
  // transferOut: lo que el usuario tiene que pagar al otro (sale de su cuenta).
  // transferIn: lo que el otro le debe (entra a su cuenta).
  // Como mucho uno de los dos es positivo por mes.
  const totalComp = compMoises + compOriana;
  const corresponde = totalComp / 2;
  const balanceMoises = compMoises - corresponde;
  const transferOut = userId === config.moisesId
    ? Math.max(0, -balanceMoises)
    : Math.max(0, balanceMoises);
  const transferIn = userId === config.moisesId
    ? Math.max(0, balanceMoises)
    : Math.max(0, -balanceMoises);

  return {
    ingreso,
    bancoEf,
    pagosTC,
    transferOut,
    transferIn,
    pagosTCSource,
    hasIngreso: ingreso > 0,
    hasBancoEf: bancoEf > 0,
    hasComp: totalComp > 0,
  };
}

// Computa promedios de los últimos N meses con datos.
async function computeBaseline(userId, today, deps) {
  let m = today.month, y = today.year;
  const months = [];
  for (let i = 0; i < HISTORICAL_LOOKBACK; i++) {
    if (m === 1) { m = 12; y--; } else { m--; }
    months.push({ month: m, year: y });
  }

  let sumIng = 0, sumBE = 0, sumTC = 0, sumOut = 0, sumIn = 0;
  let cIng = 0, cBE = 0, cTC = 0, cTr = 0;

  for (const { month, year } of months) {
    const s = await getMonthSnapshot(month, year, userId, deps);
    if (s.hasIngreso) { sumIng += s.ingreso; cIng++; }
    if (s.hasBancoEf) { sumBE += s.bancoEf; cBE++; }
    if (s.pagosTC > 0) { sumTC += s.pagosTC; cTC++; }
    if (s.hasComp) { sumOut += s.transferOut; sumIn += s.transferIn; cTr++; }
  }

  return {
    avgIngreso: cIng > 0 ? sumIng / cIng : 0,
    avgBancoEf: cBE > 0 ? sumBE / cBE : 0,
    avgPagosTC: cTC > 0 ? sumTC / cTC : 0,
    avgTransferOut: cTr > 0 ? sumOut / cTr : 0,
    avgTransferIn: cTr > 0 ? sumIn / cTr : 0,
    monthsUsed: { ing: cIng, be: cBE, tc: cTC, tr: cTr },
  };
}

// Para meses futuros, blendea snapshot con baseline (usa baseline si snap está vacío).
function blendForFuture(snap, baseline) {
  return {
    ingreso: snap.hasIngreso ? snap.ingreso : baseline.avgIngreso,
    bancoEf: snap.hasBancoEf ? snap.bancoEf : baseline.avgBancoEf,
    pagosTC: snap.pagosTC > 0 ? snap.pagosTC : baseline.avgPagosTC,
    transferOut: snap.hasComp ? snap.transferOut : baseline.avgTransferOut,
    transferIn: snap.hasComp ? snap.transferIn : baseline.avgTransferIn,
    pagosTCSource: snap.pagosTC > 0 ? snap.pagosTCSource : 'baseline',
  };
}

// Proyecta el sobrante post-deudas para un mes específico.
async function projectMonthSobrante(month, year, userId, today, deps, baseline) {
  const snap = await getMonthSnapshot(month, year, userId, deps);
  const data = isFuture(month, year, today) ? blendForFuture(snap, baseline) : snap;
  const sobrante = data.ingreso + data.transferIn - data.bancoEf - data.pagosTC - data.transferOut;
  return { ...data, sobrante, isCurrent: isCurrent(month, year, today), isFuture: isFuture(month, year, today) };
}

function decideVerdict(libreFinal, moneda) {
  const margen = moneda === 'USD' ? VERDICT_MARGEN_OK_USD : VERDICT_MARGEN_OK_ARS;
  if (libreFinal >= margen) return 'SI';
  if (libreFinal >= 0) return 'JUSTO';
  return 'NO';
}

// Orquestador principal. Retorna análisis completo de la compra hipotética.
async function simulateAffordability(parsed, userId, today, deps) {
  const impactos = computeImpactedMonths(parsed, today, userId);

  // Meta de ahorro del usuario
  const presupuestos = await deps.getPresupuestos();
  const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
  const moneda = parsed.moneda || 'ARS';
  const metaKey = `Ahorro / Inversión|Individual ${quien}|${moneda}`;
  const savingsTarget = presupuestos.get(metaKey) || 0;

  const baseline = await computeBaseline(userId, today, deps);

  const results = [];
  let worst = null;
  for (const imp of impactos) {
    const proj = await projectMonthSobrante(imp.month, imp.year, userId, today, deps, baseline);
    const libreFinal = proj.sobrante - imp.montoCuota - savingsTarget;
    const verdict = decideVerdict(libreFinal, moneda);
    const result = { ...imp, proj, libreFinal, verdict };
    results.push(result);
    if (!worst || libreFinal < worst.libreFinal) worst = result;
  }

  return {
    parsed,
    metodoPago: resolveMetodoPago(parsed, userId),
    impactos,
    results,
    worst,
    savingsTarget,
    baseline,
    quien,
    verdictGlobal: worst ? worst.verdict : 'NO',
  };
}

module.exports = {
  computeImpactedMonths,
  computeBaseline,
  projectMonthSobrante,
  decideVerdict,
  simulateAffordability,
  resolveMetodoPago,
  esTarjeta,
  calcPrimeraCuota,
  VERDICT_EMOJI,
  TC_BILL_MARKUP,
};
