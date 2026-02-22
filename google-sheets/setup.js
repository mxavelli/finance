/**
 * ============================================
 * FINANZAS PERSONALES - SETUP GOOGLE SHEET
 * ============================================
 *
 * INSTRUCCIONES:
 * 1. Crear un Google Sheet nuevo en blanco
 * 2. Ir a Extensiones > Apps Script
 * 3. Borrar el contenido del editor y pegar este código completo
 * 4. Guardar (Ctrl+S)
 * 5. Ejecutar setupParte1() → esperar a que termine
 * 6. Ejecutar setupParte2() → esperar a que termine
 * 7. Ejecutar setupParte3() → esperar a que termine
 * 8. Ejecutar setupParte4() → esperar a que termine
 *
 * Se divide en 4 funciones para respetar el límite de 6 minutos.
 */

// ==========================================
// CONFIGURACIÓN
// ==========================================

const AÑO_INICIAL = 2026;
const MAX_TX = 5000;

const CATEGORIAS = [
  ['Alimentación', 'super,supermercado,mercado,comida,cena,almuerzo,desayuno,delivery,restaurante,café,bar,pedidosya,rappi'],
  ['Transporte', 'uber,cabify,taxi,remis,nafta,combustible,peaje,estacionamiento,subte,colectivo,bondi'],
  ['Entretenimiento', 'cine,teatro,salida,juego,gaming,streaming'],
  ['Hogar', 'alquiler,expensas,luz,gas,agua,internet,wifi,limpieza,mueble,decoración'],
  ['Salud', 'farmacia,médico,doctor,consulta,prepaga,obra social,medicamento'],
  ['Suscripciones', 'spotify,netflix,youtube,hbo,disney,software,app,icloud,chatgpt'],
  ['Ropa y personal', 'ropa,zapatillas,perfume,peluquería,barbería'],
  ['Moto', 'seguro moto,patente moto,mecánico moto,casco,aceite moto'],
  ['Educación', 'curso,libro,capacitación,udemy,platzi'],
  ['Ahorro / Inversión', 'ahorro,inversión,plazo fijo,crypto,cedear'],
  ['Otros', '']
];

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const NOMBRES_CAT = CATEGORIAS.map(c => c[0]);
const NUM_CAT = CATEGORIAS.length;

const COL_HEADER = '#1a73e8';
const COL_HEADER_TXT = '#ffffff';
const COL_SECTION = '#e8f0fe';
const COL_TOTAL = '#f1f3f4';

// ==========================================
// HELPERS
// ==========================================

/**
 * Convierte fórmula de notación US (,) a locale argentino (;).
 * Solo reemplaza comas FUERA de strings entre comillas.
 * Ej: =IFERROR(A1/B1,0) → =IFERROR(A1/B1;0)
 * Ej: =TEXT(A1,"#,##0") → =TEXT(A1;"#,##0") — la coma dentro de "#,##0" NO se toca
 */
function loc(formula) {
  var result = '';
  var inQuotes = false;
  for (var i = 0; i < formula.length; i++) {
    var ch = formula[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      result += ch;
    } else if (ch === ',' && !inQuotes) {
      result += ';';
    } else {
      result += ch;
    }
  }
  return result;
}

/** Aplica loc() a un array 2D de fórmulas */
function locAll(formulas) {
  return formulas.map(function(row) { return row.map(function(f) { return loc(f); }); });
}

function formatHeader(range) {
  range.setBackground(COL_HEADER).setFontColor(COL_HEADER_TXT).setFontWeight('bold').setHorizontalAlignment('center');
}

// ==========================================
// PARTE 1: Hojas + Categorías + Transacciones
// ==========================================

