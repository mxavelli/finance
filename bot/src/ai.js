// Módulo de inteligencia artificial para transcripción de audio y análisis de recibos.
// Usa OpenAI: Whisper para audio, GPT-4o-mini para texto e imágenes.

const OpenAI = require('openai');
const config = require('./config');

let openai = null;

function getClient() {
  if (!config.openaiApiKey) return null;
  if (!openai) {
    openai = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openai;
}

// Transcribe un archivo de audio (buffer OGG/Opus de Telegram) a texto en español.
async function transcribeAudio(fileBuffer) {
  const client = getClient();
  if (!client) throw new Error('OpenAI no configurado');

  const file = new File([fileBuffer], 'audio.ogg', { type: 'audio/ogg' });

  const response = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    language: 'es',
  });

  return response.text;
}

// Parsea un texto de gasto usando GPT-4o-mini.
// Recibe el texto, lista de categorías y las tarjetas de crédito del usuario.
// Devuelve JSON con: descripcion, monto, moneda, categoria, metodoPago, tipo, cuotas.
// Campos que la IA no pueda determinar → null.
async function parseExpense(text, categoryNames, userCardNames) {
  const client = getClient();
  if (!client) throw new Error('OpenAI no configurado');

  const categoriesList = categoryNames.join(', ');
  const cardsList = userCardNames && userCardNames.length > 0
    ? userCardNames.join(', ')
    : 'Tarjeta';

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Sos un asistente de finanzas personales argentino. Tu tarea es extraer los datos de un gasto a partir de texto (escrito o hablado).

Devolvé SOLO un JSON válido con estos campos:
- "descripcion": concepto breve del gasto (ej: "Café", "Supermercado", "Uber"). NO incluyas el monto, método de pago ni "compartido" en la descripción.
- "monto": monto como número (sin símbolos, sin puntos de miles). Ej: 6000, 15000, 3500. "8 mil" = 8000, "quince mil" = 15000.
- "moneda": "ARS" o "USD". Default "ARS" si no se aclara.
- "categoria": una de estas categorías exactas: ${categoriesList}. Elegí la que mejor encaje con el gasto. Si no estás seguro, usá "Otros".
- "metodoPago": método de pago usado. Valores válidos:
  * Tarjetas de crédito del usuario: ${cardsList} (usá el nombre EXACTO si se menciona alguna)
  * "Banco" (transferencia, débito, cuenta bancaria)
  * "Efectivo" (cash, plata en mano)
  * "Deel Card" (tarjeta Deel para pagos en ARS — si dicen "deel" o "deel visa", siempre usar "Deel Card")
  * "Deel USD" (pago en dólares desde Deel)
  Si el usuario dice "tarjeta" o "crédito" sin especificar cuál, poné "Tarjeta".
  Si no se menciona método de pago, poné null.
- "tipo": "Compartido" si se menciona que es compartido/entre dos/mitad. Si no se menciona, poné null.
- "cuotas": número de cuotas si se mencionan (ej: "en 3 cuotas" → 3). Si hay cuotas, el método DEBE ser una tarjeta de crédito. Si no hay cuotas, null.

Si el texto no describe un gasto o no tiene monto, devolvé: {"error": "No pude identificar un gasto"}

Ejemplos:
"cafe 6000 visa bbva" → {"descripcion": "Café", "monto": 6000, "moneda": "ARS", "categoria": "Alimentación", "metodoPago": "Visa BBVA", "tipo": null, "cuotas": null}
"super 15000 compartido banco" → {"descripcion": "Supermercado", "monto": 15000, "moneda": "ARS", "categoria": "Alimentación", "metodoPago": "Banco", "tipo": "Compartido", "cuotas": null}
"zapatillas 90000 3 cuotas master galicia" → {"descripcion": "Zapatillas", "monto": 90000, "moneda": "ARS", "categoria": "Ropa y personal", "metodoPago": "Master Galicia", "tipo": null, "cuotas": 3}
"uber 3500 banco" → {"descripcion": "Uber", "monto": 3500, "moneda": "ARS", "categoria": "Transporte", "metodoPago": "Banco", "tipo": null, "cuotas": null}
"un café a ocho mil pesos con la visa" → {"descripcion": "Café", "monto": 8000, "moneda": "ARS", "categoria": "Alimentación", "metodoPago": "Visa BBVA", "tipo": null, "cuotas": null}
"almuerzo doce mil compartido" → {"descripcion": "Almuerzo", "monto": 12000, "moneda": "ARS", "categoria": "Alimentación", "metodoPago": null, "tipo": "Compartido", "cuotas": null}`,
      },
      {
        role: 'user',
        content: text,
      },
    ],
    max_tokens: 200,
  });

  const output = response.choices[0].message.content.trim();
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { error: 'No pude interpretar el gasto' };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { error: 'No pude interpretar el gasto' };
  }
}

// Analiza una imagen de recibo/factura y extrae datos estructurados.
// Recibe la URL temporal de la imagen, lista de categorías y tarjetas del usuario.
async function analyzeReceipt(imageUrl, categoryNames, userCardNames) {
  const client = getClient();
  if (!client) throw new Error('OpenAI no configurado');

  const categoriesList = categoryNames ? categoryNames.join(', ') : 'Alimentación, Transporte, Entretenimiento, Hogar, Salud, Suscripciones, Ropa y personal, Moto, Educación, Ahorro / Inversión, Otros';
  const cardsList = userCardNames && userCardNames.length > 0
    ? userCardNames.join(', ')
    : 'Tarjeta';

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Sos un asistente que extrae datos de recibos y facturas argentinas.
Devolvé SOLO un JSON válido con estos campos:
- "descripcion": nombre del comercio o concepto (texto corto)
- "monto": monto total como número (sin símbolos, sin puntos de miles)
- "categoria": una de estas categorías exactas: ${categoriesList}. Elegí la que mejor encaje. Si no estás seguro, usá "Otros".
- "metodoPago": método de pago si se puede detectar del recibo. Valores válidos:
  * Tarjetas de crédito: ${cardsList} (nombre exacto)
  * "Banco", "Efectivo", "Deel Card", "Deel USD"
  * null si no se puede determinar
- "notas": detalles extra relevantes o null

Si no podés leer el recibo o no es una factura, devolvé: {"error": "No pude leer este recibo"}`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extraé los datos de este recibo:' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 200,
  });

  const text = response.choices[0].message.content.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { error: 'No pude interpretar la respuesta del análisis' };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { error: 'No pude leer este recibo' };
  }
}

