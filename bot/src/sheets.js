// Conexión a Google Sheets API usando Service Account.
// Exporta el cliente de Sheets autenticado y una función de prueba.

const { google } = require('googleapis');
const config = require('./config');

// Autenticación con Service Account via JWT
const auth = new google.auth.JWT({
  email: config.google.email,
  key: config.google.privateKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Cliente de Google Sheets API v4
const sheets = google.sheets({ version: 'v4', auth });

// Verifica si un metodo de pago es tarjeta de credito (especifica o legacy "Tarjeta")
function esTarjeta(metodo) {
  return metodo === 'Tarjeta' || config.todasLasTarjetas.includes(metodo);
}

// Prueba la conexión leyendo las categorías del Sheet.
async function testConnection() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Categorías!A2:A',
  });
  return response.data.values || [];
}

// Guarda una transaccion en la hoja Transacciones (columnas A-L).
// Escribe en la siguiente fila vacia dentro del rango pre-formateado.
function txToRow(tx) {
  return [
    tx.fecha, tx.hora, tx.descripcion, tx.categoria,
    tx.monto, tx.moneda, tx.metodoPago, tx.tipo,
    tx.pagadoPor, tx.splitMoises, tx.splitOriana, tx.notas || '',
  ];
}

async function appendTransaction(tx) {
  const row = txToRow(tx);

  // Buscar la siguiente fila vacia
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Transacciones!A2:A',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const nextRow = existingRows + 2; // +2 porque los datos empiezan en fila 2

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Transacciones!A${nextRow}:L${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// Registra múltiples transacciones en una sola llamada API.
// Evita rate limit de Google Sheets al registrar muchos gastos fijos/cuotas.
async function appendTransactionsBatch(txList) {
  if (txList.length === 0) return;
  const rows = txList.map(txToRow);

  // Buscar la siguiente fila vacía (1 read)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Transacciones!A2:A',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const nextRow = existingRows + 2;

  // Escribir todas las filas de una sola vez (1 write)
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Transacciones!A${nextRow}:L${nextRow + rows.length - 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

// Actualiza múltiples cuotas registradas en una sola llamada API.
async function updateCuotasRegistradasBatch(cuotaUpdates) {
  if (cuotaUpdates.length === 0) return;
  const data = cuotaUpdates.map(({ row, count }) => ({
    range: `Cuotas!L${row}`,
    values: [[count]],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.sheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// Setup unico de Fase 4: actualiza dropdowns y crea Named Ranges.
// Ejecutar una sola vez con: node -e "require('./src/sheets').setupPhase4()"
async function setupPhase4() {
  const spreadsheetId = config.sheetId;

  // Obtener IDs numericos de las hojas
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMap = {};
  for (const s of meta.data.sheets) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }

  const txId = sheetMap['Transacciones'];
  const gfId = sheetMap['Gastos Fijos'];
  const catId = sheetMap['Categorías'];
  const MAX_TX = 5000;

  const metodosPago = ['Deel Card', 'Banco', 'Efectivo', 'Deel USD', ...config.todasLasTarjetas];
  const validationValues = metodosPago.map(v => ({ userEnteredValue: v }));

  const requests = [];

  // 1. Actualizar dropdown Metodo de pago en Transacciones (columna G = indice 6)
  requests.push({
    setDataValidation: {
      range: { sheetId: txId, startRowIndex: 1, endRowIndex: MAX_TX + 1, startColumnIndex: 6, endColumnIndex: 7 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: validationValues },
        showCustomUi: true,
        strict: true,
      },
    },
  });

  // 2. Actualizar dropdown Metodo de pago en Gastos Fijos (columna E = indice 4)
  requests.push({
    setDataValidation: {
      range: { sheetId: gfId, startRowIndex: 1, endRowIndex: 51, startColumnIndex: 4, endColumnIndex: 5 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: validationValues },
        showCustomUi: true,
        strict: true,
      },
    },
  });

  // 3. Crear Named Ranges
  const namedRanges = [
    ['Transacciones_Datos', txId, 0, 11, 1, MAX_TX + 1],    // A2:L201
    ['Transacciones_Fecha', txId, 0, 1, 1, MAX_TX + 1],      // A2:A201
    ['Transacciones_Monto', txId, 4, 5, 1, MAX_TX + 1],      // E2:E201
    ['Transacciones_Categoria', txId, 3, 4, 1, MAX_TX + 1],   // D2:D201
    ['Transacciones_Moneda', txId, 5, 6, 1, MAX_TX + 1],      // F2:F201
    ['Transacciones_Tipo', txId, 7, 8, 1, MAX_TX + 1],        // H2:H201
    ['Lista_Categorias', catId, 0, 1, 1, 50],                  // A2:A50
    ['Keywords_Categorias', catId, 1, 2, 1, 50],                // B2:B50
  ];

  for (const [name, sId, startCol, endCol, startRow, endRow] of namedRanges) {
    requests.push({
      addNamedRange: {
        namedRange: {
          name,
          range: { sheetId: sId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        },
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log('Setup Fase 4 completado: dropdowns actualizados + Named Ranges creados.');
}

// Lee el balance compartido de los 12 meses + total anual.
// Retorna { meses: [{mes, total, pagoMoises, pagoOriana, corrMoises, corrOriana, balance, resultado}], totalAnual, saldoAcumulado }
async function getBalance() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Balance Compartido!A5:H19',
  });
  const rows = response.data.values || [];

  const meses = [];
  for (let i = 0; i < 12 && i < rows.length; i++) {
    const r = rows[i];
    meses.push({
      mes: r[0] || '',
      total: parseFloat(r[1]) || 0,
      pagoMoises: parseFloat(r[2]) || 0,
      pagoOriana: parseFloat(r[3]) || 0,
      corrMoises: parseFloat(r[4]) || 0,
      corrOriana: parseFloat(r[5]) || 0,
      balance: parseFloat(r[6]) || 0,
      resultado: r[7] || '',
    });
  }

  // Fila 13 (indice 12) = Total Anual, fila 15 (indice 14) = Saldo Acumulado
  const totalRow = rows[12] || [];
  const saldoRow = rows[14] || [];

  return {
    meses,
    totalAnual: {
      total: parseFloat(totalRow[1]) || 0,
      balance: parseFloat(totalRow[6]) || 0,
      resultado: totalRow[7] || '',
    },
    saldoAcumulado: saldoRow[1] || '',
  };
}

// Lee todas las transacciones y filtra por mes/año.
// Retorna array de objetos transaccion con su numero de fila en el Sheet.
async function getMonthlyTransactions(month, year) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Transacciones!A2:L',
  });
  const rows = response.data.values || [];

  return rows
    .map((r, i) => ({
      row: i + 2,
      fecha: r[0] || '',
      hora: r[1] || '',
      descripcion: r[2] || '',
      categoria: r[3] || '',
      monto: parseFloat(r[4]) || 0,
      moneda: r[5] || '',
      metodoPago: r[6] || '',
      tipo: r[7] || '',
      pagadoPor: r[8] || '',
      splitMoises: parseFloat(r[9]) || 0,
      splitOriana: parseFloat(r[10]) || 0,
      notas: r[11] || '',
    }))
    .filter(tx => {
      if (!tx.fecha) return false;
      // Fecha en formato DD/MM/YYYY
      const parts = tx.fecha.split('/');
      if (parts.length !== 3) return false;
      const txMonth = parseInt(parts[1]);
      const txYear = parseInt(parts[2]);
      return txMonth === month && txYear === year;
    });
}

// Parsea un valor numérico que puede venir formateado con locale argentino.
// Maneja: 15000, "15.000" (punto=miles), "15.000,50" (punto=miles, coma=decimal), "$15.000", etc.
function parseLocalNumber(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  const str = val.toString().replace(/[^0-9.,\-]/g, '').trim();
  if (!str) return 0;
  // Punto como separador de miles: "15.000" o "1.500.000"
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) {
    return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
  }
  // Coma como decimal: "1500,50"
  if (/^\d+,\d+$/.test(str)) {
    return parseFloat(str.replace(',', '.')) || 0;
  }
  return parseFloat(str) || 0;
}

// Lee los gastos fijos con su estado de registracion.
// Incluye numero de fila para poder actualizar montos.
async function getGastosFijos() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Gastos Fijos!A2:K',
  });
  const rows = response.data.values || [];

  return rows
    .map((r, i) => ({
      row: i + 2,
      descripcion: r[0] || '',
      categoria: r[1] || '',
      montoEstimado: parseLocalNumber(r[2]),
      moneda: r[3] || 'ARS',
      metodoPago: r[4] || '',
      tipo: r[5] || '',
      dia: r[6] || '',
      registrado: (r[7] || '').includes('✅'),
      frecuencia: r[8] || 'Mensual',
      meses: r[9] || '',
      pagadoPor: r[10] || '',
    }))
    .filter(g => g.descripcion);
}

// Actualiza el monto estimado de un gasto fijo (columna C).
async function updateGastoFijoMonto(row, newMonto) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Gastos Fijos!C${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newMonto]] },
  });
}

// Lee las ultimas N transacciones no vacias.
// Retorna array con objetos incluyendo el numero de fila en el Sheet.
async function getLastTransactions(n = 5) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Transacciones!A2:L',
  });
  const rows = response.data.values || [];

  const transactions = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[0]) { // Solo filas con fecha (no vacias)
      transactions.push({
        row: i + 2,
        fecha: r[0] || '',
        hora: r[1] || '',
        descripcion: r[2] || '',
        categoria: r[3] || '',
        monto: parseFloat(r[4]) || 0,
        moneda: r[5] || '',
        metodoPago: r[6] || '',
        tipo: r[7] || '',
        pagadoPor: r[8] || '',
      });
    }
  }

  return transactions.slice(-n);
}

// Borra una transaccion limpiando las columnas A-L de la fila indicada.
// Preserva las formulas de las columnas M-P.
async function deleteTransaction(rowNumber) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.sheetId,
    range: `Transacciones!A${rowNumber}:L${rowNumber}`,
  });
}

// Verifica si el mes actual tiene ingresos registrados.
// Retorna { moises: bool, oriana: bool }
async function getIncomeStatus(month) {
  // Moises: fila = month + 2 (Ene=3, Feb=4, ...)
  // Oriana: fila = month + 18 (Ene=19, Feb=20, ...)
  const moisesRow = month + 2;
  const orianaRow = month + 18;

  const [moisesRes, orianaRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${moisesRow}`,
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${orianaRow}`,
    }),
  ]);

  const moisesVal = moisesRes.data.values?.[0]?.[0];
  const orianaVal = orianaRes.data.values?.[0]?.[0];

  return {
    moises: !!moisesVal && moisesVal !== '' && moisesVal !== '0',
    oriana: !!orianaVal && orianaVal !== '' && orianaVal !== '0',
  };
}

// Registra ingresos mensuales en la hoja Ingresos.
// Ambos usan la misma estructura: { salario, deelKeep, transfer }
// Las columnas son B=Salario USD, C=Queda Deel, D=Transferido USD, E=TC (se escribe aparte)
async function registerIncome(month, moisesData, orianaData) {
  const moisesRow = month + 2;
  const orianaRow = month + 18;
  const requests = [];

  if (moisesData) {
    requests.push(sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${moisesRow}:D${moisesRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[moisesData.salario, moisesData.deelKeep, moisesData.transfer]] },
    }));
  }

  if (orianaData) {
    requests.push(sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${orianaRow}:D${orianaRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[orianaData.salario, orianaData.deelKeep, orianaData.transfer]] },
    }));
  }

  await Promise.all(requests);
}

// Lee el ingreso actual de un mes para sumar extras.
// Retorna { moises: number, oriana: number }
async function getCurrentIncome(month) {
  const moisesRow = month + 2;
  const orianaRow = month + 18;

  const [moisesRes, orianaRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${moisesRow}`,
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${orianaRow}`,
    }),
  ]);

  return {
    moises: parseFloat(moisesRes.data.values?.[0]?.[0]) || 0,
    oriana: parseFloat(orianaRes.data.values?.[0]?.[0]) || 0,
  };
}

// Actualiza el monto de ingreso de un mes (para sumar extras).
async function updateIncome(month, who, newAmount) {
  const row = who === 'moises' ? month + 2 : month + 18;
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Ingresos!B${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newAmount]] },
  });
}

