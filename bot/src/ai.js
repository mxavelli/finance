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
// Recibe el texto (transcripción de audio o descripción), lista de categorías y nombre del sender.
// Devuelve JSON con: descripcion, monto, moneda, categoria, metodoPago, tipo, cuotas.
// Campos que la IA no pueda determinar → null.
async function parseExpense(text, categoryNames) {
  const client = getClient();
  if (!client) throw new Error('OpenAI no configurado');

  const categoriesList = categoryNames.join(', ');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Sos un asistente de finanzas personales argentino. Tu tarea es extraer los datos de un gasto a partir de texto hablado.

Devolvé SOLO un JSON válido con estos campos:
- "descripcion": concepto breve del gasto (ej: "Café", "Supermercado", "Uber"). NO incluyas el monto ni método de pago en la descripción.
- "monto": monto como número (sin símbolos, sin puntos de miles). Ej: 6000, 15000, 3500.
- "moneda": "ARS" o "USD". Default "ARS" si no se aclara.
- "categoria": una de estas categorías exactas: ${categoriesList}. Elegí la que mejor encaje con el gasto. Si no estás seguro, usá "Otros".
- "metodoPago": "Tarjeta", "Banco", "Efectivo", "Deel Card" o "Deel USD". Si no se menciona, poné null.
- "tipo": "Compartido" si se menciona que es compartido/entre dos/mitad. Si no se menciona, poné null.
- "cuotas": número de cuotas si se mencionan (ej: "en 3 cuotas" → 3). Si no, null.

Si el texto no describe un gasto o no tiene monto, devolvé: {"error": "No pude identificar un gasto"}

Ejemplos:
"Compré un café en la tienda por 6000" → {"descripcion": "Café", "monto": 6000, "moneda": "ARS", "categoria": "Alimentación", "metodoPago": null, "tipo": null, "cuotas": null}
"Gasté 15 mil en el super con banco compartido" → {"descripcion": "Supermercado", "monto": 15000, "moneda": "ARS", "categoria": "Alimentación", "metodoPago": "Banco", "tipo": "Compartido", "cuotas": null}
"Zapatillas 90 mil en 3 cuotas" → {"descripcion": "Zapatillas", "monto": 90000, "moneda": "ARS", "categoria": "Ropa y personal", "metodoPago": "Tarjeta", "tipo": null, "cuotas": 3}
"Uber 3500 banco" → {"descripcion": "Uber", "monto": 3500, "moneda": "ARS", "categoria": "Transporte", "metodoPago": "Banco", "tipo": null, "cuotas": null}`,
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
// Recibe la URL temporal de la imagen y la lista de categorías.
async function analyzeReceipt(imageUrl, categoryNames) {
  const client = getClient();
  if (!client) throw new Error('OpenAI no configurado');

  const categoriesList = categoryNames ? categoryNames.join(', ') : 'Alimentación, Transporte, Entretenimiento, Hogar, Salud, Suscripciones, Ropa y personal, Moto, Educación, Ahorro / Inversión, Otros';

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
- "metodoPago": "Banco", "Efectivo", "Tarjeta" o null si no se ve
- "notas": detalles extra relevantes o null

Si no podés leer el recibo o no es una factura, devolvé: {"error": "No pude leer este recibo"}

Ejemplos:
{"descripcion": "Supermercado Coto", "monto": 15000, "categoria": "Alimentación", "metodoPago": "Tarjeta", "notas": null}
{"descripcion": "Farmacia del Pueblo", "monto": 3500, "categoria": "Salud", "metodoPago": null, "notas": "Medicamentos"}`,
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

module.exports = { transcribeAudio, parseExpense, analyzeReceipt, isConfigured };