function setupParte1() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Crear todas las hojas
  ['Dashboard', 'Transacciones', 'Presupuesto ARS', 'Presupuesto USD',
   'Balance Compartido', 'Gastos Fijos', 'Ingresos', 'Categorías'
  ].forEach(function(nombre) {
    if (!ss.getSheetByName(nombre)) ss.insertSheet(nombre);
  });
  ['Hoja 1', 'Sheet1', 'Sheet 1'].forEach(function(name) {
    var s = ss.getSheetByName(name);
    if (s) ss.deleteSheet(s);
  });

  // === CATEGORÍAS ===
  var catSheet = ss.getSheetByName('Categorías');
  catSheet.clear();
  var catData = [['Categoría', 'Keywords (para el bot)']].concat(CATEGORIAS);
  catSheet.getRange(1, 1, catData.length, 2).setValues(catData);
  formatHeader(catSheet.getRange(1, 1, 1, 2));
  catSheet.setColumnWidth(1, 180);
  catSheet.setColumnWidth(2, 500);

  // === TRANSACCIONES ===
  var tx = ss.getSheetByName('Transacciones');
  tx.clear();

  tx.getRange(1, 1, 1, 16).setValues([[
    'Fecha', 'Hora', 'Descripción', 'Categoría', 'Monto', 'Moneda',
    'Método de pago', 'Tipo', 'Pagado por', 'Split Moises %', 'Split Oriana %', 'Notas',
    'Mes', 'Año', 'Monto Moises', 'Monto Oriana'
  ]]);
  formatHeader(tx.getRange(1, 1, 1, 16));
  tx.getRange(1, 13, 1, 4).setBackground('#666666');

  // ARRAYFORMULAs helper (columnas ocultas M-P)
  tx.getRange('M2').setFormula(loc('=ARRAYFORMULA(IF(A2:A="","",MONTH(A2:A)))'));
  tx.getRange('N2').setFormula(loc('=ARRAYFORMULA(IF(A2:A="","",YEAR(A2:A)))'));
  tx.getRange('O2').setFormula(loc('=ARRAYFORMULA(IF(A2:A="","",E2:E*J2:J/100))'));
  tx.getRange('P2').setFormula(loc('=ARRAYFORMULA(IF(A2:A="","",E2:E*K2:K/100))'));

  tx.getRange('A2:A' + MAX_TX).setNumberFormat('dd/MM/yyyy');
  tx.getRange('E2:E' + MAX_TX).setNumberFormat('#,##0.00');

  // Validaciones
  tx.getRange('D2:D' + MAX_TX).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(catSheet.getRange('A2:A' + (NUM_CAT + 1)), true).setAllowInvalid(false).build());
  tx.getRange('F2:F' + MAX_TX).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['ARS', 'USD']).setAllowInvalid(false).build());
  tx.getRange('G2:G' + MAX_TX).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Deel Card', 'Banco', 'Efectivo', 'Deel USD']).setAllowInvalid(false).build());
  tx.getRange('H2:H' + MAX_TX).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Individual Moises', 'Individual Oriana', 'Compartido']).setAllowInvalid(false).build());
  tx.getRange('I2:I' + MAX_TX).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Moises', 'Oriana']).setAllowInvalid(false).build());

  tx.hideColumns(13, 4);
  tx.setFrozenRows(1);

  SpreadsheetApp.getUi().alert('✅ Parte 1 completada.\n\nAhora ejecutá setupParte2()');
}

// ==========================================
// PARTE 2: Presupuestos ARS + USD
// ==========================================

function setupParte2() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // === PRESUPUESTO ARS (3 secciones) ===
  var arsSheet = ss.getSheetByName('Presupuesto ARS');
  arsSheet.clear();
  arsSheet.getRange(1, 1, 1, 2).setValues([['Año:', AÑO_INICIAL]]).setFontWeight('bold');

  var fila = 3;
  fila = crearSeccionPresupuesto(arsSheet, fila, 'INDIVIDUAL MOISES', 'Individual Moises', 'ARS');
  fila = crearSeccionPresupuesto(arsSheet, fila, 'INDIVIDUAL ORIANA', 'Individual Oriana', 'ARS');
  fila = crearSeccionPresupuesto(arsSheet, fila, 'COMPARTIDO', 'Compartido', 'ARS');

  // === PRESUPUESTO USD (1 sección) ===
  var usdSheet = ss.getSheetByName('Presupuesto USD');
  usdSheet.clear();
  usdSheet.getRange(1, 1, 1, 2).setValues([['Año:', AÑO_INICIAL]]).setFontWeight('bold');
  crearSeccionPresupuesto(usdSheet, 3, 'MOISES (USD)', 'Individual Moises', 'USD');

  SpreadsheetApp.getUi().alert('✅ Parte 2 completada.\n\nAhora ejecutá setupParte3()');
}

// ==========================================
// PARTE 3: Gastos Fijos, Ingresos, Balance, Dashboard
// ==========================================

