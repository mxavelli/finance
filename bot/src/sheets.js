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
async function appendTransaction(tx) {
  const row = [
    tx.fecha,
    tx.hora,
    tx.descripcion,
    tx.categoria,
    tx.monto,
    tx.moneda,
    tx.metodoPago,
    tx.tipo,
    tx.pagadoPor,
    tx.splitMoises,
    tx.splitOriana,
    tx.notas || '',
  ];

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
  const MAX_TX = 200;

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
    ['Lista_Categorias', catId, 0, 1, 1, 12],                  // A2:A12
    ['Keywords_Categorias', catId, 1, 2, 1, 12],                // B2:B12
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
    range: 'Gastos Fijos!A2:J',
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
    salarioUsd: parseFloat(mData[0]) || 0,
    quedaDeel: parseFloat(mData[1]) || 0,
    transferido: parseFloat(mData[2]) || 0,
    tc: parseFloat(mData[3]) || 0,
    recibidoArs: parseFloat(mData[4]) || 0,
  };

  const oriana = {
    salarioUsd: parseFloat(oData[0]) || 0,
    quedaDeel: parseFloat(oData[1]) || 0,
    transferido: parseFloat(oData[2]) || 0,
    tc: parseFloat(oData[3]) || 0,
    recibidoArs: parseFloat(oData[4]) || 0,
  };

  // Sumar gastos del mes por moneda y metodo
  const rows = transRes.data.values || [];
  let gastadoArs = 0, gastadoUsd = 0, gastadoTarjeta = 0;

  for (const r of rows) {
    if (!r[0]) continue;
    const parts = r[0].split('/');
    if (parts.length !== 3) continue;
    if (parseInt(parts[1]) !== month || parseInt(parts[2]) !== year) continue;

    const monto = parseFloat(r[4]) || 0;
    if (r[5] === 'USD') gastadoUsd += monto;
    else gastadoArs += monto;
    if (esTarjeta(r[6])) gastadoTarjeta += monto;
  }

  return {
    moises,
    oriana,
    totalIngresadoArs: moises.recibidoArs + oriana.recibidoArs,
    gastadoArs,
    gastadoUsd,
    gastadoTarjeta,
    sobranteArs: (moises.recibidoArs + oriana.recibidoArs) - gastadoArs,
    salarioTotalUsd: moises.salarioUsd + oriana.salarioUsd,
    transferidoTotal: moises.transferido + oriana.transferido,
    quedaDeelTotal: moises.quedaDeel + oriana.quedaDeel,
  };
}

