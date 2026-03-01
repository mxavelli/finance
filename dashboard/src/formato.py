# Helpers de formato: moneda argentina, fechas, locale.

MESES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']


def formato_ars(monto):
    """Formatea un monto en pesos argentinos: $1.234.567,00"""
    if monto is None or monto == 0:
        return '$0,00'
    # {:,.2f} produce "1,234,567.89" (US) → swap a "1.234.567,89" (AR)
    us = '{:,.2f}'.format(monto)
    ar = us.replace(',', 'X').replace('.', ',').replace('X', '.')
    return f'${ar}'


def formato_usd(monto):
    """Formatea un monto en dólares: USD 1,234.00"""
    if monto is None or monto == 0:
        return 'USD 0.00'
    return 'USD {:,.2f}'.format(monto)


def formato_moneda(monto, moneda):
    """Formatea según la moneda."""
    if moneda == 'USD':
        return formato_usd(monto)
    return formato_ars(monto)


def nombre_mes(num):
    """Retorna nombre del mes en español (1-indexed)."""
    if 1 <= num <= 12:
        return MESES[num - 1]
    return str(num)


def nombre_mes_corto(num):
    """Retorna nombre corto del mes (1-indexed)."""
    if 1 <= num <= 12:
        return MESES_CORTOS[num - 1]
    return str(num)


def parse_numero(val):
    """Parsea números con formato argentino (punto=miles, coma=decimal).

    Replica la lógica de parseLocalNumber() de sheets.js.
    """
    if val is None:
        return 0
    if isinstance(val, (int, float)):
        return float(val)
    import re
    s = re.sub(r'[^0-9.,\-]', '', str(val)).strip()
    if not s:
        return 0
    # 15.000 o 15.000,50 → punto como miles
    if re.match(r'^\d{1,3}(\.\d{3})+(,\d+)?$', s):
        return float(s.replace('.', '').replace(',', '.')) or 0
    # 1500,50 → coma como decimal
    if re.match(r'^\d+,\d+$', s):
        return float(s.replace(',', '.')) or 0
    try:
        return float(s) or 0
    except ValueError:
        return 0
