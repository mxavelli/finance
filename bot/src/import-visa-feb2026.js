// Importación masiva de transacciones Visa Galicia — Ciclo Ene-Feb 2026
// Carga todas las transacciones del resumen de tarjeta al Google Sheet.
//
// Uso:
//   node bot/src/import-visa-feb2026.js              (resumen, NO importa)
//   node bot/src/import-visa-feb2026.js --go          (importa de verdad)
//   node bot/src/import-visa-feb2026.js --go --fijos  (incluye gastos fijos que pueden estar duplicados)

const { sheets } = require('./sheets');
const config = require('./config');

const EJECUTAR = process.argv.includes('--go');
const INCLUIR_FIJOS = process.argv.includes('--fijos');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tx(fecha, descripcion, monto, categoria, moneda = 'ARS') {
  return {
    fecha,
    hora: '12:00',
    descripcion,
    categoria,
    monto,
    moneda,
    metodoPago: 'Visa Galicia',
    tipo: 'Individual Moises',
    pagadoPor: 'Moises',
    splitMoises: 100,
    splitOriana: 0,
    notas: 'Importado resumen Visa',
  };
}

function cuota(fecha, descripcion, categoria, cuotas, montoCuota) {
  return {
    descripcion,
    categoria,
    montoTotal: Math.round(montoCuota * cuotas),
    cuotasTotales: cuotas,
    montoCuota,
    moneda: 'ARS',
    tarjeta: 'Visa Galicia',
    tipo: 'Individual Moises',
    pagadoPor: 'Moises',
    fechaCompra: fecha,
    primeraCuota: '02/2026', // Todas caen en el ciclo Feb (pago Marzo)
  };
}

// ─── GASTOS FIJOS (probablemente ya registrados via auto-fijos) ───────────────
// Solo se importan si pasás --fijos

const gastosFijos = [
  // Enero
  tx('22/01/2026', 'Claude AI', 100, 'Suscripciones', 'USD'),
  tx('26/01/2026', 'Swiss Medical Prepaga', 282181.53, 'Salud'),
  tx('29/01/2026', 'Apple Services', 5.19, 'Suscripciones', 'USD'),
  tx('30/01/2026', 'Apple iCloud', 2.99, 'Suscripciones', 'USD'),
  // Febrero
  tx('06/02/2026', 'Apple One', 10.99, 'Suscripciones', 'USD'),
  tx('10/02/2026', 'Netflix', 18.02, 'Suscripciones', 'USD'),
  tx('16/02/2026', 'DirecTV', 30300, 'Hogar'),
  tx('19/02/2026', 'Caja Seguros', 23671, 'Seguros'),
  tx('22/02/2026', 'Claude AI', 100, 'Suscripciones', 'USD'),
];

// ─── CUOTAS NUEVAS (primera cuota) ───────────────────────────────────────────
// Se registran en Cuotas + como transacción

const cuotasNuevas = [
  cuota('25/01/2026', 'Rentas Córdoba', 'Impuestos', 3, 54366.68),
  cuota('30/01/2026', 'Materiales NUC', 'Hogar', 6, 13949.20),
  cuota('04/02/2026', 'MercadoLibre', 'Otros', 6, 11166.70),
  cuota('05/02/2026', 'Puppis', 'Otros', 12, 31666.74),
  cuota('10/02/2026', 'MercadoLibre', 'Otros', 6, 9998.35),
  cuota('18/02/2026', 'Supermercado Argerich', 'Alimentación', 3, 1333.33),
];

// Transacciones de la primera cuota
const txCuotas = cuotasNuevas.map(c => tx(
  c.fechaCompra,
  `${c.descripcion} (cuota 1/${c.cuotasTotales})`,
  c.montoCuota,
  c.categoria,
));

// ─── TRANSACCIONES VARIABLES — ENERO (22-31) ─────────────────────────────────