function isConfigured() {
  return !!config.openaiApiKey;
}

// Analiza un PDF de resumen de tarjeta de crédito argentina.
// Extrae texto con pdf-parse y lo pasa a GPT-4o-mini para estructurar.
// Devuelve { tarjeta, cierre, vencimiento, totalArs, totalUsd, items }
async function analyzeStatementPdf(pdfBuffer, userCardNames) {
  const client = getClient();
  if (!client) throw new Error('OpenAI no configurado');

  const pdfParse = require('pdf-parse');
  const data = await pdfParse(pdfBuffer);
  const rawText = data.text;

  // Recortar T&C (las páginas finales de los resúmenes son legales y no aportan)
  // Cortar en marcadores típicos para ahorrar tokens y dejar solo la sección de consumos
  let text = rawText;
  const cutMarkers = [
    'OPCIONES DE FINANCIACION',
    'INFORMACION DE LA ENTIDAD',
    'INFORMACION INSTITUCIONAL',
    'A partir del',
    'Plan V: abonando',
  ];
  for (const marker of cutMarkers) {
    const idx = text.indexOf(marker);
    if (idx > 0 && idx < text.length) {
      text = text.substring(0, idx);
      break;
    }
  }
  // Tope de seguridad
  if (text.length > 10000) text = text.substring(0, 10000);

  const cardsList = (userCardNames || []).join(', ');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Extraés datos de un resumen de tarjeta de crédito argentina (Galicia, BBVA, etc.).
Devolvé SOLO un JSON válido con esta estructura:
{
  "tarjeta": "Visa Galicia" | "Master Galicia" | "Visa BBVA" | "Master BBVA",
  "cierre": "DD/MM/YYYY",
  "vencimiento": "DD/MM/YYYY",
  "totalArs": número (positivo, total a pagar en pesos),
  "totalUsd": número (positivo, total a pagar en dólares; 0 si no hay),
  "items": [
    { "fecha": "DD/MM/YYYY", "descripcion": "string corto", "monto": número positivo, "moneda": "ARS" | "USD", "esCuota": boolean }
  ]
}

Reglas críticas:
- "tarjeta": VISA Eminent/Black/Signature → "Visa Galicia" (si Galicia); MASTERCARD BLACK → "Master Galicia" (si Galicia). Para BBVA: VISA → "Visa BBVA", MASTER → "Master BBVA".
- "cierre"/"vencimiento": las fechas del CICLO ACTUAL (no anterior). El "VENCIMIENTO ACTUAL" es la fecha cerca del total a pagar. Formato DD/MM/YYYY. Asumí año 2026 si solo aparece "May 26".
- "totalArs": número grande junto al label "TOTAL A PAGAR" o "SALDO ACTUAL" en pesos.
- "totalUsd": el segundo número de la línea del total, en dólares. Ejemplo: si ves "VENCIMIENTOSALDO \$SALDO U\$SPAGO MIN.\$PAGO MIN.U\$S 15 May 26 2.828.119,80 177,10 285.160,00 -,--" entonces totalArs=2828119.80 y totalUsd=177.10. SIEMPRE chequeá si hay un total en USD.
- "items": cada línea de consumo en el "DETALLE DEL CONSUMO". INCLUÍ las CUOTAS de meses anteriores (líneas con fecha vieja tipo "04.08.25" o "11.11.25" y texto "Cuota X/Y" — son cuotas de compras pasadas que se siguen pagando).
- "esCuota": true si la descripción tiene "Cuota X/Y" (ej "Cuota 10/12", "Cuota 6/6"). False si es consumo nuevo del período.
- Items en USD: una línea puede tener formato "fecha descripcion monto_ars monto_usd" donde ambos números son iguales. En ese caso es un consumo USD (el monto en pesos es el equivalente). Marcalo como moneda="USD" con el monto USD.
- Para números argentinos: "2.828.119,80" → 2828119.80. "177,10" → 177.10. "31.666,66" → 31666.66.
- EXCLUIR: líneas de "SALDO ANTERIOR", "SU PAGO", "BONI MANT", "COM MANT", "PERCEPCION", "PERCEP", "IVA RG", "DB.RG", "IIBB", "SUBTOTAL", "TOTAL A PAGAR".
- "fecha": del item, formato DD/MM/YYYY. Si el año del PDF es 26, expandir a 2026. Si es 25, expandir a 2025.

Tarjetas posibles del usuario: ${cardsList}.

Si no podés identificar el resumen, devolvé: {"error": "No pude leer el resumen"}`,
      },
      {
        role: 'user',
        content: `Resumen TC:\n\n${text}`,
      },
    ],
    max_tokens: 12000,
    response_format: { type: 'json_object' },
  });

  const output = response.choices[0].message.content.trim();
  try {
    return JSON.parse(output);
  } catch {
    return { error: 'JSON inválido del resumen' };
  }
}

module.exports = { transcribeAudio, parseExpense, analyzeReceipt, analyzeStatementPdf, isConfigured };