function setupParte3() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var catSheet = ss.getSheetByName('Categorías');

  // === GASTOS FIJOS ===
  var gf = ss.getSheetByName('Gastos Fijos');
  gf.clear();
  gf.getRange(1, 1, 1, 8).setValues([[
    'Descripción', 'Categoría', 'Monto estimado', 'Moneda',
    'Método de pago', 'Tipo', 'Día del mes', '¿Registrado este mes?'
  ]]);
  formatHeader(gf.getRange(1, 1, 1, 8));

  gf.getRange('B2:B50').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(catSheet.getRange('A2:A' + (NUM_CAT + 1)), true).setAllowInvalid(false).build());
  gf.getRange('D2:D50').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['ARS', 'USD']).setAllowInvalid(false).build());
  gf.getRange('E2:E50').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Deel Card', 'Banco', 'Efectivo', 'Deel USD']).setAllowInvalid(false).build());
  gf.getRange('F2:F50').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Individual Moises', 'Individual Oriana', 'Compartido']).setAllowInvalid(false).build());
  gf.getRange('C2:C50').setNumberFormat('#,##0');

  var regFormulas = [];
  for (var row = 2; row <= 20; row++) {
    regFormulas.push([loc('=IF(A' + row + '="","",IF(COUNTIFS(Transacciones!$C$2:$C$' + MAX_TX + ',"*"&A' + row + '&"*",Transacciones!$M$2:$M$' + MAX_TX + ',MONTH(TODAY()),Transacciones!$N$2:$N$' + MAX_TX + ',YEAR(TODAY()))>0,"✅ Sí","❌ No"))')]);
  }
  gf.getRange(2, 8, 19, 1).setFormulas(regFormulas);

  gf.getRange(2, 1, 7, 7).setValues([
    ['Alquiler', 'Hogar', '', 'ARS', 'Banco', 'Compartido', 1],
    ['Expensas', 'Hogar', '', 'ARS', 'Banco', 'Compartido', 5],
    ['Internet', 'Hogar', '', 'ARS', 'Banco', 'Compartido', 10],
    ['Netflix', 'Suscripciones', '', 'USD', 'Deel USD', 'Compartido', 15],
    ['Spotify', 'Suscripciones', '', 'USD', 'Deel USD', 'Individual Moises', 15],
    ['Prepaga Moises', 'Salud', '', 'ARS', 'Banco', 'Individual Moises', 1],
    ['Seguro moto', 'Moto', '', 'ARS', 'Banco', 'Individual Moises', 10],
  ]);
  gf.setFrozenRows(1);

  // === INGRESOS ===
  var ing = ss.getSheetByName('Ingresos');
  ing.clear();

  // Sección Moises
  ing.getRange(1, 1, 1, 6).merge().setValue('── INGRESOS MOISES ──')
    .setFontWeight('bold').setBackground(COL_SECTION).setHorizontalAlignment('center');
  ing.getRange(2, 1, 1, 6).setValues([['Mes', 'Salario USD', 'Queda en Deel USD', 'Transferido a ARS (USD)', 'TC Usado', 'Recibido ARS']]);
  formatHeader(ing.getRange(2, 1, 1, 6));
  ing.getRange(3, 1, 12, 1).setValues(MESES.map(function(m) { return [m]; }));
  ing.getRange('B3:E14').setNumberFormat('#,##0.00');
  ing.getRange('F3:F14').setNumberFormat('#,##0');

  var arsFormulas = [];
  for (var r = 3; r <= 14; r++) arsFormulas.push([loc('=IF(D' + r + '="","",D' + r + '*E' + r + ')')]);
  ing.getRange(3, 6, 12, 1).setFormulas(arsFormulas);

  // Total Moises
  ing.getRange(15, 1).setValue('TOTAL');
  ing.getRange(15, 2, 1, 5).setFormulas([[
    loc('=SUM(B3:B14)'), loc('=SUM(C3:C14)'), loc('=SUM(D3:D14)'),
    loc('=IFERROR(F15/D15,"")'), loc('=SUM(F3:F14)')
  ]]);
  ing.getRange(15, 1, 1, 6).setBackground(COL_TOTAL).setFontWeight('bold');

  // Sección Oriana
  ing.getRange(17, 1, 1, 3).merge().setValue('── INGRESOS ORIANA ──')
    .setFontWeight('bold').setBackground(COL_SECTION).setHorizontalAlignment('center');
  ing.getRange(18, 1, 1, 3).setValues([['Mes', 'Ingreso ARS', 'Fuente / Descripción']]);
  formatHeader(ing.getRange(18, 1, 1, 3));
  ing.getRange(19, 1, 12, 1).setValues(MESES.map(function(m) { return [m]; }));
  ing.getRange('B19:B30').setNumberFormat('#,##0');

  // Total Oriana
  ing.getRange(31, 1).setValue('TOTAL');
  ing.getRange(31, 2).setFormula(loc('=SUM(B19:B30)'));
  ing.getRange(31, 1, 1, 3).setBackground(COL_TOTAL).setFontWeight('bold');
  ing.getRange(31, 2).setNumberFormat('#,##0');

  // === BALANCE COMPARTIDO ===
  var bal = ss.getSheetByName('Balance Compartido');
  bal.clear();
  bal.getRange(1, 1, 1, 2).setValues([['Año:', AÑO_INICIAL]]).setFontWeight('bold');
  bal.getRange(3, 1, 1, 8).merge().setValue('── BALANCE GASTOS COMPARTIDOS (ARS) ──')
    .setFontWeight('bold').setBackground(COL_SECTION).setHorizontalAlignment('center');
  bal.getRange(4, 1, 1, 8).setValues([['Mes', 'Total Compartido', 'Pagó Moises', 'Pagó Oriana', 'Corresponde Moises', 'Corresponde Oriana', 'Balance Moises', 'Resultado']]);
  formatHeader(bal.getRange(4, 1, 1, 8));
  bal.getRange(5, 1, 12, 1).setValues(MESES.map(function(m) { return [m]; }));

  var balFormulas = [];
  for (var i = 0; i < 12; i++) {
    var bRow = 5 + i, mes = i + 1;
    var b = ',Transacciones!$M$2:$M$' + MAX_TX + ',' + mes + ',Transacciones!$N$2:$N$' + MAX_TX + ',$B$1)';
    var f = 'Transacciones!$H$2:$H$' + MAX_TX + ',"Compartido",Transacciones!$F$2:$F$' + MAX_TX + ',"ARS"';
    balFormulas.push([
      '=SUMIFS(Transacciones!$E$2:$E$' + MAX_TX + ',' + f + b,
      '=SUMIFS(Transacciones!$E$2:$E$' + MAX_TX + ',' + f + ',Transacciones!$I$2:$I$' + MAX_TX + ',"Moises"' + b,
      '=SUMIFS(Transacciones!$E$2:$E$' + MAX_TX + ',' + f + ',Transacciones!$I$2:$I$' + MAX_TX + ',"Oriana"' + b,
      '=SUMIFS(Transacciones!$O$2:$O$' + MAX_TX + ',' + f + b,
      '=SUMIFS(Transacciones!$P$2:$P$' + MAX_TX + ',' + f + b,
      '=C' + bRow + '-E' + bRow,
      '=IF(B' + bRow + '=0,"",IF(G' + bRow + '>0,"Oriana debe $"&TEXT(ABS(G' + bRow + '),"#,##0")&" a Moises",IF(G' + bRow + '<0,"Moises debe $"&TEXT(ABS(G' + bRow + '),"#,##0")&" a Oriana","Están a mano")))'
    ]);
  }
  bal.getRange(5, 2, 12, 7).setFormulas(locAll(balFormulas));
  bal.getRange('B5:G16').setNumberFormat('#,##0');

  // Total anual
  bal.getRange(17, 1).setValue('TOTAL ANUAL').setFontWeight('bold');
  bal.getRange(17, 1, 1, 8).setBackground(COL_TOTAL);
  var totF = [];
  for (var c = 2; c <= 7; c++) { var l = String.fromCharCode(64 + c); totF.push('=SUM(' + l + '5:' + l + '16)'); }
  totF.push('=IF(G17>0,"Oriana debe $"&TEXT(ABS(G17),"#,##0")&" a Moises",IF(G17<0,"Moises debe $"&TEXT(ABS(G17),"#,##0")&" a Oriana","Están a mano"))');
  bal.getRange(17, 2, 1, 7).setFormulas(locAll([totF]));

  bal.getRange(19, 1).setValue('SALDO ACUMULADO:').setFontWeight('bold').setFontSize(12);
  bal.getRange(19, 2).setFormula(loc('=H17')).setFontWeight('bold').setFontSize(12);
  bal.setFrozenRows(4);

  SpreadsheetApp.getUi().alert('✅ Parte 3 completada.\n\nAhora ejecutá setupParte4()');
}

