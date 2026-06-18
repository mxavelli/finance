// Verificación de compras: simula si una compra hipotética encaja con la meta de ahorro mensual.
// El comando /puedo lo usa para responder ✅ SÍ / ⚠️ JUSTO / ❌ NO.
//
// Reusa buildProjection (mismo motor que /proyeccion) para calcular el sobrante de cada mes
// impactado por la compra, y le resta la cuota de la compra + meta de ahorro.
// Antes tenía su propio modelo (snapshot + estimado TC×1.5) que inflaba los gastos —
// ver fix equivalente en projection.js.

const config = require('./config');
const { buildProjection } = require('./projection');

// Margen mínimo para clasificar como "SÍ". Bajo este umbral pero >= 0 es "JUSTO".
const VERDICT_MARGEN_OK_ARS = 50000;
const VERDICT_MARGEN_OK_USD = 50;

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

function decideVerdict(libreFinal, moneda) {
  const margen = moneda === 'USD' ? VERDICT_MARGEN_OK_USD : VERDICT_MARGEN_OK_ARS;
  if (libreFinal >= margen) return 'SI';
  if (libreFinal >= 0) return 'JUSTO';
  return 'NO';
}

// Orquestador principal. Retorna análisis completo de la compra hipotética.
// deps = { getFlowData, getMonthlyTransactions, getPresupuestos, getGastosFijos, getCuotas,
//          filterGastosForUser, filterGastosByFrequency, filterCuotasForUser, getPendingCuotasForMonth }
async function simulateAffordability(parsed, userId, today, deps) {
  const impactos = computeImpactedMonths(parsed, today, userId);
  const quien = userId === config.moisesId ? 'Moises' : 'Oriana';
  const moneda = parsed.moneda || 'ARS';

  const [presupuestos, fijosRaw, cuotasRaw] = await Promise.all([
    deps.getPresupuestos(),
    deps.getGastosFijos(),
    deps.getCuotas(),
  ]);
  const savingsTarget = presupuestos.get(`Ahorro / Inversión|Individual ${quien}|${moneda}`) || 0;

  const results = [];
  let worst = null;
  for (const imp of impactos) {
    const fijosUser = deps.filterGastosForUser(deps.filterGastosByFrequency(fijosRaw, imp.month), userId);
    const cuotasUser = deps.filterCuotasForUser(deps.getPendingCuotasForMonth(cuotasRaw, imp.month, imp.year), userId);

    const proj = await buildProjection(imp.month, imp.year, userId, fijosUser, cuotasUser, deps);
    const sobrante = moneda === 'USD' ? proj.sobranteUsd : proj.sobranteArs;
    const libreFinal = sobrante - imp.montoCuota - savingsTarget;
    const verdict = decideVerdict(libreFinal, moneda);

    const result = { ...imp, sobrante, libreFinal, verdict };
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
    quien,
    verdictGlobal: worst ? worst.verdict : 'NO',
  };
}

module.exports = {
  computeImpactedMonths,
  decideVerdict,
  simulateAffordability,
  resolveMetodoPago,
  esTarjeta,
  calcPrimeraCuota,
  VERDICT_EMOJI,
};
