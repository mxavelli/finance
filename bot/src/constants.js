// Constantes compartidas entre módulos.

// Categorías donde "gastar" no es consumo sino ahorro/inversión.
// Se excluyen de los promedios de gasto (no inflan las proyecciones) y de las
// alertas de exceso de presupuesto (para estas se invierte la lógica: alerta
// cuando estás BAJO la meta, no al excederla).
const CATEGORIAS_POSITIVAS = ['Ahorro / Inversión'];

// Suma el ahorro del mes de un usuario expresado en ARS.
// La meta de ahorro está siempre en ARS, así que los aportes en USD
// (Deel USD) se convierten usando el TC provisto. Los aportes en ARS van tal cual.
function ahorradoEnArs(transactions, tipoFilter, tc) {
  return transactions
    .filter(t => t.categoria === 'Ahorro / Inversión' && t.tipo === tipoFilter)
    .reduce((sum, t) => {
      if (t.moneda === 'USD') return sum + t.monto * (tc > 0 ? tc : 0);
      return sum + t.monto;
    }, 0);
}

module.exports = { CATEGORIAS_POSITIVAS, ahorradoEnArs };