// Setup unico de Fase 6: escribe todas las formulas del Dashboard y corrige headers de Ingresos Oriana.
// Ejecutar una sola vez con: node -e "require('./src/sheets').setupDashboard()"
async function setupDashboard() {
  const spreadsheetId = config.sheetId;
  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  // Convierte formulas de notacion US (comas) a locale argentino (punto y coma)
  function loc(f) {
    return f.replace(/,/g, ';');
  }

  // Filtros base: mes/año desde selectores del Dashboard (B4/B5)
  const mf = 'Transacciones!M:M,$B$4,Transacciones!N:N,$B$5';

  const data = [];

  // === CORREGIR INGRESOS ORIANA ===
  // Headers Oriana (row 18) — ahora tiene misma estructura que Moises
  data.push({
    range: 'Ingresos!A18:F18',
    values: [['Mes', 'Salario USD', 'Queda en Deel USD', 'Transferido a ARS (USD)', 'TC Usado', 'Recibido ARS']],
  });

  // Formula Recibido ARS para Oriana (columna F, rows 19-30)
  const orianaFormulas = [];
  for (let r = 19; r <= 30; r++) {
    orianaFormulas.push([loc(`=IF(D${r}="","",D${r}*E${r})`)]);
  }
  data.push({ range: 'Ingresos!F19:F30', values: orianaFormulas });

  // Totales Oriana (row 31) — misma estructura que Moises
  data.push({
    range: 'Ingresos!A31:F31',
    values: [['TOTAL', loc('=SUM(B19:B30)'), loc('=SUM(C19:C30)'), loc('=SUM(D19:D30)'), loc('=IFERROR(F31/D31,"")'), loc('=SUM(F19:F30)')]],
  });

  // === DASHBOARD: RESUMEN DEL MES (B9:B11) ===
  data.push({
    range: 'Dashboard!B9:B11',
    values: [
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",${mf})`)],
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",${mf})`)],
      [loc(`=COUNTIFS(${mf},Transacciones!A:A,"<>")`)],
    ],
  });

  // === DASHBOARD: GASTO POR PERSONA (B14:B17) ===
  data.push({
    range: 'Dashboard!B14:B17',
    values: [
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",Transacciones!H:H,"Individual Moises",${mf})`)],
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",Transacciones!H:H,"Individual Moises",${mf})`)],
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",Transacciones!H:H,"Individual Oriana",${mf})`)],
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",Transacciones!H:H,"Compartido",${mf})`)],
    ],
  });

  // === DASHBOARD: POR MÉTODO DE PAGO (B20:B23) ===
  data.push({
    range: 'Dashboard!B20:B23',
    values: [
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Deel Card",${mf})`)],
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Banco",${mf})`)],
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Efectivo",${mf})`)],
      [loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Deel USD",${mf})`)],
    ],
  });

  // === DASHBOARD: BALANCE COMPARTIDO (B26) ===
  data.push({
    range: 'Dashboard!B26',
    values: [[loc(`=IFERROR(INDEX('Balance Compartido'!H:H,$B$4+4),"Sin datos")`)]]
  });

  // === DASHBOARD: FLUJO DEL MES (rows 28-41) ===
  data.push({
    range: 'Dashboard!A28:B41',
    values: [
      ['', ''],                                                                                                 // 28: separador
      ['FLUJO DEL MES', ''],                                                                                    // 29: header
      ['Ingresó Moises (ARS)', loc(`=IFERROR(INDEX(Ingresos!F:F,$B$4+2),0)`)],                                  // 30
      ['Ingresó Oriana (ARS)', loc(`=IFERROR(INDEX(Ingresos!F:F,$B$4+18),0)`)],                                 // 31
      ['Total Ingresado ARS', loc('=B30+B31')],                                                                 // 32
      ['Gastado ARS', loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",${mf})`)],                          // 33
      ['— Tarjeta', loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Tarjeta",${mf})`)],                       // 34
      ['Sobrante ARS', loc('=B32-B33')],                                                                        // 35
      ['', ''],                                                                                                 // 36
      ['Salario Total USD', loc(`=IFERROR(INDEX(Ingresos!B:B,$B$4+2),0)+IFERROR(INDEX(Ingresos!B:B,$B$4+18),0)`)], // 37
      ['Transferido a ARS', loc(`=IFERROR(INDEX(Ingresos!D:D,$B$4+2),0)+IFERROR(INDEX(Ingresos!D:D,$B$4+18),0)`)], // 38
      ['Gastado USD', loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",${mf})`)],                          // 39
      ['Queda en Deel USD', loc(`=IFERROR(INDEX(Ingresos!C:C,$B$4+2),0)+IFERROR(INDEX(Ingresos!C:C,$B$4+18),0)`)], // 40
      ['', ''],                                                                                                 // 41
    ],
  });

  // === DASHBOARD: RESUMEN ANUAL (rows 43-58) ===
  data.push({
    range: 'Dashboard!A43:F45',
    values: [
      ['', '', '', '', '', ''],                                                                 // 43: separador
      ['RESUMEN ANUAL', '', '', '', '', ''],                                                    // 44: header
      ['Mes', 'Ingresado ARS', 'Gastado ARS', 'Sobrante ARS', 'Gastado USD', 'Ahorro USD'],    // 45: headers columnas
    ],
  });

  // 12 meses (rows 46-57)
  const anualRows = [];
  for (let m = 1; m <= 12; m++) {
    const mfFijo = `Transacciones!M:M,${m},Transacciones!N:N,$B$5`;
    const row = 45 + m;
    anualRows.push([
      MESES[m - 1],
      loc(`=IFERROR(INDEX(Ingresos!F:F,${m + 2}),0)+IFERROR(INDEX(Ingresos!F:F,${m + 18}),0)`),
      loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",${mfFijo})`),
      loc(`=B${row}-C${row}`),
      loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",${mfFijo})`),
      loc(`=IFERROR(INDEX(Ingresos!C:C,${m + 2}),0)+IFERROR(INDEX(Ingresos!C:C,${m + 18}),0)`),
    ]);
  }
  data.push({ range: 'Dashboard!A46:F57', values: anualRows });

  // Total anual (row 58)
  data.push({
    range: 'Dashboard!A58:F58',
    values: [['TOTAL', loc('=SUM(B46:B57)'), loc('=SUM(C46:C57)'), loc('=SUM(D46:D57)'), loc('=SUM(E46:E57)'), loc('=SUM(F46:F57)')]],
  });

  // Escribir todas las formulas en un solo batch
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // === FORMATO ===
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const dashId = meta.data.sheets.find(s => s.properties.title === 'Dashboard').properties.sheetId;
  const ingId = meta.data.sheets.find(s => s.properties.title === 'Ingresos').properties.sheetId;

  const formatRequests = [];

  // Formato numeros ARS (#,##0) para celdas del Dashboard
  const arsRanges = [
    [8, 11, 1, 2],   // B9:B11
    [13, 17, 1, 2],  // B14:B17
    [19, 23, 1, 2],  // B20:B23
    [29, 36, 1, 2],  // B30:B35 (flujo ARS)
    [36, 41, 1, 2],  // B37:B41 (flujo USD)
    [45, 58, 1, 6],  // B46:F58 (resumen anual)
  ];
  for (const [startRow, endRow, startCol, endCol] of arsRanges) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  // Bold para section headers nuevos (rows 29, 44) y TOTAL (row 58)
  for (const row of [28, 43, 57]) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 6 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    });
  }

  // Bold para headers resumen anual (row 45)
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dashId, startRowIndex: 44, endRowIndex: 45, startColumnIndex: 0, endColumnIndex: 6 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });

  // Ancho columnas C-F del Dashboard
  for (let col = 2; col <= 5; col++) {
    formatRequests.push({
      updateDimensionProperties: {
        range: { sheetId: dashId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
        properties: { pixelSize: 130 },
        fields: 'pixelSize',
      },
    });
  }

  // Bold para headers y total Ingresos Oriana
  formatRequests.push({
    repeatCell: {
      range: { sheetId: ingId, startRowIndex: 17, endRowIndex: 18, startColumnIndex: 0, endColumnIndex: 6 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: ingId, startRowIndex: 30, endRowIndex: 31, startColumnIndex: 0, endColumnIndex: 6 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });

  // Formato numeros Ingresos Oriana (B19:E30 = #,##0.00, F19:F30 = #,##0)
  formatRequests.push({
    repeatCell: {
      range: { sheetId: ingId, startRowIndex: 18, endRowIndex: 30, startColumnIndex: 1, endColumnIndex: 5 },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: ingId, startRowIndex: 18, endRowIndex: 30, startColumnIndex: 5, endColumnIndex: 6 },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: formatRequests },
  });

  console.log('Dashboard configurado con fórmulas. Ingresos Oriana actualizados.');
}

// Lee datos de ingresos y gastos para el comando /flujo.
// Retorna todo lo necesario para mostrar el flujo financiero del mes.
async function getFlowData(month, year) {
  const moisesRow = month + 2;
  const orianaRow = month + 18;

  const [moisesRes, orianaRes, transRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${moisesRow}:F${moisesRow}`,
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `Ingresos!B${orianaRow}:F${orianaRow}`,
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: 'Transacciones!A2:L',
    }),
  ]);

  // Ingresos: [SalarioUSD, QuedaDeel, Transfer, TC, RecibidoARS]
  const mData = moisesRes.data.values?.[0] || [];
  const oData = orianaRes.data.values?.[0] || [];

  const moises = {
    salarioUsd: parseLocalNumber(mData[0]),
    quedaDeel: parseLocalNumber(mData[1]),
    transferido: parseLocalNumber(mData[2]),
    tc: parseLocalNumber(mData[3]),
    recibidoArs: parseLocalNumber(mData[4]),
  };

  const oriana = {
    salarioUsd: parseLocalNumber(oData[0]),
    quedaDeel: parseLocalNumber(oData[1]),
    transferido: parseLocalNumber(oData[2]),
    tc: parseLocalNumber(oData[3]),
    recibidoArs: parseLocalNumber(oData[4]),
  };

  // Sumar gastos del mes actual
  const rows = transRes.data.values || [];
  let gastadoArs = 0, gastadoUsd = 0, gastadoTarjeta = 0, gastadoLiquido = 0;
  let gastadoDeelCard = 0;

  for (const r of rows) {
    if (!r[0]) continue;
    const parts = r[0].split('/');
    if (parts.length !== 3) continue;
    const rMonth = parseInt(parts[1]);
    const rYear = parseInt(parts[2]);

    // Solo gastos del mes actual
    if (rMonth !== month || rYear !== year) continue;

    const monto = parseLocalNumber(r[4]);
    if (r[5] === 'USD') gastadoUsd += monto;
    else {
      gastadoArs += monto;
      if (esTarjeta(r[6])) gastadoTarjeta += monto;
      else {
        gastadoLiquido += monto;
        if (r[6] === 'Deel Card') gastadoDeelCard += monto;
      }
    }
  }

  // Leer pagos TC reales y otros ingresos desde hoja "Pagos TC"
  let pagosTC = { saldoAnterior: 0, totalPagosTC: 0, otrosIngresos: 0, sobranteReal: 0 };
  try {
    pagosTC = await getPagosTC(month);
  } catch (e) {
    // Si la hoja no existe todavía
  }

  const totalIngresadoArs = moises.recibidoArs + oriana.recibidoArs;

  // Sobrante: si hay override (sobranteReal), usar ese valor directamente.
  // Sino calcular: saldo_anterior + ingresos_moises + otros_ingresos - gastos_banco_efectivo - pagos_tc
  const gastoBancoEfectivo = gastadoLiquido - gastadoDeelCard;
  const sobranteArs = pagosTC.sobranteReal > 0
    ? pagosTC.sobranteReal
    : pagosTC.saldoAnterior + moises.recibidoArs + pagosTC.otrosIngresos
      - gastoBancoEfectivo - pagosTC.totalPagosTC;

  return {
    moises,
    oriana,
    totalIngresadoArs,
    gastadoArs,
    gastadoUsd,
    gastadoTarjeta,
    gastadoLiquido,
    gastadoDeelCard,
    gastoBancoEfectivo,
    pagosTC,
    sobranteArs,
    salarioTotalUsd: moises.salarioUsd + oriana.salarioUsd,
    transferidoTotal: moises.transferido + oriana.transferido,
    quedaDeelTotal: moises.quedaDeel + oriana.quedaDeel,
  };
}

// Lee presupuestos mensuales por categoría de Presupuesto ARS (3 secciones) y USD (2 secciones).
// Retorna Map: key = "categoria|tipo|moneda" → presupuesto mensual.
async function getPresupuestos() {
  const [arsRes, usdRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: "'Presupuesto ARS'!A5:B55",
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: "'Presupuesto USD'!A5:B40",
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
  ]);

  const presupuestos = new Map();
  const arsRows = arsRes.data.values || [];
  const usdRows = usdRes.data.values || [];

  // ARS: 13 categorías por sección (11 originales + Seguros + Impuestos)
  // indices 0-12 = Moises, 17-29 = Oriana, 34-46 = Compartido
  // (entre secciones: TOTAL, blank, título, header)
  const sections = [
    { offset: 0, tipo: 'Individual Moises' },
    { offset: 17, tipo: 'Individual Oriana' },
    { offset: 34, tipo: 'Compartido' },
  ];

  for (const sec of sections) {
    for (let i = 0; i < 13; i++) {
      const row = arsRows[sec.offset + i];
      if (!row || !row[0]) continue;
      const categoria = String(row[0]).trim();
      const presupuesto = typeof row[1] === 'number' ? row[1] : parseLocalNumber(row[1]);
      if (presupuesto > 0) {
        presupuestos.set(`${categoria}|${sec.tipo}|ARS`, presupuesto);
      }
    }
  }

  // USD: parsea secciones dinámicamente (Moises y Oriana)
  // Estructura: categorías → TOTAL → blank → título → header → categorías → TOTAL
  const usdSections = [
    { tipo: 'Individual Moises' },
    { tipo: 'Individual Oriana' },
  ];
  let idx = 0;
  for (const sec of usdSections) {
    // Buscar filas con categoría+presupuesto (saltar TOTAL, blanks, títulos, headers)
    while (idx < usdRows.length) {
      const row = usdRows[idx];
      if (!row || !row[0]) { idx++; continue; }
      const val = String(row[0]).trim();
      // Saltar filas de estructura (TOTAL, títulos con ──, headers)
      if (val === 'TOTAL' || val.includes('──') || val === 'Categoría') { idx++; continue; }
      // Es una categoría
      const presupuesto = typeof row[1] === 'number' ? row[1] : parseLocalNumber(row[1]);
      if (presupuesto > 0) {
        presupuestos.set(`${val}|${sec.tipo}|USD`, presupuesto);
      }
      idx++;
      // Si la siguiente fila es TOTAL, terminó esta sección
      const next = usdRows[idx];
      if (next && String(next[0] || '').trim() === 'TOTAL') {
        idx++; // saltar TOTAL
        break;
      }
    }
  }

  return presupuestos;
}

// Setup unico: reescribe Dashboard desde "POR MÉTODO DE PAGO" con tarjetas individuales.
// Ejecutar una sola vez con: node -e "require('./src/sheets').setupDashboardCards()"
async function setupDashboardCards() {
  const spreadsheetId = config.sheetId;
  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  function loc(f) {
    return f.replace(/,/g, ';');
  }

  const mf = 'Transacciones!M:M,$B$4,Transacciones!N:N,$B$5';

  // 1. Limpiar todo desde fila 19 hacia abajo (metodos + balance + flujo + ahorro + resumen anual)
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Dashboard!A19:H75',
  });

  const data = [];

  // === POR MÉTODO DE PAGO (row 19 header ya existe, rows 20-28 datos) ===
  const tarjetas = config.todasLasTarjetas;
  const metodosRows = [];

  // Tarjetas individuales (rows 20-23)
  for (const card of tarjetas) {
    metodosRows.push([card, loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"${card}",${mf})`)]);
  }

  // Tarjetas total (row 24) — suma de las 4 + legacy "Tarjeta"
  metodosRows.push([
    'Tarjetas (total)',
    loc(`=B20+B21+B22+B23+SUMIFS(Transacciones!E:E,Transacciones!G:G,"Tarjeta",${mf})`),
  ]);

  // Otros metodos (rows 25-28)
  metodosRows.push(['Deel Card', loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Deel Card",${mf})`)]);
  metodosRows.push(['Banco', loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Banco",${mf})`)]);
  metodosRows.push(['Efectivo', loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Efectivo",${mf})`)]);
  metodosRows.push(['Deel USD', loc(`=SUMIFS(Transacciones!E:E,Transacciones!G:G,"Deel USD",${mf})`)]);

  data.push({ range: 'Dashboard!A20:B28', values: metodosRows });

  // === BALANCE COMPARTIDO (row 30 header, row 31 dato) ===
  data.push({
    range: 'Dashboard!A30:B31',
    values: [
      ['BALANCE COMPARTIDO', ''],
      ['Resultado:', loc(`=IFERROR(INDEX('Balance Compartido'!H:H,$B$4+4),"Sin datos")`)],
    ],
  });

  // === FLUJO DEL MES (rows 33-47) ===
  const ahorroMf = `Transacciones!D:D,"Ahorro / Inversión"`;
  data.push({
    range: 'Dashboard!A33:B47',
    values: [
      ['', ''],                                                                                                 // 33: separador
      ['FLUJO DEL MES', ''],                                                                                    // 34: header
      ['Ingresó Moises (ARS)', loc(`=IFERROR(INDEX(Ingresos!F:F,$B$4+2),0)`)],                                  // 35
      ['Ingresó Oriana (ARS)', loc(`=IFERROR(INDEX(Ingresos!F:F,$B$4+18),0)`)],                                 // 36
      ['Total Ingresado ARS', loc('=B35+B36')],                                                                 // 37
      ['Gastos Fijos estimados', loc(`=SUMIFS('Gastos Fijos'!C:C,'Gastos Fijos'!D:D,"ARS",'Gastos Fijos'!I:I,"Mensual")`)], // 38
      ['Gastado ARS', loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",${mf})`)],                          // 39
      ['— Tarjetas', loc('=B24')],                                                                              // 40: referencia al total tarjetas
      ['Sobrante ARS', loc('=B37-B39')],                                                                        // 41
      ['', ''],                                                                                                 // 42
      ['Salario Total USD', loc(`=IFERROR(INDEX(Ingresos!B:B,$B$4+2),0)+IFERROR(INDEX(Ingresos!B:B,$B$4+18),0)`)], // 43
      ['Transferido a ARS', loc(`=IFERROR(INDEX(Ingresos!D:D,$B$4+2),0)+IFERROR(INDEX(Ingresos!D:D,$B$4+18),0)`)], // 44
      ['Gastado USD', loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",${mf})`)],                          // 45
      ['Queda en Deel USD', loc(`=IFERROR(INDEX(Ingresos!C:C,$B$4+2),0)+IFERROR(INDEX(Ingresos!C:C,$B$4+18),0)`)], // 46
      ['', ''],                                                                                                 // 47
    ],
  });

  // === AHORRO (rows 48-53) ===
  data.push({
    range: 'Dashboard!A48:B53',
    values: [
      ['AHORRO', ''],                                                                                           // 48: header
      ['Ahorro ARS (mes)', loc(`=SUMIFS(Transacciones!E:E,${ahorroMf},Transacciones!F:F,"ARS",${mf})`)],        // 49
      ['Ahorro USD (mes)', loc(`=SUMIFS(Transacciones!E:E,${ahorroMf},Transacciones!F:F,"USD",${mf})`)],        // 50
      ['Ahorro ARS (acumulado)', loc(`=SUMIFS(Transacciones!E:E,${ahorroMf},Transacciones!F:F,"ARS",Transacciones!N:N,$B$5)`)], // 51
      ['Ahorro USD (acumulado)', loc(`=SUMIFS(Transacciones!E:E,${ahorroMf},Transacciones!F:F,"USD",Transacciones!N:N,$B$5)`)], // 52
      ['', ''],                                                                                                 // 53
    ],
  });

  // === RESUMEN ANUAL (rows 54-69) ===
  data.push({
    range: 'Dashboard!A54:H56',
    values: [
      ['', '', '', '', '', '', '', ''],
      ['RESUMEN ANUAL', '', '', '', '', '', '', ''],
      ['Mes', 'Ingresado ARS', 'Gastado ARS', 'Ahorro ARS', 'Sobrante ARS', 'Gastado USD', 'Ahorro USD', 'Queda Deel USD'],
    ],
  });

  // 12 meses (rows 57-68)
  const anualRows = [];
  for (let m = 1; m <= 12; m++) {
    const mfFijo = `Transacciones!M:M,${m},Transacciones!N:N,$B$5`;
    const row = 56 + m;
    anualRows.push([
      MESES[m - 1],
      loc(`=IFERROR(INDEX(Ingresos!F:F,${m + 2}),0)+IFERROR(INDEX(Ingresos!F:F,${m + 18}),0)`),
      loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",${mfFijo})`),
      loc(`=SUMIFS(Transacciones!E:E,${ahorroMf},Transacciones!F:F,"ARS",${mfFijo})`),
      loc(`=B${row}-C${row}`),
      loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",${mfFijo})`),
      loc(`=SUMIFS(Transacciones!E:E,${ahorroMf},Transacciones!F:F,"USD",${mfFijo})`),
      loc(`=IFERROR(INDEX(Ingresos!C:C,${m + 2}),0)+IFERROR(INDEX(Ingresos!C:C,${m + 18}),0)`),
    ]);
  }
  data.push({ range: 'Dashboard!A57:H68', values: anualRows });

  // Total anual (row 69)
  data.push({
    range: 'Dashboard!A69:H69',
    values: [['TOTAL', loc('=SUM(B57:B68)'), loc('=SUM(C57:C68)'), loc('=SUM(D57:D68)'), loc('=SUM(E57:E68)'), loc('=SUM(F57:F68)'), loc('=SUM(G57:G68)'), loc('=SUM(H57:H68)')]],
  });

  // Escribir todo en un batch
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // === FORMATO ===
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const dashId = meta.data.sheets.find(s => s.properties.title === 'Dashboard').properties.sheetId;

  const formatRequests = [];

  // Formato numeros (#,##0) para todas las celdas de valores
  const arsRanges = [
    [19, 28, 1, 2],   // B20:B28 (metodos de pago)
    [30, 31, 1, 2],   // B31 (balance)
    [34, 47, 1, 2],   // B35:B47 (flujo)
    [48, 53, 1, 2],   // B49:B52 (ahorro)
    [56, 69, 1, 8],   // B57:H69 (resumen anual)
  ];
  for (const [startRow, endRow, startCol, endCol] of arsRanges) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  // Bold para headers: POR MÉTODO DE PAGO (row 19), BALANCE (row 30), FLUJO (row 34), AHORRO (row 48), RESUMEN ANUAL (row 55), TOTAL (row 69)
  for (const row of [18, 29, 33, 47, 54, 68]) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 8 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    });
  }

  // Bold para "Tarjetas (total)" row 24
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dashId, startRowIndex: 23, endRowIndex: 24, startColumnIndex: 0, endColumnIndex: 2 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });

  // Bold para headers resumen anual (row 56)
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dashId, startRowIndex: 55, endRowIndex: 56, startColumnIndex: 0, endColumnIndex: 8 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: formatRequests },
  });

  console.log('Dashboard actualizado con tarjetas individuales.');
}