const txEnero = [
  // 22/01
  tx('22/01/2026', 'PedidosYa Carrefour', 11847, 'Alimentación'),
  tx('22/01/2026', 'Shell Carcano (nafta)', 51610, 'Transporte'),
  tx('22/01/2026', 'Shell Carcano', 680, 'Transporte'),
  tx('22/01/2026', 'Regionales de la Villa', 45900, 'Otros'),
  // 23/01
  tx('23/01/2026', 'Uber', 6676, 'Transporte'),
  tx('23/01/2026', 'Peaje Corredores Viales', 1258.38, 'Transporte'),
  tx('23/01/2026', 'Peaje Corredores Viales', 1258.38, 'Transporte'),
  tx('23/01/2026', 'Peaje Corredores Viales', 1258.38, 'Transporte'),
  tx('23/01/2026', 'Peaje Corredores Viales', 1258.38, 'Transporte'),
  tx('23/01/2026', 'Peaje AUSOL', 838.93, 'Transporte'),
  tx('23/01/2026', 'Casisa', 1677, 'Otros'),
  tx('23/01/2026', 'YPF (combustible)', 1000, 'Transporte'),
  tx('23/01/2026', 'Axion Energy (nafta)', 25600, 'Transporte'),
  // 26/01
  tx('26/01/2026', 'Uber', 5222, 'Transporte'),
  tx('26/01/2026', 'Uber', 9383, 'Transporte'),
  tx('26/01/2026', 'PedidosYa McDonalds', 6959, 'Alimentación'),
  tx('26/01/2026', 'Cerini peluquería', 37000, 'Ropa y personal'),
  tx('26/01/2026', 'Wotea', 8000, 'Otros'),
  tx('26/01/2026', 'Shell (combustible)', 76999.82, 'Transporte'),
  // 27/01
  tx('27/01/2026', 'Supermercado Argerich', 8400, 'Alimentación'),
  // 28/01
  tx('28/01/2026', 'Uber', 11792, 'Transporte'),
  tx('28/01/2026', 'PedidosYa Nueva Moderna', 21922.91, 'Alimentación'),
  // 29/01
  tx('29/01/2026', 'Jumbo supermercado', 25015.48, 'Alimentación'),
  tx('29/01/2026', 'PedidosYa Market', 9589, 'Alimentación'),
  tx('29/01/2026', '2006 SA', 54700, 'Otros'),
  tx('29/01/2026', 'Peaje AUSA', 5133.73, 'Transporte'),
  // 30/01
  tx('30/01/2026', 'PedidosYa Mi Gusto', 16744, 'Alimentación'),
  tx('30/01/2026', 'AA2000', 24000, 'Otros'),
  tx('30/01/2026', 'Peaje Corredores Viales', 1258.38, 'Transporte'),
  tx('30/01/2026', 'Peaje Corredores Viales', 1006.70, 'Transporte'),
  // 31/01
  tx('31/01/2026', 'PedidosYa Propina', 350, 'Alimentación'),
  tx('31/01/2026', 'PedidosYa Burger King', 10510, 'Alimentación'),
];

// ─── TRANSACCIONES VARIABLES — FEBRERO (1-22) ────────────────────────────────

const txFebrero = [
  // 01/02
  tx('01/02/2026', 'Jumbo supermercado', 142620.17, 'Alimentación'),
  tx('01/02/2026', 'Peaje AUSA', 2531.01, 'Transporte'),
  tx('01/02/2026', 'Shell (combustible)', 12023.98, 'Transporte'),
  tx('01/02/2026', 'Humberto Rubén Amad', 10485.02, 'Otros'),
  // 02/02
  tx('02/02/2026', 'PedidosYa KFC', 25393, 'Alimentación'),
  // 03/02
  tx('03/02/2026', 'Jumbo supermercado', 60833.05, 'Alimentación'),
  // 04/02
  tx('04/02/2026', 'SIP', 4400, 'Otros'),
  tx('04/02/2026', 'Jumbo supermercado', 2100, 'Alimentación'),
  tx('04/02/2026', 'Xsolla EFTArena', 17.02, 'Entretenimiento', 'USD'),
  // 05/02
  tx('05/02/2026', 'PedidosYa Restaurante', 41278, 'Alimentación'),
  // 06/02
  tx('06/02/2026', 'Farmacity', 61743.42, 'Salud'),
  tx('06/02/2026', 'Uber', 11134, 'Transporte'),
  tx('06/02/2026', 'Uber', 14312, 'Transporte'),
  // 07/02
  tx('07/02/2026', 'Uber', 4408, 'Transporte'),
  tx('07/02/2026', 'Pago a Oriana', 32097, 'Otros'),
  // 14/02
  tx('14/02/2026', 'PedidosYa Lucciano\'s', 22683, 'Alimentación'),
  // 15/02
  tx('15/02/2026', 'Uber', 3329, 'Transporte'),
  tx('15/02/2026', 'PedidosYa Maledett', 42288, 'Alimentación'),
  tx('15/02/2026', 'PedidosYa Market', 13351.75, 'Alimentación'),
  tx('15/02/2026', 'Pet Supplies', 40160, 'Otros'),
  tx('15/02/2026', 'Jumbo supermercado', 3400, 'Alimentación'),
  // 16/02
  tx('16/02/2026', 'PedidosYa KFC', 9749, 'Alimentación'),
  // 17/02
  tx('17/02/2026', 'Supermercado Argerich', 7800, 'Alimentación'),
  // 19/02
  tx('19/02/2026', 'Uber', 2455, 'Transporte'),
  tx('19/02/2026', 'Uber', 4354, 'Transporte'),
  tx('19/02/2026', 'Uber', 5399, 'Transporte'),
  tx('19/02/2026', 'Uber', 6429, 'Transporte'),
  // 22/02
  tx('22/02/2026', 'PedidosYa Saigon', 33508, 'Alimentación'),
  tx('22/02/2026', 'Cerini peluquería', 40000, 'Ropa y personal'),
  tx('22/02/2026', 'Americo Javier', 40000, 'Otros'),
  tx('22/02/2026', 'Starbucks', 25700, 'Alimentación'),
  tx('22/02/2026', 'Café Martínez', 44500, 'Alimentación'),
];

