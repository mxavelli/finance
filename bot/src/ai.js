// Módulo de inteligencia artificial para transcripción de audio y análisis de recibos.
// Usa OpenAI: Whisper para audio, GPT-4o-mini para imágenes.

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

  // Whisper espera un File-like object con nombre
  const file = new File([fileBuffer], 'audio.ogg', { type: 'audio/ogg' });

  const response = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    language: 'es',
  });

  return response.text;
}

// Analiza una imagen de recibo/factura y extrae datos estructurados.
// Recibe la URL temporal de la imagen (link de Telegram).
async function analyzeReceipt(imageUrl) {
  const client = getClient();
  if (!client) throw new Error('OpenAI no configurado');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Sos un asistente que extrae datos de recibos y facturas argentinas.
Devolvé SOLO un JSON válido con estos campos:
- "descripcion": nombre del comercio o concepto (texto corto)
- "monto": monto total como número (sin símbolos, sin puntos de miles)
- "metodoPago": "Banco", "Efectivo", "Tarjeta" o null si no se ve
- "notas": detalles extra relevantes o null

Si no podés leer el recibo o no es una factura, devolvé: {"error": "No pude leer este recibo"}

Ejemplos de respuesta:
{"descripcion": "Supermercado Coto", "monto": 15000, "metodoPago": "Tarjeta", "notas": null}
{"descripcion": "Farmacia del Pueblo", "monto": 3500, "metodoPago": null, "notas": "Medicamentos"}`,
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

  // Parsear JSON de la respuesta (puede venir envuelto en ```json ... ```)
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

module.exports = { transcribeAudio, analyzeReceipt, isConfigured };