// Setup unico: aplica estilos profesionales a todas las hojas del Sheet.
// Ejecutar una sola vez con: node -e "require('./src/sheets').setupEstilos()"
async function setupEstilos() {
  const spreadsheetId = config.sheetId;

  // Obtener IDs de todas las hojas
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMap = {};
  for (const s of meta.data.sheets) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }

  // === PALETA DE COLORES ===
  const C = {
    // Headers principales
    headerDark:  { red: 0.10, green: 0.22, blue: 0.36 },  // #1A3A5C
    headerMed:   { red: 0.20, green: 0.36, blue: 0.60 },  // #335C99
    headerLight: { red: 0.84, green: 0.89, blue: 0.94 },  // #D6E3F0
    white:       { red: 1, green: 1, blue: 1 },
    // Filas alternadas
    altRow:      { red: 0.95, green: 0.96, blue: 0.98 },   // #F2F5FA
    // Secciones
    sectionBg:   { red: 0.91, green: 0.94, blue: 0.97 },   // #E8F0F8
    totalBg:     { red: 0.87, green: 0.90, blue: 0.94 },   // #DEE6F0
    // Acentos
    green:       { red: 0.15, green: 0.50, blue: 0.28 },   // #268047
    greenLight:  { red: 0.85, green: 0.94, blue: 0.88 },   // #D9F0E0
    red:         { red: 0.70, green: 0.15, blue: 0.15 },   // #B32626
    redLight:    { red: 0.97, green: 0.88, blue: 0.88 },   // #F8E0E0
    gold:        { red: 0.60, green: 0.50, blue: 0.10 },   // #99801A
    goldLight:   { red: 0.99, green: 0.96, blue: 0.85 },   // #FDF5D9
    darkText:    { red: 0.15, green: 0.15, blue: 0.20 },   // #262633
  };

  // Helpers para construir requests
  function bgColor(sheetId, r1, r2, c1, c2, color) {
    return {
      repeatCell: {
        range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
        cell: { userEnteredFormat: { backgroundColor: color } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    };
  }

  function textFmt(sheetId, r1, r2, c1, c2, opts) {
    const cell = { userEnteredFormat: {} };
    const fields = [];
    if (opts.bold !== undefined) {
      cell.userEnteredFormat.textFormat = { ...(cell.userEnteredFormat.textFormat || {}), bold: opts.bold };
      fields.push('userEnteredFormat.textFormat.bold');
    }
    if (opts.color) {
      cell.userEnteredFormat.textFormat = { ...(cell.userEnteredFormat.textFormat || {}), foregroundColorStyle: { rgbColor: opts.color } };
      fields.push('userEnteredFormat.textFormat.foregroundColorStyle');
    }
    if (opts.fontSize) {
      cell.userEnteredFormat.textFormat = { ...(cell.userEnteredFormat.textFormat || {}), fontSize: opts.fontSize };
      fields.push('userEnteredFormat.textFormat.fontSize');
    }
    if (opts.hAlign) {
      cell.userEnteredFormat.horizontalAlignment = opts.hAlign;
      fields.push('userEnteredFormat.horizontalAlignment');
    }
    if (opts.bg) {
      cell.userEnteredFormat.backgroundColor = opts.bg;
      fields.push('userEnteredFormat.backgroundColor');
    }
    return {
      repeatCell: {
        range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
        cell,
        fields: fields.join(','),
      },
    };
  }

  function headerRow(sheetId, row, cols, darkBg) {
    return [
      bgColor(sheetId, row, row + 1, 0, cols, darkBg || C.headerDark),
      textFmt(sheetId, row, row + 1, 0, cols, { bold: true, color: C.white }),
    ];
  }

  function altRows(sheetId, startRow, endRow, cols) {
    const reqs = [];
    for (let r = startRow; r < endRow; r++) {
      if ((r - startRow) % 2 === 1) {
        reqs.push(bgColor(sheetId, r, r + 1, 0, cols, C.altRow));
      }
    }
    return reqs;
  }

  function tabColor(sheetId, color) {
    return {
      updateSheetProperties: {
        properties: { sheetId, tabColorStyle: { rgbColor: color } },
        fields: 'tabColorStyle',
      },
    };
  }

  function colWidth(sheetId, col, px) {
    return {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    };
  }

  function freezeRows(sheetId, rows) {
    return {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: rows } },
        fields: 'gridProperties.frozenRowCount',
      },
    };
  }

  function border(sheetId, r1, r2, c1, c2, position, color, style) {
    const borderObj = { style: style || 'SOLID', colorStyle: { rgbColor: color || C.headerMed } };
    const borders = {};
    if (position === 'bottom') borders.bottom = borderObj;
    if (position === 'top') borders.top = borderObj;
    if (position === 'all') {
      borders.top = borderObj; borders.bottom = borderObj;
      borders.left = borderObj; borders.right = borderObj;
    }
    return {
      updateBorders: {
        range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
        ...borders,
      },
    };
  }

  const requests = [];

  // ============================================================
  // 1. TAB COLORS
  // ============================================================
  const tabColors = {
    'Dashboard':          { red: 0.18, green: 0.35, blue: 0.70 },  // azul fuerte
    'Transacciones':      { red: 0.15, green: 0.55, blue: 0.30 },  // verde
    'Presupuesto ARS':    { red: 0.90, green: 0.55, blue: 0.10 },  // naranja
    'Presupuesto USD':    { red: 0.80, green: 0.45, blue: 0.10 },  // naranja oscuro
    'Balance Compartido': { red: 0.55, green: 0.25, blue: 0.70 },  // morado
    'Gastos Fijos':       { red: 0.75, green: 0.20, blue: 0.20 },  // rojo
    'Ingresos':           { red: 0.15, green: 0.65, blue: 0.55 },  // turquesa
    'Categorías':         { red: 0.45, green: 0.45, blue: 0.50 },  // gris
  };

  for (const [name, color] of Object.entries(tabColors)) {
    if (sheetMap[name] !== undefined) {
      requests.push(tabColor(sheetMap[name], color));
    }
  }

  // ============================================================
  // 2. DASHBOARD
  // ============================================================
  const dash = sheetMap['Dashboard'];
  if (dash !== undefined) {
    // Titulo
    requests.push(textFmt(dash, 0, 1, 0, 4, { bold: true, fontSize: 16, color: C.headerDark }));
    requests.push(textFmt(dash, 1, 2, 0, 4, { color: { red: 0.5, green: 0.5, blue: 0.55 }, fontSize: 10 }));

    // Selectores mes/año
    requests.push(textFmt(dash, 3, 5, 0, 1, { bold: true, color: C.headerDark }));
    requests.push(bgColor(dash, 3, 5, 1, 2, C.goldLight));
    requests.push(textFmt(dash, 3, 5, 1, 2, { bold: true, color: C.gold, hAlign: 'CENTER' }));

    // Secciones headers
    const sectionRows = [
      { row: 6, label: 'RESUMEN DEL MES', bg: C.headerDark, text: C.white },      // row 7
      { row: 11, label: 'GASTO POR PERSONA', bg: C.headerMed, text: C.white },     // row 12
      { row: 17, label: 'POR MÉTODO DE PAGO', bg: C.headerMed, text: C.white },    // row 18
      { row: 29, label: 'BALANCE COMPARTIDO', bg: C.headerMed, text: C.white },     // row 30
      { row: 33, label: 'FLUJO DEL MES', bg: C.headerDark, text: C.white },         // row 34
      { row: 47, label: 'AHORRO', bg: C.headerMed, text: C.white },                 // row 48
      { row: 54, label: 'RESUMEN ANUAL', bg: C.headerDark, text: C.white },         // row 55
    ];

    for (const sec of sectionRows) {
      requests.push(bgColor(dash, sec.row, sec.row + 1, 0, 6, sec.bg));
      requests.push(textFmt(dash, sec.row, sec.row + 1, 0, 6, { bold: true, color: sec.text }));
    }

    // Labels col A - color oscuro y bold
    const labelRanges = [
      [7, 10],   // resumen del mes
      [12, 16],  // gasto por persona
      [19, 28],  // metodos de pago
      [30, 31],  // balance
      [34, 47],  // flujo
      [48, 53],  // ahorro
    ];
    for (const [r1, r2] of labelRanges) {
      requests.push(textFmt(dash, r1, r2, 0, 1, { color: C.darkText }));
    }

    // Valores col B - numeros con color
    requests.push(textFmt(dash, 7, 10, 1, 2, { bold: true, color: C.headerDark })); // resumen
    requests.push(textFmt(dash, 12, 16, 1, 2, { color: C.darkText }));              // por persona

    // Tarjetas (total) en bold con fondo sutil
    requests.push(bgColor(dash, 23, 24, 0, 2, C.sectionBg));
    requests.push(textFmt(dash, 23, 24, 0, 2, { bold: true }));

    // Flujo: ingresos en verde, gastos en rojo, sobrante en azul
    requests.push(textFmt(dash, 34, 37, 1, 2, { color: C.green }));  // ingresos
    requests.push(textFmt(dash, 37, 38, 1, 2, { color: C.gold }));   // gastos fijos estimados
    requests.push(textFmt(dash, 38, 40, 1, 2, { color: C.red }));    // gastos reales
    requests.push(bgColor(dash, 40, 41, 0, 2, C.greenLight));        // sobrante
    requests.push(textFmt(dash, 40, 41, 0, 2, { bold: true, color: C.green }));

    // Ahorro: valores en verde
    requests.push(textFmt(dash, 48, 53, 1, 2, { color: C.green }));
    // Acumulados en bold
    requests.push(textFmt(dash, 50, 52, 0, 2, { bold: true }));

    // Resumen anual - headers fila
    requests.push(bgColor(dash, 55, 56, 0, 8, C.headerLight));
    requests.push(textFmt(dash, 55, 56, 0, 8, { bold: true, color: C.headerDark, hAlign: 'CENTER' }));
    // Alternating rows
    requests.push(...altRows(dash, 56, 68, 8));
    // Total anual
    requests.push(bgColor(dash, 68, 69, 0, 8, C.totalBg));
    requests.push(textFmt(dash, 68, 69, 0, 8, { bold: true, color: C.headerDark }));
    // Border bajo headers
    requests.push(border(dash, 6, 7, 0, 6, 'bottom'));

    // Ancho columnas
    requests.push(colWidth(dash, 0, 210));
    requests.push(colWidth(dash, 1, 160));
    for (let c = 2; c <= 5; c++) requests.push(colWidth(dash, c, 135));
  }

  // ============================================================
  // 3. TRANSACCIONES
  // ============================================================
  const tx = sheetMap['Transacciones'];
  if (tx !== undefined) {
    requests.push(...headerRow(tx, 0, 16));
    // Columnas helper M-P con header gris oscuro (ya estan ocultas)
    requests.push(bgColor(tx, 0, 1, 12, 16, { red: 0.35, green: 0.35, blue: 0.40 }));
    // Alternating rows (primeras 50 filas visibles)
    requests.push(...altRows(tx, 1, 51, 12));
    // Anchos
    requests.push(colWidth(tx, 0, 100)); // Fecha
    requests.push(colWidth(tx, 1, 60));  // Hora
    requests.push(colWidth(tx, 2, 180)); // Descripcion
    requests.push(colWidth(tx, 3, 140)); // Categoria
    requests.push(colWidth(tx, 4, 100)); // Monto
    requests.push(colWidth(tx, 5, 70));  // Moneda
    requests.push(colWidth(tx, 6, 130)); // Metodo
    requests.push(colWidth(tx, 7, 140)); // Tipo
    requests.push(colWidth(tx, 8, 90));  // Pagado por
    requests.push(colWidth(tx, 9, 80));  // Split M
    requests.push(colWidth(tx, 10, 80)); // Split O
    requests.push(colWidth(tx, 11, 120)); // Notas
    requests.push(freezeRows(tx, 1));
  }

  // ============================================================
  // 4. PRESUPUESTO ARS (3 secciones, cada una: titulo + header + 13 cats + total)
  // ============================================================
  const pArs = sheetMap['Presupuesto ARS'];
  if (pArs !== undefined) {
    // Año en fila 1
    requests.push(textFmt(pArs, 0, 1, 0, 2, { bold: true, color: C.headerDark, fontSize: 12 }));

    // 3 secciones: filas 3, 20, 37 (0-indexed: 2, 19, 36)
    const secStarts = [2, 19, 36];
    const secColors = [C.headerDark, C.headerMed, { red: 0.45, green: 0.25, blue: 0.65 }]; // azul, azul medio, morado

    for (let s = 0; s < 3; s++) {
      const start = secStarts[s];
      const color = secColors[s];
      // Titulo seccion
      requests.push(bgColor(pArs, start, start + 1, 0, 16, C.sectionBg));
      requests.push(textFmt(pArs, start, start + 1, 0, 16, { bold: true, color, hAlign: 'CENTER' }));
      // Headers columnas
      requests.push(bgColor(pArs, start + 1, start + 2, 0, 16, color));
      requests.push(textFmt(pArs, start + 1, start + 2, 0, 16, { bold: true, color: C.white, hAlign: 'CENTER' }));
      // Alternating rows (13 categorias)
      requests.push(...altRows(pArs, start + 2, start + 15, 16));
      // Total
      requests.push(bgColor(pArs, start + 15, start + 16, 0, 16, C.totalBg));
      requests.push(textFmt(pArs, start + 15, start + 16, 0, 16, { bold: true }));
    }

    requests.push(colWidth(pArs, 0, 160)); // Categoria
    requests.push(colWidth(pArs, 1, 100)); // Presup
  }

  // ============================================================
  // 5. PRESUPUESTO USD (2 secciones: Moises y Oriana)
  // ============================================================
  const pUsd = sheetMap['Presupuesto USD'];
  if (pUsd !== undefined) {
    // Limpiar fondo de toda la hoja
    requests.push(bgColor(pUsd, 0, 35, 0, 16, C.white));
    requests.push(textFmt(pUsd, 0, 35, 0, 16, { color: C.darkText }));
    requests.push(textFmt(pUsd, 0, 1, 0, 2, { bold: true, color: C.headerDark, fontSize: 12 }));
    // Sección Moises (filas 3-16, 0-indexed: 2-15)
    requests.push(bgColor(pUsd, 2, 3, 0, 16, C.sectionBg));
    requests.push(textFmt(pUsd, 2, 3, 0, 16, { bold: true, color: C.headerDark, hAlign: 'CENTER' }));
    requests.push(bgColor(pUsd, 3, 4, 0, 16, C.headerDark));
    requests.push(textFmt(pUsd, 3, 4, 0, 16, { bold: true, color: C.white, hAlign: 'CENTER' }));
    requests.push(...altRows(pUsd, 4, 15, 16));
    requests.push(bgColor(pUsd, 15, 16, 0, 16, C.totalBg));
    requests.push(textFmt(pUsd, 15, 16, 0, 16, { bold: true }));
    // Sección Oriana (filas 18-31, 0-indexed: 17-30)
    requests.push(bgColor(pUsd, 17, 18, 0, 16, C.sectionBg));
    requests.push(textFmt(pUsd, 17, 18, 0, 16, { bold: true, color: C.headerMed, hAlign: 'CENTER' }));
    requests.push(bgColor(pUsd, 18, 19, 0, 16, C.headerMed));
    requests.push(textFmt(pUsd, 18, 19, 0, 16, { bold: true, color: C.white, hAlign: 'CENTER' }));
    requests.push(...altRows(pUsd, 19, 30, 16));
    requests.push(bgColor(pUsd, 30, 31, 0, 16, C.totalBg));
    requests.push(textFmt(pUsd, 30, 31, 0, 16, { bold: true }));
    requests.push(colWidth(pUsd, 0, 160));
    requests.push(colWidth(pUsd, 1, 100));
  }

  // ============================================================
  // 6. BALANCE COMPARTIDO
  // ============================================================
  const bal = sheetMap['Balance Compartido'];
  if (bal !== undefined) {
    requests.push(textFmt(bal, 0, 1, 0, 2, { bold: true, color: C.headerDark, fontSize: 12 }));
    // Titulo seccion (row 3)
    requests.push(bgColor(bal, 2, 3, 0, 8, C.sectionBg));
    requests.push(textFmt(bal, 2, 3, 0, 8, { bold: true, color: { red: 0.45, green: 0.25, blue: 0.65 }, hAlign: 'CENTER' }));
    // Header (row 4)
    requests.push(bgColor(bal, 3, 4, 0, 8, { red: 0.45, green: 0.25, blue: 0.65 })); // morado
    requests.push(textFmt(bal, 3, 4, 0, 8, { bold: true, color: C.white, hAlign: 'CENTER' }));
    // Alternating rows (12 meses)
    requests.push(...altRows(bal, 4, 16, 8));
    // Total anual (row 17)
    requests.push(bgColor(bal, 16, 17, 0, 8, C.totalBg));
    requests.push(textFmt(bal, 16, 17, 0, 8, { bold: true }));
    // Saldo acumulado (row 19)
    requests.push(bgColor(bal, 18, 19, 0, 2, C.goldLight));
    requests.push(textFmt(bal, 18, 19, 0, 2, { bold: true, fontSize: 13, color: C.gold }));
    requests.push(freezeRows(bal, 4));
    // Anchos
    requests.push(colWidth(bal, 0, 70));  // Mes
    requests.push(colWidth(bal, 7, 260)); // Resultado
  }

  // ============================================================
  // 7. GASTOS FIJOS
  // ============================================================
  const gf = sheetMap['Gastos Fijos'];
  if (gf !== undefined) {
    requests.push(...headerRow(gf, 0, 8, C.red));
    requests.push(...altRows(gf, 1, 51, 8));
    requests.push(colWidth(gf, 0, 170)); // Descripcion
    requests.push(colWidth(gf, 1, 140)); // Categoria
    requests.push(colWidth(gf, 7, 160)); // Registrado
    requests.push(freezeRows(gf, 1));
  }

  // ============================================================
  // 8. INGRESOS
  // ============================================================
  const ing = sheetMap['Ingresos'];
  if (ing !== undefined) {
    // Moises titulo (row 1)
    requests.push(bgColor(ing, 0, 1, 0, 6, C.sectionBg));
    requests.push(textFmt(ing, 0, 1, 0, 6, { bold: true, color: C.green, hAlign: 'CENTER' }));
    // Moises headers (row 2)
    requests.push(bgColor(ing, 1, 2, 0, 6, C.green));
    requests.push(textFmt(ing, 1, 2, 0, 6, { bold: true, color: C.white, hAlign: 'CENTER' }));
    // Moises alternating (rows 3-14)
    requests.push(...altRows(ing, 2, 14, 6));
    // Moises total (row 15)
    requests.push(bgColor(ing, 14, 15, 0, 6, C.totalBg));
    requests.push(textFmt(ing, 14, 15, 0, 6, { bold: true }));

    // Oriana titulo (row 17 → index 16, but setupDashboard put it at row 18 → index 17)
    requests.push(bgColor(ing, 16, 17, 0, 6, C.sectionBg));
    requests.push(textFmt(ing, 16, 17, 0, 6, { bold: true, color: { red: 0.55, green: 0.25, blue: 0.70 }, hAlign: 'CENTER' }));
    // Oriana headers (row 18 → index 17)
    requests.push(bgColor(ing, 17, 18, 0, 6, { red: 0.55, green: 0.25, blue: 0.70 })); // morado
    requests.push(textFmt(ing, 17, 18, 0, 6, { bold: true, color: C.white, hAlign: 'CENTER' }));
    // Oriana alternating (rows 19-30)
    requests.push(...altRows(ing, 18, 30, 6));
    // Oriana total (row 31)
    requests.push(bgColor(ing, 30, 31, 0, 6, C.totalBg));
    requests.push(textFmt(ing, 30, 31, 0, 6, { bold: true }));

    requests.push(colWidth(ing, 0, 60));  // Mes
    requests.push(colWidth(ing, 1, 120)); // Salario
    requests.push(colWidth(ing, 2, 140)); // Queda Deel
    requests.push(colWidth(ing, 3, 170)); // Transferido
    requests.push(colWidth(ing, 4, 90));  // TC
    requests.push(colWidth(ing, 5, 120)); // Recibido ARS
  }

  // ============================================================
  // 9. CATEGORÍAS
  // ============================================================
  const cat = sheetMap['Categorías'];
  if (cat !== undefined) {
    requests.push(...headerRow(cat, 0, 2, { red: 0.45, green: 0.45, blue: 0.50 })); // gris
    requests.push(...altRows(cat, 1, 13, 2));
    requests.push(colWidth(cat, 0, 170));
    requests.push(colWidth(cat, 1, 500));
  }

  // Ejecutar todo en un solo batch
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  console.log('Estilos profesionales aplicados a todas las hojas.');
}

