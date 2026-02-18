# Guia de uso — PlataBot

> Guia practica para Moises y Oriana. Todo se hace desde Telegram.

---

## Registrar un gasto

Enviale un mensaje de texto al bot con el gasto. No hace falta formato especifico.

**Ejemplos:**

| Mensaje | Que registra |
|---------|-------------|
| `uber 3500` | Transporte, $3.500 ARS, [elige tarjeta], Individual |
| `super 15000 compartido` | Alimentacion, $15.000 ARS, [elige tarjeta], Compartido 50/50 |
| `100 usd ahorro` | Ahorro, US$100, Deel USD, Individual |
| `alquiler 150000 banco compartido` | Hogar, $150.000 ARS, Banco, Compartido |
| `netflix 2500` | Suscripciones, $2.500 ARS, [elige tarjeta], Individual |
| `cafe 3000 efectivo` | Alimentacion, $3.000 ARS, Efectivo, Individual |
| `cena 25000 deel compartido` | Alimentacion, $25.000 ARS, Deel Card, Compartido |

### Como funciona

1. Escribis el mensaje
2. El bot muestra un preview con todos los datos
3. Si el metodo es tarjeta de credito, te muestra botones con tus tarjetas (ej: Visa Galicia, Master Galicia). Tocas cual usaste y se confirma.
4. Si es otro metodo (efectivo, banco, deel), tocas **Confirmar** o **Cancelar**
5. Se guarda en el Google Sheet con la tarjeta especifica

### Palabras clave para metodo de pago

- Sin especificar → **Tarjeta** (default, te pregunta cual)
- `efectivo` → Efectivo
- `banco` → Banco (transferencia)
- `deel` → Deel Card (ARS)
- `usd` → Deel USD

### Tipo de gasto

- Sin especificar → **Individual** (de quien envia)
- `compartido` → Compartido 50/50

---

## Comandos disponibles

### /balance

Muestra el balance compartido del mes: quien pago mas, cuanto le corresponde a cada uno, y si alguien le debe al otro.

```
/balance
```

### /resumen

Resumen de gastos del mes actual o de un mes especifico. Muestra total, desglose por categoria y por tipo.

```
/resumen              → mes actual
/resumen febrero      → febrero
/resumen 3            → marzo
```

### /flujo

Flujo financiero del mes: cuanto ingreso, cuanto gaste, cuanto me sobro. Muestra ARS y USD por separado.

```
/flujo                → mes actual
/flujo febrero        → febrero
```

Muestra:
- Ingresos ARS de cada uno (lo que recibieron en pesos)
- Gastos ARS totales (con desglose de tarjeta)
- Sobrante ARS (ingresos - gastos)
- Salario total USD, transferido a ARS, gastado en USD, lo que queda en Deel

### /tarjeta

Resumen de gastos pagados con tarjeta de credito. Util para saber cuanto va a venir en el resumen de cada tarjeta.

```
/tarjeta              → mes actual
/tarjeta enero        → enero
```

Muestra: total, desglose por tarjeta (Visa Galicia, Master Galicia, etc.), desglose por categoria, y listado detallado con nombre de tarjeta.

**Tarjetas configuradas:**
- Moises: Visa Galicia, Master Galicia
- Oriana: Visa BBVA, Master BBVA

### /gastosfijos

Estado de los gastos fijos del mes. Muestra cuales ya estan registrados y cuales faltan.

```
/gastosfijos
```

### /registrar_fijos

Registra los gastos fijos que te faltan en el mes. Permite editar montos antes de registrar (util cuando cambian por inflacion u otro motivo).

```
/registrar_fijos
```

**Cada persona ve solo lo suyo:** Moises ve sus gastos individuales + los compartidos, Oriana los suyos + compartidos.

**Recordatorio automatico:** al iniciar el bot, si hay gastos fijos pendientes, les llega un mensaje a cada uno con su lista y botones para registrar. No hace falta acordarse del comando.

**Proteccion anti-duplicados:** si ambos reciben la lista y uno registra primero (incluyendo compartidos), cuando el otro confirma el bot re-lee el Sheet y no duplica los que ya estan.

**Flujo:**
1. Muestra lista de gastos fijos pendientes (filtrada por usuario)
2. Opciones:
   - **Registrar todos** — crea las transacciones de una (re-verifica cuales siguen pendientes)
   - **Editar monto** — elegi cual editar → escribi el nuevo monto → se actualiza para este mes y futuros
   - **Ahora no** — no hace nada

### /cuotas

Ver estado de compras en cuotas. Muestra cuotas activas (cuantas van, cuantas faltan), completadas, y el total mensual.

```
/cuotas
```

### /ultimas

Muestra las ultimas transacciones registradas.

```
/ultimas              → ultimas 5
/ultimas 3            → ultimas 3
/ultimas 10           → ultimas 10 (maximo)
```

### /borrar

Permite borrar una transaccion de las ultimas 5.

```
/borrar
```

**Flujo:**
1. Muestra las ultimas 5 transacciones numeradas
2. Elegis cual borrar tocando el numero
3. Confirmas o cancelas

### /cotizacion

Registra los ingresos del mes para ambos. Calcula automaticamente cuantos USD cambiar segun el tipo de cambio del dia.

```
/cotizacion 1350      → tipo de cambio = $1.350
```

**Que calcula:**
- Para cada uno: USD exacto a cambiar (salario ARS / TC), redondeado al multiplo de 50 mas cercano hacia arriba
- Cuanto queda en Deel (ahorro en USD)
- Extra USD (la diferencia del redondeo, se registra como gasto compartido)

**Si ya registraste la cotizacion del mes**, te avisa y te da opcion de actualizar. La actualizacion reescribe todo, incluyendo el extra anterior.

### /ingreso

