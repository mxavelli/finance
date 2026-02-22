# Capa de datos: lectura de Google Sheets con cache.
# Cada función retorna un DataFrame o dict listo para visualizar.

import streamlit as st
import pandas as pd
from datetime import datetime
from .conexion import get_sheet
from .formato import parse_numero


# --- Transacciones ---

@st.cache_data(ttl=300)
def cargar_transacciones():
    """Lee todas las transacciones y retorna un DataFrame."""
    sheet = get_sheet()
    ws = sheet.worksheet('Transacciones')
    # Valores sin formato para evitar problemas de locale
    data = ws.get('A2:P', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return _df_transacciones_vacio()

    rows = []
    for r in data:
        # Google Sheets puede retornar filas más cortas si las últimas celdas están vacías
        while len(r) < 16:
            r.append(None)
        # Fecha viene como número serial de Google Sheets con UNFORMATTED_VALUE
        fecha = _parse_fecha_serial(r[0])
        if fecha is None:
            continue
        rows.append({
            'fecha': fecha,
            'hora': _parse_hora_serial(r[1]),
            'descripcion': r[2] or '',
            'categoria': r[3] or 'Otros',
            'monto': _safe_float(r[4]),
            'moneda': r[5] or 'ARS',
            'metodo_pago': r[6] or '',
            'tipo': r[7] or '',
            'pagado_por': r[8] or '',
            'split_moises': _safe_float(r[9]),
            'split_oriana': _safe_float(r[10]),
            'notas': r[11] or '',
            'mes': _safe_int(r[12]),
            'anio': _safe_int(r[13]),
            'monto_moises': _safe_float(r[14]),
            'monto_oriana': _safe_float(r[15]),
        })

    if not rows:
        return _df_transacciones_vacio()
    return pd.DataFrame(rows)


def _df_transacciones_vacio():
    return pd.DataFrame(columns=[
        'fecha', 'hora', 'descripcion', 'categoria', 'monto', 'moneda',
        'metodo_pago', 'tipo', 'pagado_por', 'split_moises', 'split_oriana',
        'notas', 'mes', 'anio', 'monto_moises', 'monto_oriana',
    ])


def filtrar_mes(df, mes, anio):
    """Filtra un DataFrame de transacciones por mes y año."""
    if df.empty:
        return df
    return df[(df['mes'] == mes) & (df['anio'] == anio)]


# --- Gastos Fijos ---

@st.cache_data(ttl=300)
def cargar_gastos_fijos():
    """Lee gastos fijos y retorna un DataFrame."""
    sheet = get_sheet()
    ws = sheet.worksheet('Gastos Fijos')
    # Usamos FORMATTED_VALUE para la col H (fórmula ✅/❌) y parsear montos manualmente
    data = ws.get('A2:H', value_render_option='FORMATTED_VALUE')
    if not data:
        return pd.DataFrame(columns=['descripcion', 'categoria', 'monto', 'moneda',
                                     'metodo_pago', 'tipo', 'dia', 'registrado'])
    rows = []
    for r in data:
        while len(r) < 8:
            r.append(None)
        if not r[0]:
            continue
        rows.append({
            'descripcion': r[0] or '',
            'categoria': r[1] or '',
            'monto': parse_numero(r[2]),
            'moneda': r[3] or 'ARS',
            'metodo_pago': r[4] or '',
            'tipo': r[5] or '',
            'dia': _safe_int(r[6]),
            'registrado': 'Sí' in str(r[7] or ''),
        })
    return pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=['descripcion', 'categoria', 'monto', 'moneda',
                 'metodo_pago', 'tipo', 'dia', 'registrado'])


# --- Cuotas ---