// Setup: aplica tema oscuro a todas las hojas del Sheet.
// Ejecutar con: node -e "require('./src/sheets').setupEstilosDark()"
async function setupEstilosDark() {
  const spreadsheetId = config.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMap = {};
  for (const s of meta.data.sheets) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }

  // === PALETA DARK ===
  const D = {
    bg:          { red: 0.11, green: 0.11, blue: 0.14 },   // #1C1C24 fondo principal
    bgAlt:       { red: 0.15, green: 0.15, blue: 0.19 },   // #262630 fila alternada
    surface:     { red: 0.18, green: 0.18, blue: 0.22 },   // #2E2E38 superficie elevada
    headerDark:  { red: 0.08, green: 0.14, blue: 0.25 },   // #142440 header oscuro
    headerMed:   { red: 0.12, green: 0.22, blue: 0.40 },   // #1F3866 header medio
    headerLight: { red: 0.15, green: 0.25, blue: 0.42 },   // #26406B header claro
    text:        { red: 0.88, green: 0.89, blue: 0.92 },   // #E0E3EB texto principal
    textMuted:   { red: 0.55, green: 0.57, blue: 0.63 },   // #8C92A0 texto secundario
    white:       { red: 1, green: 1, blue: 1 },
    green:       { red: 0.30, green: 0.78, blue: 0.48 },   // #4DC77A verde brillante
    greenDark:   { red: 0.10, green: 0.22, blue: 0.14 },   // #1A3824 fondo verde
    red:         { red: 0.90, green: 0.35, blue: 0.35 },   // #E65959 rojo brillante
    redDark:     { red: 0.25, green: 0.10, blue: 0.10 },   // #401A1A fondo rojo
    gold:        { red: 0.95, green: 0.78, blue: 0.30 },   // #F2C74D dorado brillante
    goldDark:    { red: 0.22, green: 0.18, blue: 0.08 },   // #382E14 fondo dorado
    purple:      { red: 0.60, green: 0.40, blue: 0.85 },   // #9966D9 morado brillante
    totalBg:     { red: 0.13, green: 0.13, blue: 0.17 },   // #21212B fondo total
  };

  // Helpers (mismos que setupEstilos pero con paleta dark)
  function bgColor(sheetId, r1, r2, c1, c2, color) {
    return { repeatCell: { range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 }, cell: { userEnteredFormat: { backgroundColor: color } }, fields: 'userEnteredFormat.backgroundColor' } };
  }
  function textFmt(sheetId, r1, r2, c1, c2, opts) {
    const cell = { userEnteredFormat: {} };
    const fields = [];
    if (opts.bold !== undefined) { cell.userEnteredFormat.textFormat = { ...(cell.userEnteredFormat.textFormat || {}), bold: opts.bold }; fields.push('userEnteredFormat.textFormat.bold'); }
    if (opts.color) { cell.userEnteredFormat.textFormat = { ...(cell.userEnteredFormat.textFormat || {}), foregroundColorStyle: { rgbColor: opts.color } }; fields.push('userEnteredFormat.textFormat.foregroundColorStyle'); }
    if (opts.fontSize) { cell.userEnteredFormat.textFormat = { ...(cell.userEnteredFormat.textFormat || {}), fontSize: opts.fontSize }; fields.push('userEnteredFormat.textFormat.fontSize'); }
    if (opts.hAlign) { cell.userEnteredFormat.horizontalAlignment = opts.hAlign; fields.push('userEnteredFormat.horizontalAlignment'); }
    if (opts.bg) { cell.userEnteredFormat.backgroundColor = opts.bg; fields.push('userEnteredFormat.backgroundColor'); }
    return { repeatCell: { range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 }, cell, fields: fields.join(',') } };
  }
  function headerRow(sheetId, row, cols, bg) {
    return [bgColor(sheetId, row, row + 1, 0, cols, bg || D.headerDark), textFmt(sheetId, row, row + 1, 0, cols, { bold: true, color: D.white })];
  }
  function altRowsDark(sheetId, startRow, endRow, cols) {
    const reqs = [];
    for (let r = startRow; r < endRow; r++) {
      reqs.push(bgColor(sheetId, r, r + 1, 0, cols, (r - startRow) % 2 === 0 ? D.bg : D.bgAlt));
      reqs.push(textFmt(sheetId, r, r + 1, 0, cols, { color: D.text }));
    }
    return reqs;
  }

  const requests = [];

  // ============================================================
  // 1. DASHBOARD
  // ============================================================
  const dash = sheetMap['Dashboard'];
  if (dash !== undefined) {
    // Fondo oscuro completo
    requests.push(bgColor(dash, 0, 75, 0, 8, D.bg));
    requests.push(textFmt(dash, 0, 75, 0, 8, { color: D.text }));

    // Titulo
    requests.push(textFmt(dash, 0, 1, 0, 4, { bold: true, fontSize: 16, color: D.white }));
    requests.push(textFmt(dash, 1, 2, 0, 4, { color: D.textMuted, fontSize: 10 }));

    // Selectores mes/año
    requests.push(textFmt(dash, 3, 5, 0, 1, { bold: true, color: D.gold }));
    requests.push(bgColor(dash, 3, 5, 1, 2, D.goldDark));
    requests.push(textFmt(dash, 3, 5, 1, 2, { bold: true, color: D.gold, hAlign: 'CENTER' }));

    // Secciones headers
    const sectionRows = [
      { row: 6, bg: D.headerDark },   // RESUMEN DEL MES
      { row: 11, bg: D.headerMed },    // GASTO POR PERSONA
      { row: 17, bg: D.headerMed },    // POR MÉTODO DE PAGO
      { row: 29, bg: D.headerMed },    // BALANCE COMPARTIDO
      { row: 33, bg: D.headerDark },   // FLUJO DEL MES
      { row: 47, bg: D.headerMed },    // AHORRO
      { row: 54, bg: D.headerDark },   // RESUMEN ANUAL
    ];
    for (const sec of sectionRows) {
      requests.push(bgColor(dash, sec.row, sec.row + 1, 0, 8, sec.bg));
      requests.push(textFmt(dash, sec.row, sec.row + 1, 0, 8, { bold: true, color: D.white }));
    }

    // Valores resumen
    requests.push(textFmt(dash, 7, 10, 1, 2, { bold: true, color: D.white }));
    // Por persona
    requests.push(textFmt(dash, 12, 16, 1, 2, { color: D.text }));
    // Tarjetas total
    requests.push(bgColor(dash, 23, 24, 0, 2, D.surface));
    requests.push(textFmt(dash, 23, 24, 0, 2, { bold: true, color: D.white }));

    // Flujo: ingresos verde, estimados dorado, gastos rojo, sobrante verde
    requests.push(textFmt(dash, 34, 37, 1, 2, { color: D.green }));
    requests.push(textFmt(dash, 37, 38, 1, 2, { color: D.gold }));
    requests.push(textFmt(dash, 38, 40, 1, 2, { color: D.red }));
    requests.push(bgColor(dash, 40, 41, 0, 2, D.greenDark));
    requests.push(textFmt(dash, 40, 41, 0, 2, { bold: true, color: D.green }));

    // Ahorro: verde brillante
    requests.push(textFmt(dash, 48, 53, 1, 2, { color: D.green }));
    requests.push(textFmt(dash, 50, 52, 0, 2, { bold: true, color: D.green }));

    // Resumen anual
    requests.push(bgColor(dash, 55, 56, 0, 8, D.headerLight));
    requests.push(textFmt(dash, 55, 56, 0, 8, { bold: true, color: D.white, hAlign: 'CENTER' }));
    requests.push(...altRowsDark(dash, 56, 68, 8));
    requests.push(bgColor(dash, 68, 69, 0, 8, D.totalBg));
    requests.push(textFmt(dash, 68, 69, 0, 8, { bold: true, color: D.white }));
  }

  // ============================================================
  // 2. TRANSACCIONES
  // ============================================================
  const tx = sheetMap['Transacciones'];
  if (tx !== undefined) {
    requests.push(bgColor(tx, 0, 200, 0, 17, D.bg));
    requests.push(textFmt(tx, 0, 200, 0, 17, { color: D.text }));
    requests.push(...headerRow(tx, 0, 17));
    requests.push(...altRowsDark(tx, 1, 100, 12));
  }

  // ============================================================
  // 3. PRESUPUESTO ARS (3 secciones, 13 categorías cada una)
  // ============================================================
  const pArs = sheetMap['Presupuesto ARS'];
  if (pArs !== undefined) {
    requests.push(bgColor(pArs, 0, 55, 0, 16, D.bg));
    requests.push(textFmt(pArs, 0, 55, 0, 16, { color: D.text }));
    requests.push(textFmt(pArs, 0, 1, 0, 2, { bold: true, color: D.white, fontSize: 12 }));
    const secStarts = [2, 19, 36];
    const secColors = [D.headerDark, D.headerMed, { red: 0.30, green: 0.15, blue: 0.50 }];
    for (let s = 0; s < 3; s++) {
      const start = secStarts[s];
      requests.push(bgColor(pArs, start, start + 1, 0, 16, D.surface));
      requests.push(textFmt(pArs, start, start + 1, 0, 16, { bold: true, color: secColors[s] === D.headerDark ? D.white : D.purple, hAlign: 'CENTER' }));
      requests.push(bgColor(pArs, start + 1, start + 2, 0, 16, secColors[s]));
      requests.push(textFmt(pArs, start + 1, start + 2, 0, 16, { bold: true, color: D.white, hAlign: 'CENTER' }));
      requests.push(...altRowsDark(pArs, start + 2, start + 15, 16));
      requests.push(bgColor(pArs, start + 15, start + 16, 0, 16, D.totalBg));
      requests.push(textFmt(pArs, start + 15, start + 16, 0, 16, { bold: true, color: D.white }));
    }
  }

  // ============================================================
  // 4. PRESUPUESTO USD (2 secciones: Moises y Oriana)
  // ============================================================
  const pUsd = sheetMap['Presupuesto USD'];
  if (pUsd !== undefined) {
    requests.push(bgColor(pUsd, 0, 35, 0, 16, D.bg));
    requests.push(textFmt(pUsd, 0, 35, 0, 16, { color: D.text }));
    requests.push(textFmt(pUsd, 0, 1, 0, 2, { bold: true, color: D.white, fontSize: 12 }));
    // Sección Moises (filas 3-16, 0-indexed: 2-15)
    requests.push(bgColor(pUsd, 2, 3, 0, 16, D.surface));
    requests.push(textFmt(pUsd, 2, 3, 0, 16, { bold: true, color: D.white, hAlign: 'CENTER' }));
    requests.push(bgColor(pUsd, 3, 4, 0, 16, D.headerDark));
    requests.push(textFmt(pUsd, 3, 4, 0, 16, { bold: true, color: D.white, hAlign: 'CENTER' }));
    requests.push(...altRowsDark(pUsd, 4, 15, 16));
    requests.push(bgColor(pUsd, 15, 16, 0, 16, D.totalBg));
    requests.push(textFmt(pUsd, 15, 16, 0, 16, { bold: true, color: D.white }));
    // Sección Oriana (filas 18-31, 0-indexed: 17-30)
    requests.push(bgColor(pUsd, 17, 18, 0, 16, D.surface));
    requests.push(textFmt(pUsd, 17, 18, 0, 16, { bold: true, color: D.green || D.white, hAlign: 'CENTER' }));
    requests.push(bgColor(pUsd, 18, 19, 0, 16, D.headerMed));
    requests.push(textFmt(pUsd, 18, 19, 0, 16, { bold: true, color: D.white, hAlign: 'CENTER' }));
    requests.push(...altRowsDark(pUsd, 19, 30, 16));
    requests.push(bgColor(pUsd, 30, 31, 0, 16, D.totalBg));
    requests.push(textFmt(pUsd, 30, 31, 0, 16, { bold: true, color: D.white }));
  }

  // ============================================================
  // 5. BALANCE COMPARTIDO
  // ============================================================
  const bal = sheetMap['Balance Compartido'];
  if (bal !== undefined) {
    requests.push(bgColor(bal, 0, 25, 0, 8, D.bg));
    requests.push(textFmt(bal, 0, 25, 0, 8, { color: D.text }));
    requests.push(textFmt(bal, 0, 1, 0, 2, { bold: true, color: D.white, fontSize: 12 }));
    requests.push(bgColor(bal, 2, 3, 0, 8, D.surface));
    requests.push(textFmt(bal, 2, 3, 0, 8, { bold: true, color: D.purple, hAlign: 'CENTER' }));
    requests.push(bgColor(bal, 3, 4, 0, 8, { red: 0.30, green: 0.15, blue: 0.50 }));
    requests.push(textFmt(bal, 3, 4, 0, 8, { bold: true, color: D.white, hAlign: 'CENTER' }));
    requests.push(...altRowsDark(bal, 4, 16, 8));
    requests.push(bgColor(bal, 16, 17, 0, 8, D.totalBg));
    requests.push(textFmt(bal, 16, 17, 0, 8, { bold: true, color: D.white }));
    requests.push(bgColor(bal, 18, 19, 0, 2, D.goldDark));
    requests.push(textFmt(bal, 18, 19, 0, 2, { bold: true, fontSize: 13, color: D.gold }));
  }

  // ============================================================
  // 6. GASTOS FIJOS
  // ============================================================
  const gf = sheetMap['Gastos Fijos'];
  if (gf !== undefined) {
    requests.push(bgColor(gf, 0, 102, 0, 10, D.bg));
    requests.push(textFmt(gf, 0, 102, 0, 10, { color: D.text }));
    requests.push(...headerRow(gf, 0, 10, D.red));
    requests.push(bgColor(gf, 0, 1, 0, 10, { red: 0.35, green: 0.10, blue: 0.10 }));
    requests.push(...altRowsDark(gf, 1, 51, 10));
  }

  // ============================================================
  // 7. INGRESOS
  // ============================================================
  const ing = sheetMap['Ingresos'];
  if (ing !== undefined) {
    requests.push(bgColor(ing, 0, 35, 0, 6, D.bg));
    requests.push(textFmt(ing, 0, 35, 0, 6, { color: D.text }));
    // Moises
    requests.push(bgColor(ing, 0, 1, 0, 6, D.surface));
    requests.push(textFmt(ing, 0, 1, 0, 6, { bold: true, color: D.green, hAlign: 'CENTER' }));
    requests.push(bgColor(ing, 1, 2, 0, 6, { red: 0.08, green: 0.28, blue: 0.15 }));
    requests.push(textFmt(ing, 1, 2, 0, 6, { bold: true, color: D.white, hAlign: 'CENTER' }));
    requests.push(...altRowsDark(ing, 2, 14, 6));
    requests.push(bgColor(ing, 14, 15, 0, 6, D.totalBg));
    requests.push(textFmt(ing, 14, 15, 0, 6, { bold: true, color: D.white }));
    // Oriana
    requests.push(bgColor(ing, 16, 17, 0, 6, D.surface));
    requests.push(textFmt(ing, 16, 17, 0, 6, { bold: true, color: D.purple, hAlign: 'CENTER' }));
    requests.push(bgColor(ing, 17, 18, 0, 6, { red: 0.30, green: 0.15, blue: 0.50 }));
    requests.push(textFmt(ing, 17, 18, 0, 6, { bold: true, color: D.white, hAlign: 'CENTER' }));
    requests.push(...altRowsDark(ing, 18, 30, 6));
    requests.push(bgColor(ing, 30, 31, 0, 6, D.totalBg));
    requests.push(textFmt(ing, 30, 31, 0, 6, { bold: true, color: D.white }));
  }

  // ============================================================
  // 8. CATEGORÍAS
  // ============================================================
  const cat = sheetMap['Categorías'];
  if (cat !== undefined) {
    requests.push(bgColor(cat, 0, 20, 0, 2, D.bg));
    requests.push(textFmt(cat, 0, 20, 0, 2, { color: D.text }));
    requests.push(...headerRow(cat, 0, 2, { red: 0.25, green: 0.25, blue: 0.30 }));
    requests.push(...altRowsDark(cat, 1, 15, 2));
  }

  // ============================================================
  // 9. CUOTAS
  // ============================================================
  const cuotas = sheetMap['Cuotas'];
  if (cuotas !== undefined) {
    requests.push(bgColor(cuotas, 0, 52, 0, 13, D.bg));
    requests.push(textFmt(cuotas, 0, 52, 0, 13, { color: D.text }));
    requests.push(...headerRow(cuotas, 0, 13, D.headerDark));
    requests.push(...altRowsDark(cuotas, 1, 51, 13));
  }

  // ============================================================
  // TAB COLORS (dark versions)
  // ============================================================
  const tabColors = {
    'Dashboard':          { red: 0.10, green: 0.20, blue: 0.50 },
    'Transacciones':      { red: 0.10, green: 0.35, blue: 0.20 },
    'Presupuesto ARS':    { red: 0.55, green: 0.35, blue: 0.05 },
    'Presupuesto USD':    { red: 0.45, green: 0.28, blue: 0.05 },
    'Balance Compartido': { red: 0.35, green: 0.15, blue: 0.45 },
    'Gastos Fijos':       { red: 0.50, green: 0.12, blue: 0.12 },
    'Ingresos':           { red: 0.10, green: 0.40, blue: 0.35 },
    'Categorías':         { red: 0.28, green: 0.28, blue: 0.32 },
    'Cuotas':             { red: 0.10, green: 0.20, blue: 0.50 },
  };
  for (const [name, color] of Object.entries(tabColors)) {
    if (sheetMap[name] !== undefined) {
      requests.push({ updateSheetProperties: { properties: { sheetId: sheetMap[name], tabColorStyle: { rgbColor: color } }, fields: 'tabColorStyle' } });
    }
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log('Tema dark aplicado a todas las hojas.');
}

