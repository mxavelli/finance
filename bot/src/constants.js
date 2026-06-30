// Constantes compartidas entre módulos.

// Categorías donde "gastar" no es consumo sino ahorro/inversión.
// Se excluyen de los promedios de gasto (no inflan las proyecciones) y de las
// alertas de exceso de presupuesto (para estas se invierte la lógica: alerta
// cuando estás BAJO la meta, no al excederla).
const CATEGORIAS_POSITIVAS = ['Ahorro / Inversión'];

module.exports = { CATEGORIAS_POSITIVAS };
