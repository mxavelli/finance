// Carga y cachea categorias con keywords desde la hoja Categorias del Sheet.

const { sheets } = require('./sheets');
const config = require('./config');

let cachedCategories = null;

// Carga categorias y keywords desde el Sheet.
// Formato: columna A = nombre, columna B = keywords separadas por coma.
async function loadCategories() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: 'Categorías!A2:B',
  });

  const rows = response.data.values || [];
  cachedCategories = rows.map(([name, keywordsStr]) => ({
    name,
    keywords: keywordsStr ? keywordsStr.split(',').map(k => k.trim().toLowerCase()) : [],
  }));

  return cachedCategories;
}

// Devuelve categorias cacheadas o las carga por primera vez.
async function getCategories() {
  if (!cachedCategories) {
    await loadCategories();
  }
  return cachedCategories;
}

// Fuerza recarga desde el Sheet.
async function reloadCategories() {
  cachedCategories = null;
  return loadCategories();
}

module.exports = { getCategories, reloadCategories };