@st.cache_data(ttl=300)
def cargar_cuotas():
    """Lee cuotas de tarjeta y retorna un DataFrame."""
    sheet = get_sheet()
    ws = sheet.worksheet('Cuotas')
    data = ws.get('A2:M', value_render_option='FORMATTED_VALUE')
    if not data:
        return pd.DataFrame(columns=['descripcion', 'categoria', 'monto_total', 'cuotas',
                                     'monto_cuota', 'moneda', 'tarjeta', 'tipo',
                                     'pagado_por', 'fecha_compra', 'primera_cuota',
                                     'cuotas_reg', 'estado'])
    rows = []
    for r in data:
        while len(r) < 13:
            r.append(None)
        if not r[0]:
            continue
        rows.append({
            'descripcion': r[0] or '',
            'categoria': r[1] or '',
            'monto_total': parse_numero(r[2]),
            'cuotas': _safe_int(r[3]),
            'monto_cuota': parse_numero(r[4]),
            'moneda': r[5] or 'ARS',
            'tarjeta': r[6] or '',
            'tipo': r[7] or '',
            'pagado_por': r[8] or '',
            'fecha_compra': r[9] or '',
            'primera_cuota': r[10] or '',
            'cuotas_reg': _safe_int(r[11]),
            'estado': r[12] or '',
        })
    return pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=['descripcion', 'categoria', 'monto_total', 'cuotas',
                 'monto_cuota', 'moneda', 'tarjeta', 'tipo',
                 'pagado_por', 'fecha_compra', 'primera_cuota',
                 'cuotas_reg', 'estado'])


# --- Balance Compartido ---