// ─── IMPORTACIÓN ──────────────────────────────────────────────────────────────

async function batchAppendTransactions(transacciones) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Transacciones!A2:A',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const startRow = existingRows + 2;
  const endRow = startRow + transacciones.length - 1;

  const rows = transacciones.map(t => [
    t.fecha, t.hora, t.descripcion, t.categoria,
    t.monto, t.moneda, t.metodoPago, t.tipo,
    t.pagadoPor, t.splitMoises, t.splitOriana, t.notas || '',
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Transacciones!A${startRow}:L${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  return { startRow, endRow, count: transacciones.length };
}

async function batchAppendCuotas(cuotas) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Cuotas!A2:A',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const startRow = existingRows + 2;
  const endRow = startRow + cuotas.length - 1;

  const rows = cuotas.map(c => [
    c.descripcion, c.categoria, c.montoTotal, c.cuotasTotales,
    c.montoCuota, c.moneda, c.tarjeta, c.tipo,
    c.pagadoPor, c.fechaCompra, c.primeraCuota, 1, // 1 cuota ya cargada
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Cuotas!A${startRow}:L${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  return { startRow, endRow, count: cuotas.length };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  // Armar lista final de transacciones
  const todas = [
    ...(INCLUIR_FIJOS ? gastosFijos : []),
    ...txCuotas,
    ...txEnero,
    ...txFebrero,
  ];

  // Resumen
  const totalARS = todas.filter(t => t.moneda === 'ARS').reduce((s, t) => s + t.monto, 0);
  const totalUSD = todas.filter(t => t.moneda === 'USD').reduce((s, t) => s + t.monto, 0);
  const enEne = todas.filter(t => t.fecha.includes('/01/2026')).length;
  const enFeb = todas.filter(t => t.fecha.includes('/02/2026')).length;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   IMPORTACIÓN VISA GALICIA — Ciclo Ene-Feb 2026            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`  Transacciones a importar: ${todas.length}`);
  console.log(`    → Enero:   ${enEne}`);
  console.log(`    → Febrero: ${enFeb}`);
  console.log(`  Cuotas nuevas a crear:    ${cuotasNuevas.length}`);
  console.log(`  Gastos fijos incluidos:   ${INCLUIR_FIJOS ? 'Sí' : 'No (usar --fijos para incluir)'}`);
  console.log(`  Total ARS: $${totalARS.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`);
  console.log(`  Total USD: USD ${totalUSD.toFixed(2)}`);
  console.log('');

  // Detalle por categoría
  const porCategoria = {};
  for (const t of todas) {
    const key = `${t.categoria} (${t.moneda})`;
    porCategoria[key] = (porCategoria[key] || 0) + t.monto;
  }
  console.log('  Desglose por categoría:');
  for (const [cat, total] of Object.entries(porCategoria).sort((a, b) => b[1] - a[1])) {
    const fmt = cat.includes('USD')
      ? `USD ${total.toFixed(2)}`
      : `$${total.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
    console.log(`    ${cat.padEnd(30)} ${fmt}`);
  }

  console.log('\n  Cuotas nuevas:');
  for (const c of cuotasNuevas) {
    console.log(`    ${c.descripcion} — ${c.cuotasTotales} cuotas x $${c.montoCuota.toLocaleString('es-AR')} = $${c.montoTotal.toLocaleString('es-AR')}`);
  }

  if (!EJECUTAR) {
    console.log('\n  ⚠️  Modo preview. Usá --go para importar de verdad.\n');
    return;
  }

  // Importar
  console.log('\n  Importando transacciones...');
  const resTx = await batchAppendTransactions(todas);
  console.log(`  ✅ ${resTx.count} transacciones escritas (filas ${resTx.startRow}-${resTx.endRow})`);

  console.log('  Importando cuotas...');
  const resCuotas = await batchAppendCuotas(cuotasNuevas);
  console.log(`  ✅ ${resCuotas.count} cuotas creadas (filas ${resCuotas.startRow}-${resCuotas.endRow})`);

  console.log('\n  ✅ Importación completa.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