// Lee presupuestos mensuales por categoría de Presupuesto ARS (3 secciones) y USD (1 sección).
// Retorna Map: key = "categoria|tipo|moneda" → presupuesto mensual.
async function getPresupuestos() {
  const [arsRes, usdRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: 'Presupuesto ARS!A5:B45',
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: 'Presupuesto USD!A5:B15',
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
  ]);

  const presupuestos = new Map();
  const arsRows = arsRes.data.values || [];
  const usdRows = usdRes.data.values || [];

  // ARS: indices 0-10 = Moises, 15-25 = Oriana, 30-40 = Compartido
  // (indices 11-14 y 26-29 son TOTAL, blank, título, header → se filtran por valor)
  const sections = [
    { offset: 0, tipo: 'Individual Moises' },
    { offset: 15, tipo: 'Individual Oriana' },
    { offset: 30, tipo: 'Compartido' },
  ];

  for (const sec of sections) {
    for (let i = 0; i < 11; i++) {
      const row = arsRows[sec.offset + i];
      if (!row || !row[0]) continue;
      const categoria = String(row[0]).trim();
      const presupuesto = typeof row[1] === 'number' ? row[1] : parseLocalNumber(row[1]);
      if (presupuesto > 0) {
        presupuestos.set(`${categoria}|${sec.tipo}|ARS`, presupuesto);
      }
    }
  }

  // USD: indices 0-10 = Moises
  for (let i = 0; i < 11; i++) {
    const row = usdRows[i];
    if (!row || !row[0]) continue;
    const categoria = String(row[0]).trim();
    const presupuesto = typeof row[1] === 'number' ? row[1] : parseLocalNumber(row[1]);
    if (presupuesto > 0) {
      presupuestos.set(`${categoria}|Individual Moises|USD`, presupuesto);
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

  // 1. Limpiar todo desde fila 19 hacia abajo (metodos + balance + flujo + resumen anual)
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Dashboard!A19:F65',
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

  // === FLUJO DEL MES (rows 33-46) ===
  data.push({
    range: 'Dashboard!A33:B46',
    values: [
      ['', ''],                                                                                                 // 33: separador
      ['FLUJO DEL MES', ''],                                                                                    // 34: header
      ['Ingresó Moises (ARS)', loc(`=IFERROR(INDEX(Ingresos!F:F,$B$4+2),0)`)],                                  // 35
      ['Ingresó Oriana (ARS)', loc(`=IFERROR(INDEX(Ingresos!F:F,$B$4+18),0)`)],                                 // 36
      ['Total Ingresado ARS', loc('=B35+B36')],                                                                 // 37
      ['Gastado ARS', loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",${mf})`)],                          // 38
      ['— Tarjetas', loc('=B24')],                                                                              // 39: referencia al total tarjetas
      ['Sobrante ARS', loc('=B37-B38')],                                                                        // 40
      ['', ''],                                                                                                 // 41
      ['Salario Total USD', loc(`=IFERROR(INDEX(Ingresos!B:B,$B$4+2),0)+IFERROR(INDEX(Ingresos!B:B,$B$4+18),0)`)], // 42
      ['Transferido a ARS', loc(`=IFERROR(INDEX(Ingresos!D:D,$B$4+2),0)+IFERROR(INDEX(Ingresos!D:D,$B$4+18),0)`)], // 43
      ['Gastado USD', loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",${mf})`)],                          // 44
      ['Queda en Deel USD', loc(`=IFERROR(INDEX(Ingresos!C:C,$B$4+2),0)+IFERROR(INDEX(Ingresos!C:C,$B$4+18),0)`)], // 45
      ['', ''],                                                                                                 // 46
    ],
  });

  // === RESUMEN ANUAL (rows 48-63) ===
  data.push({
    range: 'Dashboard!A48:F50',
    values: [
      ['', '', '', '', '', ''],
      ['RESUMEN ANUAL', '', '', '', '', ''],
      ['Mes', 'Ingresado ARS', 'Gastado ARS', 'Sobrante ARS', 'Gastado USD', 'Ahorro USD'],
    ],
  });

  // 12 meses (rows 51-62)
  const anualRows = [];
  for (let m = 1; m <= 12; m++) {
    const mfFijo = `Transacciones!M:M,${m},Transacciones!N:N,$B$5`;
    const row = 50 + m;
    anualRows.push([
      MESES[m - 1],
      loc(`=IFERROR(INDEX(Ingresos!F:F,${m + 2}),0)+IFERROR(INDEX(Ingresos!F:F,${m + 18}),0)`),
      loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"ARS",${mfFijo})`),
      loc(`=B${row}-C${row}`),
      loc(`=SUMIFS(Transacciones!E:E,Transacciones!F:F,"USD",${mfFijo})`),
      loc(`=IFERROR(INDEX(Ingresos!C:C,${m + 2}),0)+IFERROR(INDEX(Ingresos!C:C,${m + 18}),0)`),
    ]);
  }
  data.push({ range: 'Dashboard!A51:F62', values: anualRows });

  // Total anual (row 63)
  data.push({
    range: 'Dashboard!A63:F63',
    values: [['TOTAL', loc('=SUM(B51:B62)'), loc('=SUM(C51:C62)'), loc('=SUM(D51:D62)'), loc('=SUM(E51:E62)'), loc('=SUM(F51:F62)')]],
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
    [34, 46, 1, 2],   // B35:B45 (flujo)
    [50, 63, 1, 6],   // B51:F63 (resumen anual)
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

  // Bold para headers: POR MÉTODO DE PAGO (row 19), BALANCE (row 30), FLUJO (row 34), RESUMEN ANUAL (row 49), TOTAL (row 63), Tarjetas total (row 24)
  for (const row of [18, 29, 33, 48, 62]) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dashId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 6 },
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

  // Bold para headers resumen anual (row 50)
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dashId, startRowIndex: 49, endRowIndex: 50, startColumnIndex: 0, endColumnIndex: 6 },
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
      { row: 17, label: 'POR MÉTODO DE PAGO', bg: C.headerMed, text: C.white },    // row 18 (setupDashboardCards wrote row 19 header)
      { row: 29, label: 'BALANCE COMPARTIDO', bg: C.headerMed, text: C.white },     // row 30
      { row: 33, label: 'FLUJO DEL MES', bg: C.headerDark, text: C.white },         // row 34
      { row: 48, label: 'RESUMEN ANUAL', bg: C.headerDark, text: C.white },         // row 49
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
      [34, 45],  // flujo
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
    requests.push(textFmt(dash, 37, 39, 1, 2, { color: C.red }));    // gastos
    requests.push(bgColor(dash, 39, 40, 0, 2, C.greenLight));        // sobrante
    requests.push(textFmt(dash, 39, 40, 0, 2, { bold: true, color: C.green }));

    // Resumen anual - headers fila
    requests.push(bgColor(dash, 49, 50, 0, 6, C.headerLight));
    requests.push(textFmt(dash, 49, 50, 0, 6, { bold: true, color: C.headerDark, hAlign: 'CENTER' }));
    // Alternating rows
    requests.push(...altRows(dash, 50, 62, 6));
    // Total anual
    requests.push(bgColor(dash, 62, 63, 0, 6, C.totalBg));
    requests.push(textFmt(dash, 62, 63, 0, 6, { bold: true, color: C.headerDark }));
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
  // 4. PRESUPUESTO ARS (3 secciones, cada una: titulo + header + 11 cats + total = ~14 filas)
  // ============================================================
  const pArs = sheetMap['Presupuesto ARS'];
  if (pArs !== undefined) {
    // Año en fila 1
    requests.push(textFmt(pArs, 0, 1, 0, 2, { bold: true, color: C.headerDark, fontSize: 12 }));

    // 3 secciones: empiezan en filas 3, ~18, ~33 (fila 3 + 15*n)
    const secStarts = [2, 17, 32]; // 0-indexed: filas 3, 18, 33
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
      // Alternating rows (11 categorias)
      requests.push(...altRows(pArs, start + 2, start + 13, 16));
      // Total
      requests.push(bgColor(pArs, start + 13, start + 14, 0, 16, C.totalBg));
      requests.push(textFmt(pArs, start + 13, start + 14, 0, 16, { bold: true }));
    }

    requests.push(colWidth(pArs, 0, 160)); // Categoria
    requests.push(colWidth(pArs, 1, 100)); // Presup
  }

  // ============================================================
  // 5. PRESUPUESTO USD (1 seccion)
  // ============================================================
  const pUsd = sheetMap['Presupuesto USD'];
  if (pUsd !== undefined) {
    requests.push(textFmt(pUsd, 0, 1, 0, 2, { bold: true, color: C.headerDark, fontSize: 12 }));
    requests.push(bgColor(pUsd, 2, 3, 0, 16, C.sectionBg));
    requests.push(textFmt(pUsd, 2, 3, 0, 16, { bold: true, color: C.headerDark, hAlign: 'CENTER' }));
    requests.push(bgColor(pUsd, 3, 4, 0, 16, C.headerDark));
    requests.push(textFmt(pUsd, 3, 4, 0, 16, { bold: true, color: C.white, hAlign: 'CENTER' }));
    requests.push(...altRows(pUsd, 4, 15, 16));
    requests.push(bgColor(pUsd, 15, 16, 0, 16, C.totalBg));
    requests.push(textFmt(pUsd, 15, 16, 0, 16, { bold: true }));
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
  const MAX_TX = 200;
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
  const MAX_TX = 200;

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

  // 3. Presupuesto ARS — 3 secciones
  // Estructura: titulo, header, 11 categorías, total (cada sección = 15 filas empezando fila 3, 18, 33)
  const pArsId = sheetMap['Presupuesto ARS'];
  if (pArsId !== undefined) {
    const secStarts = [4, 19, 34]; // 0-indexed: filas de datos (después de titulo+header)
    for (const start of secStarts) {
      // Cols B-O (index 1-14): Presup + 12 meses + Total → #,##0
      requests.push(fmt(pArsId, start, start + 12, 1, 15, '#,##0'));
      // Col P (index 15): % → 0%
      requests.push(fmt(pArsId, start, start + 12, 15, 16, '0%'));
    }
  }

  // 4. Presupuesto USD — 1 sección
  const pUsdId = sheetMap['Presupuesto USD'];
  if (pUsdId !== undefined) {
    requests.push(fmt(pUsdId, 4, 16, 1, 15, '#,##0'));
    requests.push(fmt(pUsdId, 4, 16, 15, 16, '0%'));
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

  const MAX = 200;
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

module.exports = {
  sheets, testConnection, appendTransaction, setupPhase4, setupDashboard, setupDashboardCards, setupEstilos,
  getBalance, getMonthlyTransactions, getGastosFijos, updateGastoFijoMonto, getLastTransactions,
  deleteTransaction, getIncomeStatus, registerIncome, getCurrentIncome, updateIncome, getFlowData,
  setupCuotas, getCuotas, appendCuota, updateCuotaRegistradas, updateCuotaMonto,
  extendSheetLimits, setupFormatos, getPresupuestos,
  getSharedUnsettled, settleTransaction, setupSaldado, setupFrecuencia,
};