@st.cache_data(ttl=300)
def cargar_balance():
    """Lee el balance compartido: 12 meses + total + saldo acumulado."""
    sheet = get_sheet()
    ws = sheet.worksheet('Balance Compartido')
    # Filas 5-16 = 12 meses, fila 17 = total anual, fila 19 = saldo acumulado
    data = ws.get('A5:H19', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return {'meses': [], 'total': None, 'saldo_acumulado': None}

    meses = []
    for i, r in enumerate(data):
        while len(r) < 8:
            r.append(None)
        if i < 12:  # 12 meses
            meses.append({
                'mes': r[0] or '',
                'total_compartido': _safe_float(r[1]),
                'pago_moises': _safe_float(r[2]),
                'pago_oriana': _safe_float(r[3]),
                'corresponde_moises': _safe_float(r[4]),
                'corresponde_oriana': _safe_float(r[5]),
                'balance_moises': _safe_float(r[6]),
                'resultado': r[7] or '',
            })

    # Fila 13 del array (index 12) = total anual
    total = None
    if len(data) > 12:
        r = data[12]
        while len(r) < 8:
            r.append(None)
        total = {
            'total_compartido': _safe_float(r[1]),
            'pago_moises': _safe_float(r[2]),
            'pago_oriana': _safe_float(r[3]),
            'corresponde_moises': _safe_float(r[4]),
            'corresponde_oriana': _safe_float(r[5]),
            'balance_moises': _safe_float(r[6]),
            'resultado': r[7] or '',
        }

    # Fila 15 del array (index 14) = saldo acumulado
    saldo = None
    if len(data) > 14:
        r = data[14]
        while len(r) < 8:
            r.append(None)
        saldo = {
            'balance_moises': _safe_float(r[6]),
            'resultado': r[7] or '',
        }

    return {'meses': meses, 'total': total, 'saldo_acumulado': saldo}


# --- Presupuesto ARS ---

@st.cache_data(ttl=300)
def cargar_presupuesto_ars():
    """Lee presupuesto ARS con 3 secciones: Moises, Oriana, Compartido.

    Layout del sheet (verificado con setup.js):
    - Row 1: Año: 2026
    - Row 3: título Moises, Row 4: headers, Rows 5-15: 11 categorías, Row 16: TOTAL
    - Row 18: título Oriana, Row 19: headers, Rows 20-30: 11 categorías, Row 31: TOTAL
    - Row 33: título Compartido, Row 34: headers, Rows 35-45: 11 categorías, Row 46: TOTAL
    """
    sheet = get_sheet()
    ws = sheet.worksheet('Presupuesto ARS')
    data = ws.get('A1:P46', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return {'moises': _df_presupuesto_vacio(), 'oriana': _df_presupuesto_vacio(),
                'compartido': _df_presupuesto_vacio()}

    # Padding filas
    while len(data) < 46:
        data.append([None] * 16)

    return {
        'moises': _parse_seccion_presupuesto(data, 4, 15),     # rows 5-15 (0-indexed: 4-14)
        'oriana': _parse_seccion_presupuesto(data, 19, 30),     # rows 20-30 (0-indexed: 19-29)
        'compartido': _parse_seccion_presupuesto(data, 34, 45), # rows 35-45 (0-indexed: 34-44)
    }


@st.cache_data(ttl=300)
def cargar_presupuesto_usd():
    """Lee presupuesto USD (1 sección: Moises)."""
    sheet = get_sheet()
    ws = sheet.worksheet('Presupuesto USD')
    data = ws.get('A1:P16', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return _df_presupuesto_vacio()

    while len(data) < 16:
        data.append([None] * 16)

    return _parse_seccion_presupuesto(data, 4, 15)


def _parse_seccion_presupuesto(data, start_idx, end_idx):
    """Parsea una sección de presupuesto (11 categorías)."""
    rows = []
    for i in range(start_idx, min(end_idx, len(data))):
        r = data[i]
        while len(r) < 16:
            r.append(None)
        if not r[0]:
            continue
        row = {
            'categoria': r[0],
            'presupuesto': _safe_float(r[1]),
        }
        # Columnas C-N = meses Ene-Dic (indices 2-13)
        for m in range(12):
            row[f'mes_{m+1}'] = _safe_float(r[2 + m])
        row['total'] = _safe_float(r[14])
        row['porcentaje'] = _safe_float(r[15])
        rows.append(row)
    return pd.DataFrame(rows) if rows else _df_presupuesto_vacio()


def _df_presupuesto_vacio():
    cols = ['categoria', 'presupuesto'] + [f'mes_{m}' for m in range(1, 13)] + ['total', 'porcentaje']
    return pd.DataFrame(columns=cols)


# --- Ingresos ---

@st.cache_data(ttl=300)
def cargar_ingresos_moises():
    """Lee ingresos de Moises: 12 meses con salario, deel, transferido, tc, recibido."""
    sheet = get_sheet()
    ws = sheet.worksheet('Ingresos')
    # Rows 3-14 = Ene-Dic, Row 15 = TOTAL
    data = ws.get('A3:F15', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return pd.DataFrame(columns=['mes', 'salario_usd', 'queda_deel', 'transferido',
                                     'tc', 'recibido_ars'])
    rows = []
    for r in data[:12]:  # Solo los 12 meses, no el total
        while len(r) < 6:
            r.append(None)
        rows.append({
            'mes': r[0] or '',
            'salario_usd': _safe_float(r[1]),
            'queda_deel': _safe_float(r[2]),
            'transferido': _safe_float(r[3]),
            'tc': _safe_float(r[4]),
            'recibido_ars': _safe_float(r[5]),
        })
    return pd.DataFrame(rows)


@st.cache_data(ttl=300)
def cargar_ingresos_oriana():
    """Lee ingresos de Oriana: 12 meses."""
    sheet = get_sheet()
    ws = sheet.worksheet('Ingresos')
    # Rows 19-30 = Ene-Dic, Row 31 = TOTAL
    data = ws.get('A19:F30', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return pd.DataFrame(columns=['mes', 'ingreso_ars', 'fuente'])
    rows = []
    for r in data[:12]:
        while len(r) < 6:
            r.append(None)
        rows.append({
            'mes': r[0] or '',
            'ingreso_ars': _safe_float(r[1]),
            'fuente': r[2] or '',
        })
    return pd.DataFrame(rows)


# --- Crypto ---

@st.cache_data(ttl=300)
def cargar_crypto_holdings():
    """Lee holdings crypto y retorna un DataFrame."""
    sheet = get_sheet()
    ws = sheet.worksheet('Crypto')
    data = ws.get('A4:F20', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return pd.DataFrame(columns=['nombre', 'simbolo', 'cantidad', 'precio_usd', 'valor_usd', 'plataforma'])
    rows = []
    for r in data:
        while len(r) < 6:
            r.append(None)
        if not r[0]:
            continue
        rows.append({
            'nombre': r[0] or '',
            'simbolo': r[1] or '',
            'cantidad': _safe_float(r[2]),
            'precio_usd': _safe_float(r[3]),
            'valor_usd': _safe_float(r[4]),
            'plataforma': r[5] or '',
        })
    return pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=['nombre', 'simbolo', 'cantidad', 'precio_usd', 'valor_usd', 'plataforma'])


@st.cache_data(ttl=300)
def cargar_crypto_transacciones():
    """Lee historial de movimientos crypto."""
    sheet = get_sheet()
    ws = sheet.worksheet('Crypto')
    data = ws.get('A26:I', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return pd.DataFrame(columns=['fecha', 'hora', 'tipo', 'crypto', 'cantidad',
                                     'precio_usd', 'total_usd', 'plataforma', 'notas'])
    rows = []
    for r in data:
        while len(r) < 9:
            r.append(None)
        fecha = _parse_fecha_serial(r[0])
        if fecha is None:
            continue
        rows.append({
            'fecha': fecha,
            'hora': _parse_hora_serial(r[1]),
            'tipo': r[2] or '',
            'crypto': r[3] or '',
            'cantidad': _safe_float(r[4]),
            'precio_usd': _safe_float(r[5]),
            'total_usd': _safe_float(r[6]),
            'plataforma': r[7] or '',
            'notas': r[8] or '',
        })
    return pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=['fecha', 'hora', 'tipo', 'crypto', 'cantidad',
                 'precio_usd', 'total_usd', 'plataforma', 'notas'])


# --- Helpers internos ---

def _safe_float(val):
    """Convierte a float de forma segura."""
    if val is None or val == '':
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return parse_numero(val)


def _safe_int(val):
    """Convierte a int de forma segura."""
    if val is None or val == '':
        return 0
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return 0


def _parse_fecha_serial(val):
    """Convierte un serial date de Google Sheets a datetime, o parsea string DD/MM/YYYY."""
    if val is None or val == '':
        return None
    if isinstance(val, (int, float)) and val > 0:
        # Google Sheets serial date: días desde 30/12/1899
        try:
            return datetime(1899, 12, 30) + pd.Timedelta(days=int(val))
        except Exception:
            return None
    if isinstance(val, str):
        # Intentar DD/MM/YYYY
        try:
            return datetime.strptime(val, '%d/%m/%Y')
        except ValueError:
            return None
    return None


def _parse_hora_serial(val):
    """Convierte un serial time de Google Sheets a string HH:MM."""
    if val is None or val == '':
        return ''
    if isinstance(val, (int, float)):
        # Fracción del día → horas:minutos
        total_mins = round(val * 24 * 60)
        h = total_mins // 60
        m = total_mins % 60
        return f'{h:02d}:{m:02d}'
    return str(val)


# --- Inversiones ---

@st.cache_data(ttl=300)
def cargar_inversiones():
    """Lee portafolio de inversiones y retorna dict { tipos: DataFrame, total: float }."""
    sheet = get_sheet()
    ws = sheet.worksheet('Inversiones')
    data = ws.get('A4:D10', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return {'tipos': pd.DataFrame(columns=['tipo', 'porcentaje', 'valor_ars', 'plataforma']), 'total': 0.0}
    tipos = []
    total = 0.0
    for i, r in enumerate(data):
        while len(r) < 4:
            r.append(None)
        if i == len(data) - 1 and str(r[0] or '').upper() == 'TOTAL':
            total = _safe_float(r[2])
            continue
        if not r[0]:
            continue
        tipos.append({
            'tipo': r[0] or '',
            'porcentaje': _safe_float(r[1]),
            'valor_ars': _safe_float(r[2]),
            'plataforma': r[3] or '',
        })
    df = pd.DataFrame(tipos) if tipos else pd.DataFrame(columns=['tipo', 'porcentaje', 'valor_ars', 'plataforma'])
    return {'tipos': df, 'total': total}


@st.cache_data(ttl=300)
def cargar_inversiones_historial():
    """Lee historial de valor de inversiones."""
    sheet = get_sheet()
    ws = sheet.worksheet('Inversiones')
    data = ws.get('A14:D', value_render_option='UNFORMATTED_VALUE')
    if not data:
        return pd.DataFrame(columns=['fecha', 'valor_total', 'variacion', 'notas'])
    rows = []
    for r in data:
        while len(r) < 4:
            r.append(None)
        fecha = _parse_fecha_serial(r[0])
        if fecha is None:
            continue
        rows.append({
            'fecha': fecha,
            'valor_total': _safe_float(r[1]),
            'variacion': _safe_float(r[2]),
            'notas': r[3] or '',
        })
    return pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=['fecha', 'valor_total', 'variacion', 'notas'])