Registra un ingreso extra (bonus, freelance, etc.). Se suma al ingreso del mes actual.

```
/ingreso 500 bonus
/ingreso 50000 freelance
```

- Si lo envia Moises → se registra en USD
- Si lo envia Oriana → se registra en ARS

### /ping

Verifica que el bot esta conectado a Google Sheets y muestra las categorias disponibles.

```
/ping
```

---

## Categorias

El bot detecta la categoria automaticamente por palabras clave:

| Categoria | Palabras clave |
|-----------|---------------|
| Alimentacion | super, supermercado, comida, cena, almuerzo, delivery, restaurante, cafe, bar, rappi, pedidosya |
| Transporte | uber, cabify, taxi, nafta, peaje, subte, colectivo |
| Entretenimiento | cine, teatro, salida, gaming, streaming |
| Hogar | alquiler, expensas, luz, gas, agua, internet, wifi |
| Salud | farmacia, medico, prepaga, medicamento |
| Suscripciones | spotify, netflix, youtube, hbo, disney, chatgpt, icloud |
| Ropa y personal | ropa, zapatillas, perfume, peluqueria |
| Moto | seguro moto, patente moto, mecanico moto, casco |
| Educacion | curso, libro, udemy, platzi |
| Ahorro / Inversion | ahorro, inversion, plazo fijo, crypto |
| Otros | si no matchea con nada |

Si la categoria se detecta mal, pueden corregirla directamente en el Google Sheet.

---

## Compras en cuotas

Para registrar una compra en cuotas, agrega "N cuotas" al mensaje:

| Mensaje | Que registra |
|---------|-------------|
| `zapatillas 90000 3 cuotas` | 3 cuotas de $30.000, [elige tarjeta] |
| `heladera 500000 en 12 cuotas compartido` | 12 cuotas de $41.667, Compartido 50/50 |

### Como funciona

1. Escribis el gasto con "N cuotas"
2. El bot muestra preview con el desglose de cuotas
3. Elegis la tarjeta
4. Se calcula automaticamente cuando es la primera cuota (segun el cierre de tu tarjeta)
5. Se guarda en la hoja Cuotas
6. Opcion de ajustar el monto por cuota (para cuotas con interes)

### Registro mensual

Las cuotas pendientes aparecen junto con los gastos fijos cuando usas `/registrar_fijos` o cuando el bot te envia el recordatorio al iniciar. Al "Registrar todos", se crean las transacciones del mes para gastos fijos y cuotas.

### Ver estado de cuotas

```
/cuotas
```

Muestra todas las cuotas activas (cuantas van, cuantas faltan), completadas, y el total mensual en cuotas.

---

## Recordatorio de ingresos

Cada vez que se inicia el bot, si todavia no se registraron los ingresos del mes, envia un mensaje a ambos recordando usar `/cotizacion`.

---

## Google Sheet

El bot escribe en un Google Sheet que tiene estas hojas:

| Hoja | Que contiene |
|------|-------------|
| **Transacciones** | Todas las transacciones registradas |
| **Dashboard** | Resumen visual: gastos, flujo financiero, resumen anual |
| **Presupuesto ARS** | Presupuestos mensuales en pesos |
| **Presupuesto USD** | Presupuesto mensual en dolares |
| **Balance Compartido** | Quien pago que, quien le debe a quien |
| **Gastos Fijos** | Lista de gastos recurrentes con estado |
| **Ingresos** | Salarios, distribucion Deel, cotizacion |
| **Categorias** | Lista de categorias y keywords |
| **Cuotas** | Compras en cuotas: monto, tarjeta, estado, cuotas registradas |

### Dashboard

El Dashboard tiene selectores de mes y año. Cambiando esos valores ven:
- Resumen del mes (total ARS/USD, cantidad de transacciones)
- Gasto por persona (Moises, Oriana, Compartido)
- Gasto por metodo de pago (desglosado por tarjeta: Visa Galicia, Master Galicia, Visa BBVA, Master BBVA + total tarjetas)
- Balance compartido (quien debe a quien)
- Flujo del mes (ingresos vs gastos vs sobrante, ARS y USD)
- Resumen anual (tabla de 12 meses con ingresado, gastado, sobrante)

### Tips

- Los presupuestos se llenan manualmente en el Sheet (columna B de cada seccion)
- La columna "Registrado este mes?" de Gastos Fijos se actualiza automaticamente
- Si algo queda mal registrado, pueden editarlo directo en el Sheet o usar `/borrar`

---

## Configuracion inicial

Esto ya esta hecho, pero queda documentado por si hay que reconfigurarlo.

### Variables de entorno necesarias

| Variable | Donde conseguirla |
|----------|------------------|
| `BOT_TOKEN` | @BotFather en Telegram |
| `GOOGLE_SHEET_ID` | URL del Sheet: `docs.google.com/spreadsheets/d/{ESTE_ID}/edit` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Cloud Console → Service Accounts |
| `GOOGLE_PRIVATE_KEY` | JSON descargado del Service Account |
| `MOISES_TELEGRAM_ID` | Enviar mensaje a @userinfobot |
| `ORIANA_TELEGRAM_ID` | Enviar mensaje a @userinfobot |

### Variables opcionales (para /cotizacion)

| Variable | Que es |
|----------|--------|
| `MOISES_SALARY_USD` | Salario total USD mensual de Moises |
| `MOISES_SALARY_ARS` | Cuanto necesita en ARS por mes |
| `ORIANA_SALARY_USD` | Salario total USD mensual de Oriana |
| `ORIANA_SALARY_ARS` | Cuanto necesita en ARS por mes |

### Como iniciar el bot

```bash
cd bot
npm install
npm start
```

El bot queda corriendo. Para detenerlo: `Ctrl+C`.