// === CUOTAS ===

// Lee todas las cuotas de la hoja Cuotas.
async function getCuotas() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Cuotas!A2:M',
  });
  const rows = response.data.values || [];
  return rows
    .map((r, i) => ({
      row: i + 2,
      descripcion: r[0] || '',
      categoria: r[1] || '',
      montoTotal: parseFloat((r[2] || '').toString().replace(/\./g, '').replace(',', '.')) || 0,
      cuotasTotales: parseInt(r[3]) || 0,
      montoCuota: parseFloat((r[4] || '').toString().replace(/\./g, '').replace(',', '.')) || 0,
      moneda: r[5] || 'ARS',
      tarjeta: r[6] || '',
      tipo: r[7] || '',
      pagadoPor: r[8] || '',
      fechaCompra: r[9] || '',
      primeraCuota: r[10] || '',
      cuotasRegistradas: parseInt(r[11]) || 0,
      estado: r[12] || '',
    }))
    .filter(c => c.descripcion);
}

// Guarda una nueva cuota en la siguiente fila vacía de la hoja Cuotas.
async function appendCuota(cuota) {
  const row = [
    cuota.descripcion,
    cuota.categoria,
    cuota.montoTotal,
    cuota.cuotasTotales,
    cuota.montoCuota,
    cuota.moneda,
    cuota.tarjeta,
    cuota.tipo,
    cuota.pagadoPor,
    cuota.fechaCompra,
    cuota.primeraCuota,
    0, // cuotas registradas empieza en 0
  ];

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Cuotas!A2:A',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const nextRow = existingRows + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Cuotas!A${nextRow}:L${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// Actualiza el contador de cuotas registradas (columna L).
async function updateCuotaRegistradas(row, count) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Cuotas!L${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[count]] },
  });
}

// Actualiza el monto por cuota (columna E) — para ajustar por interés.
async function updateCuotaMonto(row, newMonto) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Cuotas!E${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newMonto]] },
  });
}

