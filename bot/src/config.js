// Configuración central del proyecto.
// Carga variables de entorno y valida que existan las requeridas.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const required = [
  'BOT_TOKEN', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY',
  'MOISES_TELEGRAM_ID', 'ORIANA_TELEGRAM_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Error: Falta la variable de entorno ${key}. Revisá el archivo .env`);
    process.exit(1);
  }
}

module.exports = {
  botToken: process.env.BOT_TOKEN,
  sheetId: process.env.GOOGLE_SHEET_ID,
  moisesId: parseInt(process.env.MOISES_TELEGRAM_ID),
  orianaId: parseInt(process.env.ORIANA_TELEGRAM_ID),
  google: {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Las claves privadas en env vars tienen \n literal que hay que convertir
    privateKey: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  // Ingresos mensuales default (opcionales, para /cotizacion y recordatorio)
  income: {
    moisesSalaryUsd: process.env.MOISES_SALARY_USD ? parseFloat(process.env.MOISES_SALARY_USD) : null,
    moisesSalaryArs: process.env.MOISES_SALARY_ARS ? parseFloat(process.env.MOISES_SALARY_ARS) : null,
    orianaSalaryUsd: process.env.ORIANA_SALARY_USD ? parseFloat(process.env.ORIANA_SALARY_USD) : null,
    orianaSalaryArs: process.env.ORIANA_SALARY_ARS ? parseFloat(process.env.ORIANA_SALARY_ARS) : null,
  },
  // Tarjetas de crédito por usuario
  tarjetas: {
    [parseInt(process.env.MOISES_TELEGRAM_ID)]: ['Visa Galicia', 'Master Galicia'],
    [parseInt(process.env.ORIANA_TELEGRAM_ID)]: ['Visa BBVA', 'Master BBVA'],
  },
  todasLasTarjetas: ['Visa Galicia', 'Master Galicia', 'Visa BBVA', 'Master BBVA'],
  // Día de cierre de tarjetas de crédito (para calcular primera cuota)
  // 0 = no configurado → primera cuota siempre mes siguiente
  cierreTarjetas: {
    'Visa Galicia': parseInt(process.env.CIERRE_GALICIA) || 0,
    'Master Galicia': parseInt(process.env.CIERRE_GALICIA) || 0,
    'Visa BBVA': parseInt(process.env.CIERRE_BBVA) || 0,
    'Master BBVA': parseInt(process.env.CIERRE_BBVA) || 0,
  },
};