// ==========================================
// PARTE 4: Dashboard + orden de hojas
// ==========================================

function setupParte4() {
  Utilities.sleep(5000);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Dashboard');
  sheet.clear();

  // Solo estructura — las fórmulas se agregan en Fase 4 vía Sheets API
  sheet.getRange(1, 1, 1, 4).merge().setValue('FINANZAS PERSONALES').setFontWeight('bold').setFontSize(16);
  sheet.getRange(2, 1, 1, 4).merge().setValue('Las fórmulas de este dashboard se configuran automáticamente con el bot').setFontColor('#999999');

  sheet.getRange(4, 1, 1, 2).setValues([['Mes:', 2]]);
  sheet.getRange(4, 1).setFontWeight('bold');
  sheet.getRange(5, 1, 1, 2).setValues([['Año:', AÑO_INICIAL]]);
  sheet.getRange(5, 1).setFontWeight('bold');

  var labels = [
    ['', ''],
    ['RESUMEN DEL MES', ''],
    ['Total ARS', ''],
    ['Total USD', ''],
    ['Transacciones', ''],
    ['', ''],
    ['GASTO POR PERSONA', ''],
    ['Moises (ARS)', ''],
    ['Moises (USD)', ''],
    ['Oriana (ARS)', ''],
    ['Compartido (ARS)', ''],
    ['', ''],
    ['POR MÉTODO DE PAGO', ''],
    ['Deel Card', ''],
    ['Banco', ''],
    ['Efectivo', ''],
    ['Deel USD', ''],
    ['', ''],
    ['BALANCE COMPARTIDO', ''],
    ['Resultado:', '']
  ];
  sheet.getRange(7, 1, labels.length, 2).setValues(labels);

  // Formato secciones
  [7, 12, 18, 24].forEach(function(row) {
    sheet.getRange(row, 1, 1, 2).setFontWeight('bold').setBackground(COL_SECTION);
  });

  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 150);

  SpreadsheetApp.getUi().alert('✅ Parte 4 completada.\n\nDashboard listo (las fórmulas se agregan con el bot).');
}