// Setup unico: crea la hoja Cuotas con headers, validaciones, fórmulas y estilos.
// Ejecutar una sola vez con: node -e "require('./src/sheets').setupCuotas()"
async function setupCuotas() {
  const spreadsheetId = config.sheetId;

  // 1. Crear la hoja "Cuotas"
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: 'Cuotas',
            tabColorStyle: { rgbColor: { red: 0.90, green: 0.55, blue: 0.10 } },
          },
        },
      }],
    },
  });

  // 2. Obtener el sheetId
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const cuotasSheetId = meta.data.sheets.find(s => s.properties.title === 'Cuotas').properties.sheetId;

  // 3. Headers
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Cuotas!A1:M1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['Descripción', 'Categoría', 'Monto Total', 'Cuotas', 'Monto Cuota',
                'Moneda', 'Tarjeta', 'Tipo', 'Pagado por', 'Fecha compra',
                'Primera cuota', 'Cuotas registradas', 'Estado']],
    },
  });

  // 4. Fórmula Estado (columna M) — locale argentino usa ";"
  const estadoFormulas = [];
  for (let r = 2; r <= 50; r++) {
    estadoFormulas.push([
      `=IF(A${r}="";"";IF(L${r}>=D${r};"\u2705 Completada";"\uD83D\uDD04 Cuota "&L${r}&"/"&D${r}))`
    ]);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Cuotas!M2:M50',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: estadoFormulas },
  });

  // 5. Validaciones, formato y estilos
  const requests = [];

  // Dropdown Moneda (col F = index 5)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasSheetId, startRowIndex: 1, endRowIndex: 51, startColumnIndex: 5, endColumnIndex: 6 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'ARS' }] },
        showCustomUi: true, strict: true,
      },
    },
  });

  // Dropdown Tarjeta (col G = index 6)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasSheetId, startRowIndex: 1, endRowIndex: 51, startColumnIndex: 6, endColumnIndex: 7 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: config.todasLasTarjetas.map(v => ({ userEnteredValue: v })) },
        showCustomUi: true, strict: true,
      },
    },
  });

  // Dropdown Tipo (col H = index 7)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasSheetId, startRowIndex: 1, endRowIndex: 51, startColumnIndex: 7, endColumnIndex: 8 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Individual Moises' },
          { userEnteredValue: 'Individual Oriana' },
          { userEnteredValue: 'Compartido' },
        ]},
        showCustomUi: true, strict: true,
      },
    },
  });

  // Dropdown Pagado por (col I = index 8)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasSheetId, startRowIndex: 1, endRowIndex: 51, startColumnIndex: 8, endColumnIndex: 9 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Moises' },
          { userEnteredValue: 'Oriana' },
        ]},
        showCustomUi: true, strict: true,
      },
    },
  });

  // Header styling (naranja con texto blanco bold)
  requests.push({
    repeatCell: {
      range: { sheetId: cuotasSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.90, green: 0.55, blue: 0.10 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Freeze header
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: cuotasSheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // Anchos de columna
  const colWidths = [170, 140, 110, 70, 110, 70, 130, 150, 90, 100, 110, 130, 150];
  for (let i = 0; i < colWidths.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: cuotasSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: colWidths[i] },
        fields: 'pixelSize',
      },
    });
  }

  // Formato numérico para Monto Total (col C) y Monto Cuota (col E)
  for (const col of [2, 4]) {
    requests.push({
      repeatCell: {
        range: { sheetId: cuotasSheetId, startRowIndex: 1, endRowIndex: 51, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  // Filas alternadas (fondo gris claro en pares)
  for (let r = 1; r < 50; r += 2) {
    requests.push({
      repeatCell: {
        range: { sheetId: cuotasSheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: 13 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.95, green: 0.96, blue: 0.98 } } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  console.log('Hoja Cuotas creada con headers, validaciones, fórmulas y estilos.');
}

// Extiende fórmulas y validaciones de Gastos Fijos y Cuotas para soportar más filas.
// Gastos Fijos: COUNTIFS col H + dropdowns (filas 2-100)
// Cuotas: Estado col M + dropdowns (filas 2-100)
// Ejecutar con: node -e "require('./src/sheets').extendSheetLimits()"
async function extendSheetLimits() {
  const spreadsheetId = config.sheetId;
  const MAX_TX = 5000;
  const MAX_ROW = 100; // filas de datos (2 a 101)

  function loc(f) {
    return f.replace(/,/g, ';');
  }

  // 1. Gastos Fijos — COUNTIFS col H (filas 21-100, las 2-20 ya existen del setup original)
  const gfFormulas = [];
  for (let row = 21; row <= MAX_ROW + 1; row++) {
    gfFormulas.push([
      loc(`=IF(A${row}="","",IF(COUNTIFS(Transacciones!$C$2:$C$${MAX_TX},"*"&A${row}&"*",Transacciones!$M$2:$M$${MAX_TX},MONTH(TODAY()),Transacciones!$N$2:$N$${MAX_TX},YEAR(TODAY()))>0,"✅ Sí","❌ No"))`)
    ]);
  }

  // 2. Cuotas — Estado col M (filas 51-100, las 2-50 ya existen del setupCuotas)
  const cuotasFormulas = [];
  for (let r = 51; r <= MAX_ROW + 1; r++) {
    cuotasFormulas.push([
      `=IF(A${r}="";"";IF(L${r}>=D${r};"\u2705 Completada";"\uD83D\uDD04 Cuota "&L${r}&"/"&D${r}))`
    ]);
  }

  await Promise.all([
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Gastos Fijos!H21:H${MAX_ROW + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: gfFormulas },
    }),
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Cuotas!M51:M${MAX_ROW + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: cuotasFormulas },
    }),
  ]);

  // 3. Expandir validaciones (dropdowns) via batchUpdate
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMap = {};
  for (const s of meta.data.sheets) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }

  const gfId = sheetMap['Gastos Fijos'];
  const cuotasId = sheetMap['Cuotas'];
  const endRow = MAX_ROW + 2; // endRowIndex es exclusivo

  const metodosPago = ['Deel Card', 'Banco', 'Efectivo', 'Deel USD', ...config.todasLasTarjetas];
  const requests = [];

  // Gastos Fijos — dropdown Método de pago (col E = index 4)
  requests.push({
    setDataValidation: {
      range: { sheetId: gfId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 4, endColumnIndex: 5 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: metodosPago.map(v => ({ userEnteredValue: v })) },
        showCustomUi: true, strict: true,
      },
    },
  });

  // Cuotas — dropdown Moneda (col F = index 5)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 5, endColumnIndex: 6 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'ARS' }] },
        showCustomUi: true, strict: true,
      },
    },
  });

  // Cuotas — dropdown Tarjeta (col G = index 6)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 6, endColumnIndex: 7 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: config.todasLasTarjetas.map(v => ({ userEnteredValue: v })) },
        showCustomUi: true, strict: true,
      },
    },
  });

  // Cuotas — dropdown Tipo (col H = index 7)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 7, endColumnIndex: 8 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Individual Moises' },
          { userEnteredValue: 'Individual Oriana' },
          { userEnteredValue: 'Compartido' },
        ]},
        showCustomUi: true, strict: true,
      },
    },
  });

  // Cuotas — dropdown Pagado por (col I = index 8)
  requests.push({
    setDataValidation: {
      range: { sheetId: cuotasId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 8, endColumnIndex: 9 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Moises' },
          { userEnteredValue: 'Oriana' },
        ]},
        showCustomUi: true, strict: true,
      },
    },
  });

  // Cuotas — formato numérico para Monto Total (col C) y Monto Cuota (col E)
  for (const col of [2, 4]) {
    requests.push({
      repeatCell: {
        range: { sheetId: cuotasId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  console.log(`Límites expandidos a ${MAX_ROW} filas en Gastos Fijos y Cuotas.`);
}

// Aplica formato numérico (#,##0) a todas las columnas monetarias del Sheet.
// Ejecutar con: node -e "require('./src/sheets').setupFormatos()"
async function setupFormatos() {
  const spreadsheetId = config.sheetId;
  const MAX_TX = 5000;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMap = {};
  for (const s of meta.data.sheets) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }

  const fmt = (sheetId, r1, r2, c1, c2, pattern) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  const requests = [];

  // 1. Transacciones — Col E (Monto, index 4)
  const txId = sheetMap['Transacciones'];
  if (txId !== undefined) {
    requests.push(fmt(txId, 1, MAX_TX + 1, 4, 5, '#,##0'));
    // Splits Moises/Oriana (cols J-K, index 9-10) — porcentajes
    requests.push(fmt(txId, 1, MAX_TX + 1, 9, 11, '0'));
  }

  // 2. Gastos Fijos — Col C (Monto estimado, index 2)
  const gfId = sheetMap['Gastos Fijos'];
  if (gfId !== undefined) {
    requests.push(fmt(gfId, 1, 102, 2, 3, '#,##0'));
  }

  // 3. Presupuesto ARS — 3 secciones (13 categorías + total cada una)
  // Filas de datos: 5-18, 22-35, 39-52 (0-indexed: 4-17, 21-34, 38-51)
  const pArsId = sheetMap['Presupuesto ARS'];
  if (pArsId !== undefined) {
    const secStarts = [4, 21, 38]; // 0-indexed: filas de datos (después de titulo+header)
    for (const start of secStarts) {
      // Cols B-O (index 1-14): Presup + 12 meses + Total → #,##0 (13 cats + total = 14 filas)
      requests.push(fmt(pArsId, start, start + 14, 1, 15, '#,##0'));
      // Col P (index 15): % → 0%
      requests.push(fmt(pArsId, start, start + 14, 15, 16, '0%'));
    }
  }

  // 4. Presupuesto USD — 2 secciones (Moises filas 5-16, Oriana filas 20-31)
  const pUsdId = sheetMap['Presupuesto USD'];
  if (pUsdId !== undefined) {
    // Moises
    requests.push(fmt(pUsdId, 4, 16, 1, 15, '#,##0'));
    requests.push(fmt(pUsdId, 4, 16, 15, 16, '0%'));
    // Oriana
    requests.push(fmt(pUsdId, 19, 31, 1, 15, '#,##0'));
    requests.push(fmt(pUsdId, 19, 31, 15, 16, '0%'));
  }

  // 5. Balance Compartido — Cols B-G filas 5-17 (datos + total)
  const balId = sheetMap['Balance Compartido'];
  if (balId !== undefined) {
    // Meses (rows 5-16) + Total (row 17) = rows 4-16 (0-indexed)
    requests.push(fmt(balId, 4, 17, 1, 7, '#,##0'));
  }

  // 6. Ingresos — Reforzar totales (rows 15 y 31, 0-indexed: 14 y 30)
  const ingId = sheetMap['Ingresos'];
  if (ingId !== undefined) {
    // Moises total (row 15): B-E = #,##0.00, F = #,##0
    requests.push(fmt(ingId, 14, 15, 1, 5, '#,##0.00'));
    requests.push(fmt(ingId, 14, 15, 5, 6, '#,##0'));
    // Oriana total (row 31): B-E = #,##0.00, F = #,##0
    requests.push(fmt(ingId, 30, 31, 1, 5, '#,##0.00'));
    requests.push(fmt(ingId, 30, 31, 5, 6, '#,##0'));
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log('Formato numérico aplicado a todas las columnas monetarias.');
}

// Ejecutar una sola vez con: node -e "require('./src/sheets').setupFrecuencia()"
// Agrega columnas Frecuencia (I) y Meses (J) a Gastos Fijos,
// setea "Mensual" en todos los existentes, y carga suscripciones Deel.
async function setupFrecuencia() {
  const spreadsheetId = config.sheetId;
  const data = [];

  // Headers I1 y J1
  data.push({ range: "'Gastos Fijos'!I1:J1", values: [['Frecuencia', 'Meses']] });

  // "Mensual" para todas las filas existentes (2-34)
  const mensualRows = [];
  for (let i = 0; i < 33; i++) mensualRows.push(['Mensual', '']);
  data.push({ range: "'Gastos Fijos'!I2:J34", values: mensualRows });

  // Nuevas suscripciones Deel (filas 35-41)
  const nuevos = [
    // [Descripción, Categoría, Monto, Moneda, Método, Tipo, Día, (H=fórmula skip), Frecuencia, Meses]
    ['Discord Nitro', 'Entretenimiento', 5.15, 'USD', 'Deel USD', 'Individual Moises', '16', '', 'Mensual', ''],
    ['Discord Server Boost', 'Entretenimiento', 3.49, 'USD', 'Deel USD', 'Individual Moises', '31', '', 'Mensual', ''],
    ['Microsoft 365', 'Suscripciones', 3699, 'ARS', 'Deel Card', 'Individual Moises', '26', '', 'Mensual', ''],
    ['Xbox Game Pass', 'Entretenimiento', 24999, 'ARS', 'Deel Card', 'Individual Moises', '22', '', 'Mensual', ''],
    ['GearUp Portal', 'Entretenimiento', 10, 'USD', 'Deel USD', 'Individual Moises', '', '', 'Trimestral', '2,5,8,11'],
    ['1Password', 'Suscripciones', 60, 'USD', 'Deel USD', 'Individual Moises', '', '', 'Anual', '6'],
    ['Krisp', 'Suscripciones', 192, 'USD', 'Deel USD', 'Individual Moises', '', '', 'Anual', '7'],
  ];

  // Escribir A-G (datos) para filas 35-41
  data.push({
    range: "'Gastos Fijos'!A35:G41",
    values: nuevos.map(n => [n[0], n[1], n[2], n[3], n[4], n[5], n[6]]),
  });

  // Escribir I-J (frecuencia/meses) para filas 35-41
  data.push({
    range: "'Gastos Fijos'!I35:J41",
    values: nuevos.map(n => [n[8], n[9]]),
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  console.log('setupFrecuencia completado: columnas I/J + 7 suscripciones Deel agregadas.');
}

// Lee transacciones compartidas ARS no saldadas del año actual.
// Retorna array ordenado por fecha desc con row number para escribir en columna Q.
async function getSharedUnsettled() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Transacciones!A2:Q',
  });
  const rows = response.data.values || [];

  return rows
    .map((r, i) => ({
      row: i + 2,
      fecha: r[0] || '',
      descripcion: r[2] || '',
      monto: parseFloat(r[4]) || 0,
      moneda: r[5] || '',
      tipo: r[7] || '',
      pagadoPor: r[8] || '',
      splitMoises: parseFloat(r[9]) || 0,
      splitOriana: parseFloat(r[10]) || 0,
      saldado: r[16] || '',
    }))
    .filter(tx => tx.fecha && tx.tipo === 'Compartido' && tx.moneda === 'ARS' && tx.saldado !== 'Sí')
    .reverse();
}

// Marca una transacción como saldada escribiendo "Sí" en columna Q.
async function settleTransaction(rowNumber) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `Transacciones!Q${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Sí']] },
  });
}

// Ejecutar una sola vez con: node -e "require('./src/sheets').setupSaldado()"
// Agrega header "Saldado" en Q1 y actualiza fórmulas de Balance Compartido
// para excluir transacciones saldadas.
async function setupSaldado() {
  const spreadsheetId = config.sheetId;
  function loc(f) { return f.replace(/,/g, ';'); }

  const MAX = 5000;
  const data = [];

  // Header "Saldado" en Transacciones Q1
  data.push({ range: 'Transacciones!Q1', values: [['Saldado']] });

  // Reescribir fórmulas de Balance Compartido B5:H16 (12 meses)
  // Agrega condición: Transacciones!$Q$2:$Q$200,"<>Sí" a cada SUMIFS
  const q = `,Transacciones!$Q$2:$Q$${MAX},"<>Sí"`;
  for (let i = 0; i < 12; i++) {
    const bRow = 5 + i;
    const mes = i + 1;
    const b = `,Transacciones!$M$2:$M$${MAX},${mes},Transacciones!$N$2:$N$${MAX},$B$1${q})`;
    const f = `Transacciones!$H$2:$H$${MAX},"Compartido",Transacciones!$F$2:$F$${MAX},"ARS"`;

    data.push({
      range: `'Balance Compartido'!B${bRow}:H${bRow}`,
      values: [[
        loc(`=SUMIFS(Transacciones!$E$2:$E$${MAX},${f}${b}`),
        loc(`=SUMIFS(Transacciones!$E$2:$E$${MAX},${f},Transacciones!$I$2:$I$${MAX},"Moises"${b}`),
        loc(`=SUMIFS(Transacciones!$E$2:$E$${MAX},${f},Transacciones!$I$2:$I$${MAX},"Oriana"${b}`),
        loc(`=SUMIFS(Transacciones!$O$2:$O$${MAX},${f}${b}`),
        loc(`=SUMIFS(Transacciones!$P$2:$P$${MAX},${f}${b}`),
        loc(`=C${bRow}-E${bRow}`),
        loc(`=IF(B${bRow}=0,"",IF(G${bRow}>0,"Oriana debe $"&TEXT(ABS(G${bRow}),"#,##0")&" a Moises",IF(G${bRow}<0,"Moises debe $"&TEXT(ABS(G${bRow}),"#,##0")&" a Oriana","Están a mano")))`),
      ]],
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  console.log('setupSaldado completado: header Q1 + fórmulas Balance Compartido actualizadas.');
}

// ====================================================================
// CRYPTO — Portafolio de criptomonedas
// ====================================================================

// Mapping de símbolos a nombres conocidos
const CRYPTO_NAMES = {
  ETH: 'Ethereum', BTC: 'Bitcoin', SOL: 'Solana', BNB: 'Binance Coin',
  ADA: 'Cardano', DOT: 'Polkadot', AVAX: 'Avalanche', MATIC: 'Polygon',
  LINK: 'Chainlink', XRP: 'XRP', USDT: 'Tether', USDC: 'USD Coin',
};

// Crea hoja "Crypto" con holdings + historial de movimientos.
// Ejecutar una sola vez: node -e "require('./src/sheets').setupCrypto()"
async function setupCrypto() {
  const spreadsheetId = config.sheetId;
  function loc(f) { return f.replace(/,/g, ';'); }

  // 1. Crear hoja
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: 'Crypto',
            tabColorStyle: { rgbColor: { red: 0.95, green: 0.75, blue: 0.10 } },
          },
        },
      }],
    },
  });

  // 2. Obtener sheetId
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const cryptoSheetId = meta.data.sheets.find(s => s.properties.title === 'Crypto').properties.sheetId;

  // 3. Escribir títulos, headers y fórmulas
  const data = [];

  // Título holdings
  data.push({ range: 'Crypto!A1', values: [['Portafolio Crypto']] });

  // Headers holdings (fila 3)
  data.push({
    range: 'Crypto!A3:F3',
    values: [['Crypto', 'Símbolo', 'Cantidad', 'Precio USD', 'Valor USD', 'Plataforma']],
  });

  // Fórmulas holdings (filas 4-20): Cantidad, Precio, Valor
  const holdingFormulas = [];
  for (let r = 4; r <= 20; r++) {
    holdingFormulas.push([
      // C: Cantidad = compras - ventas del historial
      loc(`=IF(B${r}="";"";SUMIFS(E$26:E$5000,D$26:D$5000,B${r},C$26:C$5000,"Compra")-SUMIFS(E$26:E$5000,D$26:D$5000,B${r},C$26:C$5000,"Venta"))`),
      // D: Precio live via GOOGLEFINANCE
      loc(`=IF(B${r}="";"";IFERROR(GOOGLEFINANCE("CURRENCY:"&B${r}&"USD"),"N/A"))`),
      // E: Valor = cantidad * precio
      loc(`=IF(OR(C${r}="",C${r}=0);"";C${r}*D${r})`),
    ]);
  }
  data.push({ range: 'Crypto!C4:E20', values: holdingFormulas });

  // TOTAL (fila 22)
  data.push({
    range: 'Crypto!A22:E22',
    values: [['TOTAL', '', '', '', loc('=SUM(E4:E20)')]],
  });

  // Título historial (fila 24)
  data.push({ range: 'Crypto!A24', values: [['Historial de Movimientos']] });

  // Headers historial (fila 25)
  data.push({
    range: 'Crypto!A25:I25',
    values: [['Fecha', 'Hora', 'Tipo', 'Crypto', 'Cantidad', 'Precio USD', 'Total USD', 'Plataforma', 'Notas']],
  });

  // ARRAYFORMULA para Total USD en G26 (auto-calcula para todas las filas)
  data.push({
    range: 'Crypto!G26',
    values: [[loc('=ARRAYFORMULA(IF(E26:E="";"";E26:E*F26:F))')]],
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // 4. Estilos y validaciones
  const requests = [];

  // Merge título holdings A1:F1
  requests.push({
    mergeCells: {
      range: { sheetId: cryptoSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
      mergeType: 'MERGE_ALL',
    },
  });

  // Estilo título holdings
  requests.push({
    repeatCell: {
      range: { sheetId: cryptoSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.15, green: 0.15, blue: 0.20 },
          textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 0.95, green: 0.75, blue: 0.10 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Headers holdings (fila 3) — dorado con texto oscuro
  requests.push({
    repeatCell: {
      range: { sheetId: cryptoSheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 6 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.95, green: 0.75, blue: 0.10 },
          textFormat: { bold: true, foregroundColor: { red: 0.10, green: 0.10, blue: 0.10 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // TOTAL fila 22 — negrita con fondo gris
  requests.push({
    repeatCell: {
      range: { sheetId: cryptoSheetId, startRowIndex: 21, endRowIndex: 22, startColumnIndex: 0, endColumnIndex: 6 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.90, green: 0.90, blue: 0.90 },
          textFormat: { bold: true },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Merge título historial A24:I24
  requests.push({
    mergeCells: {
      range: { sheetId: cryptoSheetId, startRowIndex: 23, endRowIndex: 24, startColumnIndex: 0, endColumnIndex: 9 },
      mergeType: 'MERGE_ALL',
    },
  });

  // Estilo título historial
  requests.push({
    repeatCell: {
      range: { sheetId: cryptoSheetId, startRowIndex: 23, endRowIndex: 24, startColumnIndex: 0, endColumnIndex: 9 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.15, green: 0.15, blue: 0.20 },
          textFormat: { bold: true, fontSize: 12, foregroundColor: { red: 0.95, green: 0.75, blue: 0.10 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Headers historial (fila 25) — dorado
  requests.push({
    repeatCell: {
      range: { sheetId: cryptoSheetId, startRowIndex: 24, endRowIndex: 25, startColumnIndex: 0, endColumnIndex: 9 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.95, green: 0.75, blue: 0.10 },
          textFormat: { bold: true, foregroundColor: { red: 0.10, green: 0.10, blue: 0.10 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Dropdown Tipo en historial (col C = index 2, filas 26+)
  requests.push({
    setDataValidation: {
      range: { sheetId: cryptoSheetId, startRowIndex: 25, endRowIndex: 5000, startColumnIndex: 2, endColumnIndex: 3 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Compra' },
          { userEnteredValue: 'Venta' },
        ]},
        showCustomUi: true, strict: true,
      },
    },
  });

  // Freeze fila 3 (headers holdings)
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: cryptoSheetId, gridProperties: { frozenRowCount: 3 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // Anchos de columna — Holdings (A-F)
  const holdingWidths = [130, 80, 120, 120, 130, 110];
  for (let i = 0; i < holdingWidths.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: cryptoSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: holdingWidths[i] },
        fields: 'pixelSize',
      },
    });
  }
  // Columnas G-I (historial extra)
  const histWidths = [[6, 130], [7, 110], [8, 150]]; // G=Total, H=Plataforma, I=Notas
  for (const [idx, w] of histWidths) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: cryptoSheetId, dimension: 'COLUMNS', startIndex: idx, endIndex: idx + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  }

  // Formato numérico: cantidad crypto (col C holdings + col E historial) — 8 decimales
  for (const [startCol, endCol, startRow, endRow] of [[2, 3, 3, 21], [4, 5, 25, 5000]]) {
    requests.push({
      repeatCell: {
        range: { sheetId: cryptoSheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00000000' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  // Formato USD: cols D, E holdings + cols F, G historial — 2 decimales
  for (const [startCol, endCol, startRow, endRow] of [[3, 5, 3, 22], [5, 7, 25, 5000]]) {
    requests.push({
      repeatCell: {
        range: { sheetId: cryptoSheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  // Filas alternadas holdings (4-20)
  for (let r = 3; r < 20; r += 2) {
    requests.push({
      repeatCell: {
        range: { sheetId: cryptoSheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: 6 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.97, green: 0.95, blue: 0.88 } } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  console.log('Hoja Crypto creada con holdings, historial, fórmulas GOOGLEFINANCE y estilos.');
}


// Lee holdings crypto (filas 4-20).
async function getCryptoHoldings() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Crypto!A4:F20',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = response.data.values || [];
  return rows
    .map((r, i) => ({
      row: i + 4,
      nombre: r[0] || '',
      simbolo: r[1] || '',
      cantidad: parseFloat(r[2]) || 0,
      precioUsd: parseFloat(r[3]) || 0,
      valorUsd: parseFloat(r[4]) || 0,
      plataforma: r[5] || '',
    }))
    .filter(h => h.simbolo);
}


// Lee las últimas N transacciones crypto.
async function getCryptoTransactions(n = 10) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Crypto!A26:I',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = response.data.values || [];
  const transactions = rows
    .map((r, i) => {
      while (r.length < 9) r.push('');
      // Fecha puede venir como serial de Google Sheets con UNFORMATTED_VALUE
      let fecha = r[0] || '';
      if (typeof fecha === 'number' && fecha > 40000) {
        const d = new Date(Date.UTC(1899, 11, 30 + fecha));
        fecha = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      }
      return {
        row: i + 26,
        fecha,
        hora: r[1] || '',
        tipo: r[2] || '',
        crypto: r[3] || '',
        cantidad: parseFloat(r[4]) || 0,
        precioUsd: parseFloat(r[5]) || 0,
        totalUsd: parseFloat(r[6]) || 0,
        plataforma: r[7] || '',
        notas: r[8] || '',
      };
    })
    .filter(tx => tx.fecha);
  return transactions.slice(-n).reverse();
}


// Agrega una transacción crypto en la siguiente fila vacía del historial.
async function appendCryptoTransaction(tx) {
  const spreadsheetId = config.sheetId;

  // Contar filas existentes
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Crypto!A26:A',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const nextRow = existingRows + 26;

  // Escribir A-F (skip G que tiene ARRAYFORMULA)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Crypto!A${nextRow}:F${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[tx.fecha, tx.hora, tx.tipo, tx.crypto, tx.cantidad, tx.precioUsd]],
    },
  });

  // Escribir H-I (plataforma y notas, saltando G)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Crypto!H${nextRow}:I${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[tx.plataforma, tx.notas || '']],
    },
  });
}


// Agrega una nueva crypto a la sección de holdings (primera fila vacía en A4:A20).
// Las fórmulas de Cantidad, Precio y Valor ya están escritas por setupCrypto.
async function addCryptoHolding(simbolo, plataforma) {
  const spreadsheetId = config.sheetId;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Crypto!B4:B20',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const nextRow = existingRows + 4;

  if (nextRow > 20) {
    throw new Error('Máximo 17 cryptos alcanzado.');
  }

  const nombre = CRYPTO_NAMES[simbolo] || simbolo;

  // Escribir nombre y símbolo (cols A-B) + plataforma (col F)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Crypto!A${nextRow}:B${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[nombre, simbolo]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Crypto!F${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[plataforma]] },
  });
}


// Crea hoja "Inversiones" con portafolio + historial de valor.
// Ejecutar una sola vez: node -e "require('./src/sheets').setupInversiones()"
async function setupInversiones() {
  const spreadsheetId = config.sheetId;
  function loc(f) { return f.replace(/,/g, ';'); }

  // 1. Crear hoja
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: 'Inversiones',
            tabColorStyle: { rgbColor: { red: 0.20, green: 0.55, blue: 0.85 } },
          },
        },
      }],
    },
  });

  // 2. Obtener sheetId
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const invSheetId = meta.data.sheets.find(s => s.properties.title === 'Inversiones').properties.sheetId;

  // 3. Escribir títulos, headers y fórmulas
  const data = [];

  // Título portafolio
  data.push({ range: 'Inversiones!A1', values: [['Portafolio de Inversiones']] });

  // Headers portafolio (fila 3)
  data.push({
    range: 'Inversiones!A3:D3',
    values: [['Tipo', 'Porcentaje', 'Valor ARS', 'Plataforma']],
  });

  // Datos iniciales (filas 4-6)
  data.push({
    range: 'Inversiones!A4:B6',
    values: [
      ['Acciones', 0.148],
      ['CEDEARs', 0.2725],
      ['FCIs', 0.5794],
    ],
  });
  // Plataforma
  data.push({
    range: 'Inversiones!D4:D6',
    values: [['PPI'], ['PPI'], ['PPI']],
  });

  // Fórmulas Valor ARS (C4:C9)
  const valorFormulas = [];
  for (let r = 4; r <= 9; r++) {
    valorFormulas.push([loc(`=IF(B${r}="";"";B${r}*$C$10)`)]);
  }
  data.push({ range: 'Inversiones!C4:C9', values: valorFormulas });

  // TOTAL (fila 10)
  data.push({
    range: 'Inversiones!A10:C10',
    values: [['TOTAL', loc('=SUM(B4:B9)'), 600000]],
  });

  // Título historial (fila 12)
  data.push({ range: 'Inversiones!A12', values: [['Historial de Valor']] });

  // Headers historial (fila 13)
  data.push({
    range: 'Inversiones!A13:D13',
    values: [['Fecha', 'Valor Total ARS', 'Variación ARS', 'Notas']],
  });

  // ARRAYFORMULA para Variación en C14
  data.push({
    range: 'Inversiones!C14',
    values: [[loc('=ARRAYFORMULA(IF(B14:B="";"";B14:B-IF(ROW(B14:B)=ROW(B14);0;INDIRECT("B"&ROW(B14:B)-1))))')]]
  });

  // Dato inicial en historial (fila 14)
  data.push({
    range: 'Inversiones!A14:B14',
    values: [['22/02/2026', 600000]],
  });
  data.push({
    range: 'Inversiones!D14',
    values: [['Valor inicial']],
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // 4. Estilos y formato
  const requests = [];

  // Merge título portafolio A1:D1
  requests.push({
    mergeCells: {
      range: { sheetId: invSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
      mergeType: 'MERGE_ALL',
    },
  });

  // Estilo título portafolio
  requests.push({
    repeatCell: {
      range: { sheetId: invSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.10, green: 0.25, blue: 0.45 },
          textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Headers portafolio (fila 3) — azul financiero con texto blanco
  requests.push({
    repeatCell: {
      range: { sheetId: invSheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 4 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.20, green: 0.55, blue: 0.85 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // TOTAL fila 10 — negrita con fondo gris
  requests.push({
    repeatCell: {
      range: { sheetId: invSheetId, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 4 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.90, green: 0.90, blue: 0.90 },
          textFormat: { bold: true },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Merge título historial A12:D12
  requests.push({
    mergeCells: {
      range: { sheetId: invSheetId, startRowIndex: 11, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 4 },
      mergeType: 'MERGE_ALL',
    },
  });

  // Estilo título historial
  requests.push({
    repeatCell: {
      range: { sheetId: invSheetId, startRowIndex: 11, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 4 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.10, green: 0.25, blue: 0.45 },
          textFormat: { bold: true, fontSize: 12, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Headers historial (fila 13) — azul financiero
  requests.push({
    repeatCell: {
      range: { sheetId: invSheetId, startRowIndex: 12, endRowIndex: 13, startColumnIndex: 0, endColumnIndex: 4 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.20, green: 0.55, blue: 0.85 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Freeze fila 3
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: invSheetId, gridProperties: { frozenRowCount: 3 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // Anchos de columna
  const colWidths = [130, 110, 150, 120];
  for (let i = 0; i < colWidths.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: invSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: colWidths[i] },
        fields: 'pixelSize',
      },
    });
  }

  // Formato porcentaje (col B holdings filas 4-10)
  requests.push({
    repeatCell: {
      range: { sheetId: invSheetId, startRowIndex: 3, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 2 },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00%' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  // Formato moneda ARS (col C filas 4-10 + col B-C historial filas 14+)
  for (const [startCol, endCol, startRow, endRow] of [[2, 3, 3, 10], [1, 3, 13, 5000]]) {
    requests.push({
      repeatCell: {
        range: { sheetId: invSheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '$#,##0.00' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  // Filas alternadas portafolio (4, 6, 8)
  for (let r = 3; r < 9; r += 2) {
    requests.push({
      repeatCell: {
        range: { sheetId: invSheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: 4 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.90, green: 0.95, blue: 1.0 } } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  console.log('Hoja Inversiones creada con portafolio, historial, fórmulas y estilos.');
}


// Lee portafolio de inversiones.
async function getInversiones() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Inversiones!A4:D10',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = response.data.values || [];
  const tipos = [];
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    while (r.length < 4) r.push('');
    if (i === rows.length - 1 && (r[0] || '').toString().toUpperCase() === 'TOTAL') {
      total = parseFloat(r[2]) || 0;
      continue;
    }
    if (!r[0]) continue;
    tipos.push({
      tipo: r[0] || '',
      porcentaje: parseFloat(r[1]) || 0,
      valorArs: parseFloat(r[2]) || 0,
      plataforma: r[3] || '',
    });
  }
  return { tipos, total };
}


// Lee las últimas N entradas del historial de inversiones.
async function getInversionesHistorial(n = 10) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Inversiones!A14:D',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = response.data.values || [];
  const entries = rows
    .map((r, i) => {
      while (r.length < 4) r.push('');
      let fecha = r[0] || '';
      if (typeof fecha === 'number' && fecha > 40000) {
        const d = new Date(Date.UTC(1899, 11, 30 + fecha));
        fecha = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      }
      return {
        row: i + 14,
        fecha,
        valorTotal: parseFloat(r[1]) || 0,
        variacion: parseFloat(r[2]) || 0,
        notas: r[3] || '',
      };
    })
    .filter(e => e.fecha);
  return entries.slice(-n).reverse();
}


// Actualiza el valor total y opcionalmente los porcentajes de inversiones.
async function updateInversiones(total, porcentajes) {
  const spreadsheetId = config.sheetId;
  const data = [];

  // Siempre actualizar total (C10)
  data.push({
    range: 'Inversiones!C10',
    values: [[total]],
  });

  // Actualizar porcentajes si se proporcionan
  if (porcentajes && porcentajes.length > 0) {
    const pctValues = porcentajes.map(p => [p / 100]);
    data.push({
      range: `Inversiones!B4:B${3 + porcentajes.length}`,
      values: pctValues,
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}


// Agrega una entrada al historial de inversiones.
async function appendInversionesHistorial(fecha, total, notas) {
  const spreadsheetId = config.sheetId;

  // Contar filas existentes
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Inversiones!A14:A',
  });
  const existingRows = response.data.values ? response.data.values.length : 0;
  const nextRow = existingRows + 14;

  // Escribir A-B (skip C que tiene ARRAYFORMULA)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Inversiones!A${nextRow}:B${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[fecha, total]],
    },
  });

  // Escribir D (notas, saltando C)
  if (notas) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Inversiones!D${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[notas]],
      },
    });
  }
}


// Agrega sección "ORIANA (USD)" a Presupuesto USD.
// Ejecutar una sola vez: node -e "require('./src/sheets').setupPresupuestoUsdOriana()"
async function setupPresupuestoUsdOriana() {
  const spreadsheetId = config.sheetId;
  function loc(f) { return f.replace(/,/g, ';'); }

  // Leer categorías actuales de la sección Moises (fila 5 en adelante)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Presupuesto USD'!A5:A20",
  });
  const rows = res.data.values || [];
  const categorias = [];
  for (const r of rows) {
    const val = (r[0] || '').trim();
    if (!val || val === 'TOTAL') break;
    categorias.push(val);
  }
  const numCat = categorias.length;
  // Sección Moises: filas 3(titulo)+4(header)+5..5+numCat-1(cats)+5+numCat(TOTAL)
  // Oriana empieza 2 filas después del TOTAL de Moises
  const orianaStart = 5 + numCat + 2; // fila título Oriana (1-indexed)
  const headerRow = orianaStart + 1;
  const dataStart = headerRow + 1;
  const totalRow = dataStart + numCat;
  const MAX_TX = 5000;

  const data = [];

  // Título sección
  data.push({
    range: `'Presupuesto USD'!A${orianaStart}`,
    values: [['── ORIANA (USD) ──']],
  });

  // Header
  const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  data.push({
    range: `'Presupuesto USD'!A${headerRow}:P${headerRow}`,
    values: [['Categoría', 'Presup.', ...meses, 'Total', '%']],
  });

  // Categorías + fórmulas SUMIFS
  const catValues = [];
  const formulas = [];
  for (let i = 0; i < numCat; i++) {
    const row = dataStart + i;
    catValues.push([categorias[i]]);
    const rowFormulas = [];
    for (let m = 1; m <= 12; m++) {
      rowFormulas.push(loc(`=SUMIFS(Transacciones!$E$2:$E$${MAX_TX},Transacciones!$D$2:$D$${MAX_TX},$A${row},Transacciones!$F$2:$F$${MAX_TX},"USD",Transacciones!$H$2:$H$${MAX_TX},"Individual Oriana",Transacciones!$M$2:$M$${MAX_TX},${m},Transacciones!$N$2:$N$${MAX_TX},$B$1)`));
    }
    rowFormulas.push(loc(`=SUM(C${row}:N${row})`));
    rowFormulas.push(loc(`=IFERROR(O${row}/(B${row}*12),0)`));
    formulas.push(rowFormulas);
  }

  data.push({
    range: `'Presupuesto USD'!A${dataStart}:A${dataStart + numCat - 1}`,
    values: catValues,
  });
  data.push({
    range: `'Presupuesto USD'!C${dataStart}:P${dataStart + numCat - 1}`,
    values: formulas,
  });

  // Fila TOTAL
  const totalFormulas = [loc(`=SUM(B${dataStart}:B${dataStart + numCat - 1})`)];
  for (let c = 2; c <= 13; c++) {
    const col = String.fromCharCode(65 + c); // C=67 → 'C'
    totalFormulas.push(loc(`=SUM(${col}${dataStart}:${col}${dataStart + numCat - 1})`));
  }
  totalFormulas.push(loc(`=SUM(O${dataStart}:O${dataStart + numCat - 1})`));
  totalFormulas.push(loc(`=IFERROR(O${totalRow}/(B${totalRow}*12),0)`));

  data.push({
    range: `'Presupuesto USD'!A${totalRow}`,
    values: [['TOTAL']],
  });
  data.push({
    range: `'Presupuesto USD'!B${totalRow}:P${totalRow}`,
    values: [totalFormulas],
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  console.log(`Sección Oriana (USD) creada en filas ${orianaStart}-${totalRow} con ${numCat} categorías.`);
}

// Crea hoja "Pagos TC" para registrar totales reales de resúmenes de tarjeta y otros ingresos.
// Ejecutar una sola vez: node -e "require('./src/sheets').setupPagosTC()"
async function setupPagosTC() {
  const spreadsheetId = config.sheetId;
  function loc(f) { return f.replace(/,/g, ';'); }

  // 1. Crear hoja
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: 'Pagos TC',
            tabColorStyle: { rgbColor: { red: 0.80, green: 0.20, blue: 0.20 } },
          },
        },
      }],
    },
  });

  // 2. Obtener sheetId
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tcSheetId = meta.data.sheets.find(s => s.properties.title === 'Pagos TC').properties.sheetId;

  // 3. Estructura:
  // Fila 1: Título
  // Fila 2: Saldo inicial (disponible al 1ro del primer mes de seguimiento)
  // Fila 3: vacía
  // Fila 4: Headers
  // Filas 5-16: Meses (Ene-Dic)
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const data = [];

  data.push({ range: 'Pagos TC!A1', values: [['Pagos Tarjeta de Crédito y Ajustes']] });
  // Headers
  data.push({
    range: 'Pagos TC!A4:I4',
    values: [['Mes', 'Visa Galicia', 'Master Galicia', 'Visa BBVA', 'Master BBVA', 'Total Pagos TC', 'Otros Ingresos', 'Saldo Anterior', 'Sobrante Real']],
  });

  // Filas de meses con fórmula Total
  const mesRows = meses.map((m, i) => {
    const row = i + 5;
    return [m, '', '', '', '', loc(`=SUM(B${row}:E${row})`), '', '', ''];
  });
  data.push({ range: 'Pagos TC!A5:I16', values: mesRows });

  // Pre-llenar datos de Febrero 2026 (fila 6)
  data.push({
    range: 'Pagos TC!B6:C6',
    values: [[1160691.05, 302347.02]],
  });
  data.push({
    range: 'Pagos TC!G6:I6',
    values: [[170280, 33901, 31520]], // Otros ingresos, Saldo Anterior, Sobrante Real
  });
  // Marzo: saldo anterior = sobrante real de febrero
  data.push({
    range: 'Pagos TC!H7',
    values: [[31520]],
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // 4. Estilos
  const requests = [];

  // Merge título A1:I1
  requests.push({
    mergeCells: {
      range: { sheetId: tcSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
      mergeType: 'MERGE_ALL',
    },
  });

  // Estilo título
  requests.push({
    repeatCell: {
      range: { sheetId: tcSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.10, green: 0.25, blue: 0.45 },
          textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Headers fila 4
  requests.push({
    repeatCell: {
      range: { sheetId: tcSheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 9 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.80, green: 0.20, blue: 0.20 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Formato moneda para B5:I16
  requests.push({
    repeatCell: {
      range: { sheetId: tcSheetId, startRowIndex: 4, endRowIndex: 16, startColumnIndex: 1, endColumnIndex: 9 },
      cell: {
        userEnteredFormat: {
          numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' },
        },
      },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  // Ancho columnas
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: tcSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 120 },
      fields: 'pixelSize',
    },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: tcSheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 9 },
      properties: { pixelSize: 150 },
      fields: 'pixelSize',
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  console.log('Hoja "Pagos TC" creada con datos de Febrero 2026.');
}

// Migra la hoja Pagos TC: agrega columnas H (Saldo Anterior) e I (Sobrante Real).
// Ejecutar una sola vez: node -e "require('./src/sheets').migratePagosTC()"
async function migratePagosTC() {
  const spreadsheetId = config.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tcSheet = meta.data.sheets.find(s => s.properties.title === 'Pagos TC');
  if (!tcSheet) throw new Error('Hoja Pagos TC no existe');
  const tcSheetId = tcSheet.properties.sheetId;

  // Headers nuevos + datos
  const data = [
    { range: 'Pagos TC!H4:I4', values: [['Saldo Anterior', 'Sobrante Real']] },
    // Feb: saldo anterior = 33901, sobrante real = 31520
    { range: 'Pagos TC!H6:I6', values: [[33901, 31520]] },
    // Mar: saldo anterior = 31520 (el sobrante real de Feb)
    { range: 'Pagos TC!H7', values: [[31520]] },
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  // Estilos para las nuevas columnas
  const requests = [];

  // Headers H4:I4
  requests.push({
    repeatCell: {
      range: { sheetId: tcSheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 7, endColumnIndex: 9 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.80, green: 0.20, blue: 0.20 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  // Formato moneda H5:I16
  requests.push({
    repeatCell: {
      range: { sheetId: tcSheetId, startRowIndex: 4, endRowIndex: 16, startColumnIndex: 7, endColumnIndex: 9 },
      cell: {
        userEnteredFormat: {
          numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' },
        },
      },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  // Ancho columnas H-I
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: tcSheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 9 },
      properties: { pixelSize: 150 },
      fields: 'pixelSize',
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  console.log('Pagos TC migrado: columnas Saldo Anterior e Sobrante Real agregadas.');
}

// Lee los pagos de tarjeta, otros ingresos, saldo anterior y sobrante real para un mes dado.
async function getPagosTC(month) {
  const spreadsheetId = config.sheetId;

  // Datos del mes: fila = month + 4 (Ene=5, Feb=6, ...)
  // Columnas B-I: Visa, Master, VisaBBVA, MasterBBVA, Total, OtrosIngresos, SaldoAnterior, SobranteReal
  const row = month + 4;
  const mesRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `Pagos TC!B${row}:I${row}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const d = mesRes.data.values?.[0] || [];

  return {
    pagoVisa: d[0] || 0,
    pagoMaster: d[1] || 0,
    pagoVisaBBVA: d[2] || 0,
    pagoMasterBBVA: d[3] || 0,
    totalPagosTC: d[4] || 0,
    otrosIngresos: d[5] || 0,
    saldoAnterior: d[6] || 0,
    sobranteReal: d[7] || 0,  // Override: si > 0, usar este valor
  };
}

// Registra el pago de un resumen de tarjeta para un mes dado.
async function registrarPagoTC(month, card, amount) {
  const spreadsheetId = config.sheetId;
  const row = month + 4;

  // Mapear tarjeta a columna
  const colMap = {
    'Visa Galicia': 'B',
    'Master Galicia': 'C',
    'Visa BBVA': 'D',
    'Master BBVA': 'E',
  };
  const col = colMap[card];
  if (!col) throw new Error(`Tarjeta no reconocida: ${card}`);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Pagos TC!${col}${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[amount]] },
  });
}

// Registra otros ingresos (Heller, reintegros, etc.) para un mes dado.
async function registrarOtrosIngresos(month, amount) {
  const spreadsheetId = config.sheetId;
  const row = month + 4;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Pagos TC!G${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[amount]] },
  });
}

module.exports = {
  sheets, testConnection, appendTransaction, appendTransactionsBatch, setupPhase4, setupDashboard, setupDashboardCards, setupEstilos,
  getBalance, getMonthlyTransactions, getGastosFijos, updateGastoFijoMonto, getLastTransactions,
  deleteTransaction, getIncomeStatus, registerIncome, getCurrentIncome, updateIncome, getFlowData,
  setupCuotas, getCuotas, appendCuota, updateCuotaRegistradas, updateCuotasBatch: updateCuotasRegistradasBatch, updateCuotaMonto,
  extendSheetLimits, setupFormatos, getPresupuestos,
  getSharedUnsettled, settleTransaction, setupSaldado, setupFrecuencia,
  setupEstilosDark,
  setupCrypto, getCryptoHoldings, getCryptoTransactions, appendCryptoTransaction, addCryptoHolding,
  setupInversiones, getInversiones, getInversionesHistorial, updateInversiones, appendInversionesHistorial,
  setupPresupuestoUsdOriana,
  setupPagosTC, migratePagosTC, getPagosTC, registrarPagoTC, registrarOtrosIngresos,
};
