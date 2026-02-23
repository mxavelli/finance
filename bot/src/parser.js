// Parser de lenguaje natural para transacciones financieras.
// Funcion pura: recibe texto y contexto, devuelve objeto transaccion o null.

// Quita acentos para comparacion flexible ("cafe" matchea "café").
function normalize(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Formatea monto en formato argentino para el preview.
function formatAmount(monto, moneda) {
  const formatted = monto.toLocaleString('es-AR', { maximumFractionDigits: 2 });
  return moneda === 'USD' ? `US$${formatted}` : `$${formatted}`;
}

// Fecha y hora actual en timezone Buenos Aires.
function getNow() {
  const now = new Date();
  const options = { timeZone: 'America/Argentina/Buenos_Aires' };

  const fecha = now.toLocaleDateString('es-AR', {
    ...options, day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const hora = now.toLocaleTimeString('es-AR', {
    ...options, hour: '2-digit', minute: '2-digit', hour12: false,
  });

  return { fecha, hora };
}

// Parsea un monto de texto a numero.
// Soporta: "3500", "15.000" (punto = miles), "1500,50" (coma = decimal), "$6.000".
function parseAmount(token) {
  // Quitar simbolos de moneda: $, US$, ARS, USD
  const clean = token.replace(/^(?:us\$|\$|ars|usd)\s*/i, '');
  if (!clean) return null;

  // Punto como separador de miles: "15.000", "1.500.000"
  if (/^\d{1,3}(\.\d{3})+$/.test(clean)) {
    return parseFloat(clean.replace(/\./g, ''));
  }
  // Coma como decimal: "1500,50"
  if (/^\d+,\d+$/.test(clean)) {
    return parseFloat(clean.replace(',', '.'));
  }
  // Numero simple: "3500"
  if (/^\d+$/.test(clean)) {
    return parseFloat(clean);
  }
  return null;
}

// Limpia texto transcrito de audio: quita palabras de relleno comunes en habla natural.
// "compré un café en la tienda por 6000" → "café tienda 6000"
const FILLER_WORDS = new Set([
  'compre', 'compré', 'gaste', 'gasté', 'pague', 'pagué', 'fue', 'eran', 'era',
  'un', 'una', 'uno', 'unos', 'unas', 'el', 'la', 'los', 'las',
  'en', 'por', 'de', 'del', 'al', 'con', 'para', 'que', 'me', 'se', 'le',
  'hoy', 'ayer', 'recien', 'recién', 'algo', 'como', 'asi', 'más', 'mas',
  'y', 'o', 'a', 'mi', 'su', 'nos',
  'pesos', 'peso',
]);

function cleanTranscription(text) {
  const tokens = text.split(/\s+/);
  const cleaned = tokens.filter(t => !FILLER_WORDS.has(normalize(t)));
  return cleaned.join(' ');
}

// Convierte numeros en palabras (español) a digitos.
// "tres mil quinientos" → "3500", "quince mil" → "15000".
// Los tokens que ya son numeros pasan sin cambio.
function wordsToNumber(text) {
  const UNITS = {
    cero: 0, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
    trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
    dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
    veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
    veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  };
  const TENS = {
    treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
    setenta: 70, ochenta: 80, noventa: 90,
  };
  const HUNDREDS = {
    cien: 100, ciento: 100, doscientos: 200, doscientas: 200,
    trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
    quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
    setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
    novecientos: 900, novecientas: 900,
  };

  const normalized = normalize(text);
  const tokens = normalized.split(/\s+/);
  const result = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    // Si es un numero o formato numerico, dejarlo tal cual (usar token original)
    if (/^\d/.test(tokens[i]) || /^\d{1,3}(\.\d{3})+$/.test(tokens[i])) {
      result.push(text.split(/\s+/)[i]);
      i++;
      continue;
    }

    // Intentar parsear secuencia de palabras como numero
    let num = null;
    let consumed = 0;

    // Acumular valor del numero
    let total = 0;
    let current = 0;
    let foundNumber = false;
    let j = i;

    while (j < tokens.length) {
      const word = tokens[j];

      if (UNITS[word] !== undefined) {
        current += UNITS[word];
        foundNumber = true;
        j++;
      } else if (TENS[word] !== undefined) {
        current += TENS[word];
        foundNumber = true;
        j++;
        // "treinta y cinco" → 35
        if (j < tokens.length && tokens[j] === 'y' && j + 1 < tokens.length && UNITS[tokens[j + 1]] !== undefined) {
          current += UNITS[tokens[j + 1]];
          j += 2;
        }
      } else if (HUNDREDS[word] !== undefined) {
        current += HUNDREDS[word];
        foundNumber = true;
        j++;
      } else if (word === 'mil' && foundNumber) {
        // "tres mil", "quinientos mil"
        current = (current || 1) * 1000;
        total += current;
        current = 0;
        foundNumber = true;
        j++;
      } else if (word === 'mil' && !foundNumber) {
        // "mil" solo = 1000
        total += 1000;
        foundNumber = true;
        j++;
      } else {
        break;
      }
    }

    if (foundNumber) {
      num = total + current;
      consumed = j - i;
    }

    if (num !== null && consumed > 0) {
      result.push(String(num));
      i += consumed;
    } else {
      // No es numero, mantener token original
      result.push(text.split(/\s+/)[i]);
      i++;
    }
  }

  return result.join(' ');
}

// Frases multi-palabra de metodo de pago (se buscan primero, antes de tokenizar).
const PAYMENT_PHRASES = [
  { phrase: 'tarjeta de credito', metodoPago: 'Tarjeta', moneda: 'ARS' },
  { phrase: 'tarjeta de crédito', metodoPago: 'Tarjeta', moneda: 'ARS' },
  { phrase: 'deel usd', metodoPago: 'Deel USD', moneda: 'USD' },
  { phrase: 'deel card', metodoPago: 'Deel Card', moneda: 'ARS' },
];

// Keywords de metodos de pago (single-word).
const PAYMENT_KEYWORDS = {
  usd: { metodoPago: 'Deel USD', moneda: 'USD' },
  efectivo: { metodoPago: 'Efectivo', moneda: 'ARS' },
  banco: { metodoPago: 'Banco', moneda: 'ARS' },
  deel: { metodoPago: 'Deel Card', moneda: 'ARS' },
  tarjeta: { metodoPago: 'Tarjeta', moneda: 'ARS' },
};

// Orden de prioridad para deteccion de metodo de pago (single-word).
const PAYMENT_PRIORITY = ['usd', 'efectivo', 'banco', 'deel', 'tarjeta'];

// Parsea un mensaje de texto en un objeto transaccion.
// Retorna null si no encuentra un monto valido.
function parseTransaction(text, senderId, categories, config) {
  const lowered = text.toLowerCase().trim();
  const normalizedFull = normalize(text);
  let tokens = lowered.split(/\s+/);

  // 1. Extraer monto
  let monto = null;
  let montoIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseAmount(tokens[i]);
    if (parsed !== null && parsed > 0) {
      monto = parsed;
      montoIndex = i;
      break;
    }
  }
  if (monto === null) return null;
  tokens.splice(montoIndex, 1);

  // 2. Detectar cuotas: "3 cuotas", "en 3 cuotas", "6 cuota"
  let cuotas = null;
  const joinedForCuotas = tokens.join(' ');
  const cuotasMatch = joinedForCuotas.match(/(?:en\s+)?(\d+)\s*cuotas?/i);
  if (cuotasMatch) {
    const n = parseInt(cuotasMatch[1]);
    if (n >= 2 && n <= 48) {
      cuotas = n;
      // Remover tokens de cuotas del array
      const cuotasTokens = cuotasMatch[0].toLowerCase().split(/\s+/);
      for (const ct of cuotasTokens) {
        const idx = tokens.indexOf(ct);
        if (idx !== -1) tokens.splice(idx, 1);
      }
    }
  }

  // 3. Detectar metodo de pago
  let metodoPago = 'Tarjeta';
  let moneda = 'ARS';
  let paymentFound = false;

  // Primero buscar frases multi-palabra ("tarjeta de credito", "deel usd", etc.)
  const joined = tokens.join(' ');
  for (const { phrase, metodoPago: mp, moneda: mon } of PAYMENT_PHRASES) {
    const normalizedPhrase = normalize(phrase);
    if (normalize(joined).includes(normalizedPhrase)) {
      metodoPago = mp;
      moneda = mon;
      paymentFound = true;
      // Remover todos los tokens de la frase
      const phraseWords = phrase.toLowerCase().split(' ');
      for (const word of phraseWords) {
        const idx = tokens.indexOf(word);
        if (idx !== -1) tokens.splice(idx, 1);
      }
      // Tambien remover version sin acento
      const phraseWordsNorm = normalizedPhrase.split(' ');
      for (const word of phraseWordsNorm) {
        const idx = tokens.findIndex(t => normalize(t) === word);
        if (idx !== -1) tokens.splice(idx, 1);
      }
      break;
    }
  }

  // Si no matcheo frase, buscar keyword single-word
  if (!paymentFound) {
    for (const keyword of PAYMENT_PRIORITY) {
      const idx = tokens.indexOf(keyword);
      if (idx !== -1) {
        metodoPago = PAYMENT_KEYWORDS[keyword].metodoPago;
        moneda = PAYMENT_KEYWORDS[keyword].moneda;
        tokens.splice(idx, 1);
        // "deel" + "usd" separados = Deel USD
        if (keyword === 'usd') {
          const deelIdx = tokens.indexOf('deel');
          if (deelIdx !== -1) tokens.splice(deelIdx, 1);
        }
        break;
      }
    }
  }

  // Si hay cuotas, forzar metodo Tarjeta (cuotas solo aplican a tarjetas de credito)
  if (cuotas) {
    metodoPago = 'Tarjeta';
    moneda = 'ARS';
  }

  // 4. Detectar tipo (compartido / individual)
  let tipo;
  const compIdx = tokens.findIndex(t => t === 'compartido' || t === 'compartida');
  if (compIdx !== -1) {
    tipo = 'Compartido';
    tokens.splice(compIdx, 1);
  } else if (senderId === config.moisesId) {
    tipo = 'Individual Moises';
  } else if (senderId === config.orianaId) {
    tipo = 'Individual Oriana';
  } else {
    tipo = 'Individual Moises';
  }

  // 5. Detectar categoria por keywords
  let categoria = 'Otros';
  const normalizedTokens = tokens.map(normalize);

  // Primero buscar keywords multi-palabra (ej: "seguro moto")
  for (const cat of categories) {
    const multiWordKeywords = cat.keywords.filter(k => k.includes(' '));
    for (const kw of multiWordKeywords) {
      if (normalizedFull.includes(normalize(kw))) {
        categoria = cat.name;
        break;
      }
    }
    if (categoria !== 'Otros') break;
  }

  // Si no matcheo multi-palabra, buscar single-word
  if (categoria === 'Otros') {
    for (const cat of categories) {
      const singleWordKeywords = cat.keywords.filter(k => !k.includes(' '));
      for (const kw of singleWordKeywords) {
        const normalizedKw = normalize(kw);
        if (normalizedTokens.some(t => t === normalizedKw || t.startsWith(normalizedKw))) {
          categoria = cat.name;
          break;
        }
      }
      if (categoria !== 'Otros') break;
    }
  }

  // 6. Armar descripcion con tokens restantes
  let descripcion = tokens.join(' ').trim();
  if (descripcion) {
    descripcion = descripcion.charAt(0).toUpperCase() + descripcion.slice(1);
  } else {
    descripcion = categoria;
  }

  // 7. Splits y pagado por
  const pagadoPor = senderId === config.orianaId ? 'Oriana' : 'Moises';
  let splitMoises, splitOriana;
  if (tipo === 'Compartido') {
    splitMoises = 50;
    splitOriana = 50;
  } else if (tipo === 'Individual Oriana') {
    splitMoises = 0;
    splitOriana = 100;
  } else {
    splitMoises = 100;
    splitOriana = 0;
  }

  // 8. Fecha y hora
  const { fecha, hora } = getNow();

  return {
    fecha,
    hora,
    descripcion,
    categoria,
    monto,
    moneda,
    metodoPago,
    tipo,
    pagadoPor,
    splitMoises,
    splitOriana,
    notas: '',
    cuotas,
  };
}

module.exports = { parseTransaction, formatAmount, wordsToNumber, cleanTranscription };