// ==========================================
// HELPER: Sección de presupuesto
// ==========================================

function crearSeccionPresupuesto(sheet, fila, titulo, tipo, moneda) {
  sheet.getRange(fila, 1, 1, 16).merge().setValue('── ' + titulo + ' ──')
    .setFontWeight('bold').setBackground(COL_SECTION).setHorizontalAlignment('center');
  fila++;

  sheet.getRange(fila, 1, 1, 16).setValues([['Categoría', 'Presup.'].concat(MESES).concat(['Total', '%'])]);
  formatHeader(sheet.getRange(fila, 1, 1, 16));
  fila++;

  var p = fila;
  sheet.getRange(p, 1, NUM_CAT, 1).setValues(NOMBRES_CAT.map(function(c) { return [c]; }));
  sheet.getRange(p, 2, NUM_CAT, 1).setNumberFormat('#,##0');

  // Fórmulas batch: 11 categorías × 14 columnas (12 meses + total + %)
  sheet.getRange(p, 3, NUM_CAT, 14).setFormulas(locAll(NOMBRES_CAT.map(function(_, i) {
    var row = p + i;
    var r = [];
    for (var m = 1; m <= 12; m++) {
      r.push('=SUMIFS(Transacciones!$E$2:$E$' + MAX_TX +
        ',Transacciones!$D$2:$D$' + MAX_TX + ',$A' + row +
        ',Transacciones!$F$2:$F$' + MAX_TX + ',"' + moneda +
        '",Transacciones!$H$2:$H$' + MAX_TX + ',"' + tipo +
        '",Transacciones!$M$2:$M$' + MAX_TX + ',' + m +
        ',Transacciones!$N$2:$N$' + MAX_TX + ',$B$1)');
    }
    r.push('=SUM(C' + row + ':N' + row + ')');
    r.push('=IFERROR(O' + row + '/(B' + row + '*12),0)');
    return r;
  })));

  sheet.getRange(p, 3, NUM_CAT, 14).setNumberFormats(
    NOMBRES_CAT.map(function() { return Array(12).fill('#,##0').concat(['#,##0', '0%']); })
  );

  var u = p + NUM_CAT - 1;
  var t = u + 1;

  sheet.getRange(t, 1).setValue('TOTAL').setFontWeight('bold');
  sheet.getRange(t, 1, 1, 16).setBackground(COL_TOTAL);

  var totalRow = ['=SUM(B' + p + ':B' + u + ')'];
  for (var c = 3; c <= 14; c++) { var l = String.fromCharCode(64 + c); totalRow.push('=SUM(' + l + p + ':' + l + u + ')'); }
  totalRow.push('=SUM(O' + p + ':O' + u + ')');
  totalRow.push('=IFERROR(O' + t + '/(B' + t + '*12),0)');
  sheet.getRange(t, 2, 1, 15).setFormulas(locAll([totalRow]));
  sheet.getRange(t, 2, 1, 15).setNumberFormats([Array(14).fill('#,##0').concat(['0%'])]);

  return t + 2;
}
