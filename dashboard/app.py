# Dashboard de Finanzas Personales — Moises & Oriana
# Streamlit app con visualización de datos desde Google Sheets.

import streamlit as st
import datetime
import pandas as pd

# Configuración de página (DEBE ser lo primero)
st.set_page_config(
    page_title='Finanzas M&O',
    page_icon='\U0001f4b0',
    layout='centered',
    initial_sidebar_state='collapsed',
)

# Inicializar dark mode en session_state
if 'dark_mode' not in st.session_state:
    st.session_state.dark_mode = False

dark = st.session_state.dark_mode

# CSS dinámico según modo
if dark:
    st.markdown("""<style>
        .block-container { padding-top: 1rem; padding-bottom: 1rem; }
        /* Fondo general */
        .stApp, [data-testid="stAppViewContainer"], .main {
            background-color: #1C1C24 !important; color: #E0E3EB !important;
        }
        [data-testid="stSidebar"], [data-testid="stSidebar"] > div {
            background-color: #262630 !important; color: #E0E3EB !important;
        }
        [data-testid="stHeader"] { background-color: #1C1C24 !important; }
        /* Métricas */
        [data-testid="stMetric"] {
            background: #2E2E38 !important; padding: 12px; border-radius: 12px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            border-left: 4px solid #9966D9;
        }
        [data-testid="stMetric"] label { font-size: 0.8rem; color: #A0A4B8 !important; }
        [data-testid="stMetric"] [data-testid="stMetricValue"] { color: #E0E3EB !important; }
        [data-testid="stMetric"] [data-testid="stMetricDelta"] { opacity: 0.85; }
        /* Textos y headers */
        h1, h2, h3, h4, h5, h6, .stMarkdown, p, span, label, .stRadio label,
        .stSelectbox label, [data-testid="stWidgetLabel"] {
            color: #E0E3EB !important;
        }
        /* Expanders, tabs, dividers */
        [data-testid="stExpander"] { background-color: #2E2E38 !important; border-color: #3A3A48 !important; }
        [data-testid="stExpander"] summary { color: #E0E3EB !important; }
        hr { border-color: #3A3A48 !important; }
        /* Inputs */
        .stSelectbox > div > div, .stNumberInput > div > div > input {
            background-color: #2E2E38 !important; color: #E0E3EB !important;
            border-color: #3A3A48 !important;
        }
        /* Botones */
        .stButton > button {
            background-color: #2E2E38 !important; color: #E0E3EB !important;
            border-color: #3A3A48 !important;
        }
        .stButton > button:hover { background-color: #3A3A48 !important; }
        /* Progress bars */
        .stProgress > div > div { height: 8px; }
        .stProgress > div { background-color: #3A3A48 !important; }
        /* Info/warning boxes */
        [data-testid="stAlert"] { background-color: #2E2E38 !important; color: #E0E3EB !important; }
        [data-testid="stSidebar"] { min-width: 260px; }
        /* Radio buttons */
        .stRadio > div { color: #E0E3EB !important; }
        /* Tabs */
        .stTabs [data-baseweb="tab-list"] { background-color: #2E2E38 !important; }
        .stTabs [data-baseweb="tab"] { color: #A0A4B8 !important; }
        .stTabs [aria-selected="true"] { color: #E0E3EB !important; }
        /* Scrollbar */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #1C1C24; }
        ::-webkit-scrollbar-thumb { background: #3A3A48; border-radius: 4px; }
    </style>""", unsafe_allow_html=True)
else:
    st.markdown("""<style>
        .block-container { padding-top: 1rem; padding-bottom: 1rem; }
        [data-testid="stMetric"] {
            background: #f3f0ff; padding: 12px; border-radius: 12px;
            box-shadow: 0 2px 6px rgba(126,184,218,0.15);
            border-left: 4px solid #c3aed6;
        }
        [data-testid="stMetric"] label { font-size: 0.8rem; }
        [data-testid="stSidebar"] { min-width: 260px; }
        .stProgress > div > div { height: 8px; }
    </style>""", unsafe_allow_html=True)

from src.datos import (
    cargar_transacciones, filtrar_mes, cargar_gastos_fijos, cargar_cuotas,
    cargar_balance, cargar_presupuesto_ars, cargar_presupuesto_usd,
    cargar_ingresos_moises, cargar_ingresos_oriana,
    cargar_crypto_holdings, cargar_crypto_transacciones,
)
from src.formato import formato_ars, formato_usd, formato_moneda, nombre_mes, nombre_mes_corto
from src.graficos import (
    grafico_dona, grafico_barras_h, grafico_lineas, grafico_barras_agrupadas,
    grafico_barras_apiladas, grafico_presupuesto,
)

# --- Sidebar ---

with st.sidebar:
    st.title('\U0001f4b0 Finanzas M&O')
    st.divider()

    hoy = datetime.date.today()
    mes = st.selectbox('Mes', range(1, 13), index=hoy.month - 1,
                       format_func=nombre_mes)
    anio = st.number_input('Año', min_value=2026, max_value=2030, value=hoy.year)

    st.divider()
    seccion = st.radio('Sección', [
        'Resumen del mes',
        'Gastos por categoría',
        'Tendencias mensuales',
        'Balance compartido',
        'Presupuesto vs real',
        'Métodos de pago',
        'Cuotas activas',
        'Flujo de caja',
        'Ahorro',
        'Crypto',
        'Gastos fijos',
        'Comparativo M vs O',
    ])

    st.divider()
    if st.button('\U0001f504 Actualizar datos'):
        st.cache_data.clear()
        st.rerun()

    st.divider()
    if st.toggle('🌙 Modo oscuro', value=st.session_state.dark_mode):
        if not st.session_state.dark_mode:
            st.session_state.dark_mode = True
            st.rerun()
    else:
        if st.session_state.dark_mode:
            st.session_state.dark_mode = False
            st.rerun()


# ==================================================================
# SECCIONES
# ==================================================================

# --- 1. Resumen del mes ---

def render_resumen(mes, anio):
    st.header(f'Resumen — {nombre_mes(mes)} {anio}')

    df = filtrar_mes(cargar_transacciones(), mes, anio)
    if df.empty:
        st.info('No hay transacciones para este mes.')
        return

    df_ars = df[df['moneda'] == 'ARS']
    df_usd = df[df['moneda'] == 'USD']
    total_ars = df_ars['monto'].sum()
    total_usd = df_usd['monto'].sum()

    # Métricas principales
    c1, c2 = st.columns(2)
    c1.metric('Total ARS', formato_ars(total_ars))
    c2.metric('Total USD', formato_usd(total_usd))

    c3, c4 = st.columns(2)
    c3.metric('Transacciones', len(df))
    dias_mes = (datetime.date(anio, mes % 12 + 1, 1) - datetime.timedelta(days=1)).day if mes < 12 else 31
    dia_actual = min(hoy.day, dias_mes) if mes == hoy.month and anio == hoy.year else dias_mes
    c4.metric('Promedio diario ARS', formato_ars(total_ars / max(dia_actual, 1)))

    st.divider()

    # Por persona (solo ARS)
    gasto_moises = df_ars['monto_moises'].sum()
    gasto_oriana = df_ars['monto_oriana'].sum()
    compartido = df_ars[df_ars['tipo'].str.contains('Compartido', case=False, na=False)]['monto'].sum()

    c5, c6 = st.columns(2)
    c5.metric('Gasto Moises', formato_ars(gasto_moises))
    c6.metric('Gasto Oriana', formato_ars(gasto_oriana))
    st.metric('Gasto Compartido', formato_ars(compartido))

    # Dona por tipo
    tipos = {'Individual Moises': 0, 'Individual Oriana': 0, 'Compartido': 0}
    for _, row in df_ars.iterrows():
        t = row['tipo']
        if 'moises' in t.lower():
            tipos['Individual Moises'] += row['monto']
        elif 'oriana' in t.lower():
            tipos['Individual Oriana'] += row['monto']
        else:
            tipos['Compartido'] += row['monto']

    labels = [k for k, v in tipos.items() if v > 0]
    values = [v for v in tipos.values() if v > 0]
    if labels:
        st.plotly_chart(grafico_dona(labels, values, 'Distribución por tipo', dark=dark),
                        use_container_width=True)


# --- 2. Gastos por categoría ---

def render_categorias(mes, anio):
    st.header(f'Gastos por categoría — {nombre_mes(mes)}')

    df = filtrar_mes(cargar_transacciones(), mes, anio)
    if df.empty:
        st.info('No hay transacciones para este mes.')
        return

    filtro = st.segmented_control('Filtrar por', ['Todos', 'Moises', 'Oriana', 'Compartido'],
                                  default='Todos')
    if filtro == 'Moises':
        df = df[df['tipo'].str.contains('moises', case=False, na=False)]
    elif filtro == 'Oriana':
        df = df[df['tipo'].str.contains('oriana', case=False, na=False)]
    elif filtro == 'Compartido':
        df = df[df['tipo'].str.contains('compartido', case=False, na=False)]

    df_ars = df[df['moneda'] == 'ARS']
    if df_ars.empty:
        st.info('No hay gastos ARS con este filtro.')
        return

    por_cat = df_ars.groupby('categoria')['monto'].sum().sort_values(ascending=False)

    # Dona
    st.plotly_chart(grafico_dona(por_cat.index.tolist(), por_cat.values.tolist(),
                                 'Distribución ARS', dark=dark), use_container_width=True)

    # Barras
    st.plotly_chart(grafico_barras_h(por_cat.index.tolist(), por_cat.values.tolist(),
                                     'Monto por categoría', dark=dark), use_container_width=True)

    # USD si hay
    df_usd = df[df['moneda'] == 'USD']
    if not df_usd.empty:
        st.divider()
        por_cat_usd = df_usd.groupby('categoria')['monto'].sum().sort_values(ascending=False)
        st.plotly_chart(grafico_barras_h(por_cat_usd.index.tolist(), por_cat_usd.values.tolist(),
                                         'Monto por categoría (USD)', es_usd=True, dark=dark),
                        use_container_width=True)


# --- 3. Tendencias mensuales ---

def render_tendencias(mes, anio):
    st.header(f'Tendencias — {anio}')

    df = cargar_transacciones()
    df_anio = df[df['anio'] == anio]
    if df_anio.empty:
        st.info('No hay transacciones para este año.')
        return

    # Totales por mes
    meses_labels = []
    totales_ars = []
    totales_usd = []
    for m in range(1, 13):
        df_m = df_anio[df_anio['mes'] == m]
        meses_labels.append(nombre_mes_corto(m))
        totales_ars.append(df_m[df_m['moneda'] == 'ARS']['monto'].sum())
        totales_usd.append(df_m[df_m['moneda'] == 'USD']['monto'].sum())

    st.plotly_chart(grafico_lineas(meses_labels, {'Gasto ARS': totales_ars},
                                   'Gasto ARS mensual', dark=dark), use_container_width=True)

    if any(v > 0 for v in totales_usd):
        st.plotly_chart(grafico_lineas(meses_labels, {'Gasto USD': totales_usd},
                                       'Gasto USD mensual', es_usd=True, dark=dark),
                        use_container_width=True)

    # Delta vs mes anterior
    if mes > 1 and totales_ars[mes - 2] > 0:
        actual = totales_ars[mes - 1]
        anterior = totales_ars[mes - 2]
        delta = ((actual - anterior) / anterior) * 100
        st.metric(f'vs {nombre_mes(mes - 1)}',
                  formato_ars(actual),
                  f'{delta:+.1f}%',
                  delta_color='inverse')

    # Top 5 categorías apiladas
    st.divider()
    df_ars = df_anio[df_anio['moneda'] == 'ARS']
    top5 = df_ars.groupby('categoria')['monto'].sum().nlargest(5).index.tolist()
    series = {}
    for cat in top5:
        vals = []
        for m in range(1, 13):
            vals.append(df_ars[(df_ars['mes'] == m) & (df_ars['categoria'] == cat)]['monto'].sum())
        series[cat] = vals
    if series:
        st.plotly_chart(grafico_barras_apiladas(meses_labels, series,
                                                 'Top 5 categorías por mes', dark=dark),
                        use_container_width=True)


# --- 4. Balance compartido ---

def render_balance(mes, anio):
    st.header('Balance compartido')

    balance = cargar_balance()

    if not balance['meses']:
        st.info('No hay datos de balance.')
        return

    # Resultado del mes actual
    idx = mes - 1
    mes_data = balance['meses'][idx] if idx < len(balance['meses']) else None
    if mes_data:
        resultado = mes_data['resultado']
        if resultado:
            st.markdown(f'### {nombre_mes(mes)}: **{resultado}**')
        else:
            st.markdown(f'### {nombre_mes(mes)}: Sin gastos compartidos')

    # Saldo acumulado
    if balance['saldo_acumulado'] and balance['saldo_acumulado']['resultado']:
        st.info(f"Saldo acumulado anual: **{balance['saldo_acumulado']['resultado']}**")

    st.divider()

    # Tabla de meses
    tabla_data = []
    balances_chart = []
    meses_chart = []
    for i, m in enumerate(balance['meses']):
        if m['total_compartido'] > 0:
            tabla_data.append({
                'Mes': m['mes'],
                'Total': formato_ars(m['total_compartido']),
                'Pagó M': formato_ars(m['pago_moises']),
                'Pagó O': formato_ars(m['pago_oriana']),
                'Balance M': formato_ars(m['balance_moises']),
            })
            balances_chart.append(m['balance_moises'])
            meses_chart.append(m['mes'])

    if tabla_data:
        st.dataframe(pd.DataFrame(tabla_data), hide_index=True, use_container_width=True)

    # Gráfico de evolución
    if len(meses_chart) > 1:
        st.plotly_chart(grafico_lineas(meses_chart, {'Balance Moises': balances_chart},
                                       'Evolución del balance', dark=dark), use_container_width=True)


# --- 5. Presupuesto vs real ---

def render_presupuesto(mes, anio):
    st.header(f'Presupuesto vs real — {nombre_mes(mes)}')

    vista = st.segmented_control('Sección', ['Moises ARS', 'Oriana ARS', 'Compartido ARS', 'Moises USD'],
                                 default='Moises ARS')

    es_usd = vista == 'Moises USD'
    if es_usd:
        df_pres = cargar_presupuesto_usd()
    else:
        presupuestos = cargar_presupuesto_ars()
        if 'Moises' in vista:
            df_pres = presupuestos['moises']
        elif 'Oriana' in vista:
            df_pres = presupuestos['oriana']
        else:
            df_pres = presupuestos['compartido']

    if df_pres.empty:
        st.info('No hay datos de presupuesto.')
        return

    col_mes = f'mes_{mes}'
    fmt = formato_usd if es_usd else formato_ars

    # Filtrar categorías con presupuesto o gasto
    datos = df_pres[['categoria', 'presupuesto', col_mes]].copy()
    datos.columns = ['categoria', 'presupuesto', 'real']
    datos = datos[(datos['presupuesto'] > 0) | (datos['real'] > 0)]

    if datos.empty:
        st.info('No hay presupuesto ni gastos para esta sección.')
        return

    # Métricas resumen
    total_presup = datos['presupuesto'].sum()
    total_real = datos['real'].sum()
    pct = (total_real / total_presup * 100) if total_presup > 0 else 0

    c1, c2 = st.columns(2)
    c1.metric('Presupuestado', fmt(total_presup))
    c2.metric('Gastado', fmt(total_real))
    st.metric('Uso global', f'{pct:.0f}%')

    st.divider()

    # Gráfico
    st.plotly_chart(grafico_presupuesto(
        datos['categoria'].tolist(),
        datos['presupuesto'].tolist(),
        datos['real'].tolist(),
        dark=dark,
    ), use_container_width=True)

    # Progress bars por categoría
    for _, row in datos.iterrows():
        pct_cat = row['real'] / row['presupuesto'] if row['presupuesto'] > 0 else 0
        color = 'red' if pct_cat > 1 else ('orange' if pct_cat > 0.8 else 'green')
        label = f"**{row['categoria']}** — {fmt(row['real'])} / {fmt(row['presupuesto'])} ({pct_cat:.0%})"
        st.markdown(label)
        st.progress(min(pct_cat, 1.0))


# --- 6. Métodos de pago ---

def render_metodos(mes, anio):
    st.header(f'Métodos de pago — {nombre_mes(mes)}')

    df = filtrar_mes(cargar_transacciones(), mes, anio)
    if df.empty:
        st.info('No hay transacciones para este mes.')
        return

    df_ars = df[df['moneda'] == 'ARS']
    por_metodo = df_ars.groupby('metodo_pago')['monto'].sum().sort_values(ascending=False)

    if por_metodo.empty:
        st.info('No hay gastos ARS este mes.')
        return

    # Total tarjetas
    tarjetas = ['Visa Galicia', 'Master Galicia', 'Visa BBVA', 'Master BBVA', 'Tarjeta']
    total_tarjetas = por_metodo[por_metodo.index.isin(tarjetas)].sum()
    st.metric('Total Tarjetas de Crédito', formato_ars(total_tarjetas))

    st.divider()

    # Dona
    st.plotly_chart(grafico_dona(por_metodo.index.tolist(), por_metodo.values.tolist(),
                                 'Distribución por método', dark=dark), use_container_width=True)

    # Barras
    st.plotly_chart(grafico_barras_h(por_metodo.index.tolist(), por_metodo.values.tolist(),
                                     'Monto por método', dark=dark), use_container_width=True)

    # USD si hay
    df_usd = df[df['moneda'] == 'USD']
    if not df_usd.empty:
        por_metodo_usd = df_usd.groupby('metodo_pago')['monto'].sum()
        st.divider()
        st.subheader('Gastos USD')
        for metodo, monto in por_metodo_usd.items():
            st.metric(metodo, formato_usd(monto))


# --- 7. Cuotas activas ---

def render_cuotas(mes, anio):
    st.header('Cuotas de tarjeta')

    df = cargar_cuotas()
    if df.empty:
        st.info('No hay cuotas registradas.')
        return

    activas = df[~df['estado'].str.contains('Completada', case=False, na=False)]
    completadas = df[df['estado'].str.contains('Completada', case=False, na=False)]

    # Total mensual en cuotas activas
    total_mensual = activas['monto_cuota'].sum()
    st.metric('Total mensual en cuotas', formato_ars(total_mensual))

    st.divider()

    # Activas
    if not activas.empty:
        st.subheader(f'Activas ({len(activas)})')
        for _, c in activas.iterrows():
            progreso = c['cuotas_reg'] / c['cuotas'] if c['cuotas'] > 0 else 0
            st.markdown(
                f"**{c['descripcion']}** — {c['cuotas_reg']}/{c['cuotas']} cuotas — "
                f"{formato_ars(c['monto_cuota'])}/mes ({c['tarjeta']})"
            )
            st.progress(min(progreso, 1.0))
    else:
        st.success('No hay cuotas activas.')

    # Completadas
    if not completadas.empty:
        with st.expander(f'Completadas ({len(completadas)})'):
            for _, c in completadas.iterrows():
                st.markdown(
                    f"~~{c['descripcion']}~~ — {c['cuotas']} cuotas — {c['tarjeta']}"
                )


# --- 8. Flujo de caja ---

def render_flujo(mes, anio):
    st.header(f'Flujo de caja — {nombre_mes(mes)}')

    df = filtrar_mes(cargar_transacciones(), mes, anio)
    ing_m = cargar_ingresos_moises()
    ing_o = cargar_ingresos_oriana()

    # Ingresos del mes (0-indexed row = mes - 1)
    idx = mes - 1

    # Moises
    recibido_m = 0
    salario_usd = 0
    queda_deel = 0
    transferido_usd = 0
    if idx < len(ing_m):
        row_m = ing_m.iloc[idx]
        recibido_m = row_m['recibido_ars']
        salario_usd = row_m['salario_usd']
        queda_deel = row_m['queda_deel']
        transferido_usd = row_m['transferido']

    # Oriana
    ingreso_o = 0
    if idx < len(ing_o):
        ingreso_o = ing_o.iloc[idx]['ingreso_ars']

    total_ingresos_ars = recibido_m + ingreso_o
    total_gastos_ars = df[df['moneda'] == 'ARS']['monto'].sum() if not df.empty else 0
    sobrante_ars = total_ingresos_ars - total_gastos_ars

    total_gastos_usd = df[df['moneda'] == 'USD']['monto'].sum() if not df.empty else 0

    # Sección ARS
    st.subheader('ARS')
    c1, c2 = st.columns(2)
    c1.metric('Ingresó Moises', formato_ars(recibido_m))
    c2.metric('Ingresó Oriana', formato_ars(ingreso_o))

    st.metric('Total Ingresos ARS', formato_ars(total_ingresos_ars))

    # Desglose gastos ARS por tipo de pago
    if not df.empty:
        df_ars = df[df['moneda'] == 'ARS']
        tarjetas_total = df_ars[df_ars['metodo_pago'].isin(
            ['Visa Galicia', 'Master Galicia', 'Visa BBVA', 'Master BBVA', 'Tarjeta']
        )]['monto'].sum()
        deel_card = df_ars[df_ars['metodo_pago'] == 'Deel Card']['monto'].sum()
        banco = df_ars[df_ars['metodo_pago'] == 'Banco']['monto'].sum()
        efectivo = df_ars[df_ars['metodo_pago'] == 'Efectivo']['monto'].sum()

        st.metric('Gastado ARS', formato_ars(total_gastos_ars))
        with st.expander('Desglose'):
            st.markdown(f'- Tarjetas: {formato_ars(tarjetas_total)}')
            st.markdown(f'- Deel Card: {formato_ars(deel_card)}')
            st.markdown(f'- Banco: {formato_ars(banco)}')
            st.markdown(f'- Efectivo: {formato_ars(efectivo)}')

    # Gastos fijos estimados
    df_fijos = cargar_gastos_fijos()
    if not df_fijos.empty:
        fijos_ars = df_fijos[df_fijos['moneda'] == 'ARS']['monto'].sum()
        st.metric('Gastos Fijos estimados', formato_ars(fijos_ars))

    color_sobrante = 'normal' if sobrante_ars >= 0 else 'inverse'
    st.metric('Sobrante ARS', formato_ars(sobrante_ars),
              delta=f'{sobrante_ars / total_ingresos_ars * 100:.0f}% del ingreso' if total_ingresos_ars > 0 else None,
              delta_color=color_sobrante)

    st.divider()

    # Sección USD
    st.subheader('USD')
    c1, c2 = st.columns(2)
    c1.metric('Salario USD', formato_usd(salario_usd))
    c2.metric('Transferido a ARS', formato_usd(transferido_usd))

    c3, c4 = st.columns(2)
    c3.metric('Gastado USD', formato_usd(total_gastos_usd))
    c4.metric('Queda en Deel', formato_usd(queda_deel))


# --- 9. Ahorro ---

def render_ahorro(mes, anio):
    st.header(f'Ahorro — {nombre_mes(mes)} {anio}')

    df = cargar_transacciones()
    if df.empty:
        st.info('No hay transacciones.')
        return

    df_ahorro = df[df['categoria'].str.contains('Ahorro', case=False, na=False)]
    df_ahorro_anio = df_ahorro[df_ahorro['anio'] == anio]
    df_ahorro_mes = df_ahorro_anio[df_ahorro_anio['mes'] == mes]

    # Ahorro del mes
    ahorro_ars_mes = df_ahorro_mes[df_ahorro_mes['moneda'] == 'ARS']['monto'].sum()
    ahorro_usd_mes = df_ahorro_mes[df_ahorro_mes['moneda'] == 'USD']['monto'].sum()

    st.subheader(f'{nombre_mes(mes)}')
    c1, c2 = st.columns(2)
    c1.metric('Ahorro ARS', formato_ars(ahorro_ars_mes))
    c2.metric('Ahorro USD', formato_usd(ahorro_usd_mes))

    st.divider()

    # Ahorro acumulado del año
    ahorro_ars_acum = df_ahorro_anio[df_ahorro_anio['moneda'] == 'ARS']['monto'].sum()
    ahorro_usd_acum = df_ahorro_anio[df_ahorro_anio['moneda'] == 'USD']['monto'].sum()

    st.subheader(f'Acumulado {anio}')
    c1, c2 = st.columns(2)
    c1.metric('Ahorro ARS (año)', formato_ars(ahorro_ars_acum))
    c2.metric('Ahorro USD (año)', formato_usd(ahorro_usd_acum))

    st.divider()

    # Tendencia mensual de ahorro
    meses_labels = []
    ahorro_ars_vals = []
    ahorro_usd_vals = []
    for m in range(1, 13):
        df_m = df_ahorro_anio[df_ahorro_anio['mes'] == m]
        meses_labels.append(nombre_mes_corto(m))
        ahorro_ars_vals.append(df_m[df_m['moneda'] == 'ARS']['monto'].sum())
        ahorro_usd_vals.append(df_m[df_m['moneda'] == 'USD']['monto'].sum())

    if any(v > 0 for v in ahorro_ars_vals):
        st.plotly_chart(grafico_lineas(meses_labels, {'Ahorro ARS': ahorro_ars_vals},
                                       'Ahorro ARS mensual', dark=dark), use_container_width=True)

    if any(v > 0 for v in ahorro_usd_vals):
        st.plotly_chart(grafico_lineas(meses_labels, {'Ahorro USD': ahorro_usd_vals},
                                       'Ahorro USD mensual', es_usd=True, dark=dark),
                        use_container_width=True)

    # Detalle transacciones de ahorro del mes
    if not df_ahorro_mes.empty:
        st.divider()
        st.subheader('Detalle')
        for _, row in df_ahorro_mes.iterrows():
            st.markdown(
                f"- {row['descripcion']} — {formato_moneda(row['monto'], row['moneda'])} "
                f"({row['metodo_pago']})"
            )

    # Subsección crypto en ahorro
    try:
        df_crypto = cargar_crypto_holdings()
        if not df_crypto.empty and df_crypto['cantidad'].sum() > 0:
            st.divider()
            st.subheader('Crypto')
            df_active = df_crypto[df_crypto['cantidad'] > 0]
            total_crypto = df_active['valor_usd'].sum()
            st.metric('Total Crypto', formato_usd(total_crypto))
            for _, h in df_active.iterrows():
                st.markdown(
                    f"- **{h['nombre']} ({h['simbolo']})**: {h['cantidad']:.6f} "
                    f"@ {formato_usd(h['precio_usd'])} = {formato_usd(h['valor_usd'])}"
                )
    except Exception:
        pass


# --- 10. Crypto ---

def render_crypto(mes, anio):
    st.header('Portafolio Crypto')

    try:
        df_holdings = cargar_crypto_holdings()
    except Exception:
        st.warning('No se pudo cargar la hoja Crypto.')
        return

    if df_holdings.empty or df_holdings['cantidad'].sum() == 0:
        st.info('No hay holdings crypto.')
        return

    df_active = df_holdings[df_holdings['cantidad'] > 0]
    total_crypto = df_active['valor_usd'].sum()

    # Métrica principal
    st.metric('Total Portafolio', formato_usd(total_crypto))

    st.divider()

    # Holdings individuales
    for _, h in df_active.iterrows():
        c1, c2, c3 = st.columns(3)
        c1.metric(f"{h['simbolo']}", f"{h['cantidad']:.6f}")
        c2.metric('Precio', formato_usd(h['precio_usd']))
        c3.metric('Valor', formato_usd(h['valor_usd']))

    # Dona de distribución si hay múltiples cryptos
    if len(df_active) > 1:
        st.divider()
        st.plotly_chart(grafico_dona(
            df_active['simbolo'].tolist(),
            df_active['valor_usd'].tolist(),
            'Distribución Crypto', es_usd=True, dark=dark,
        ), use_container_width=True)

    # Historial de movimientos
    st.divider()
    st.subheader('Historial de movimientos')
    try:
        df_tx = cargar_crypto_transacciones()
        if df_tx.empty:
            st.info('Sin movimientos registrados.')
        else:
            for _, tx in df_tx.iterrows():
                emoji = '🟢' if tx['tipo'] == 'Compra' else '🔴'
                fecha_str = tx['fecha'].strftime('%d/%m/%Y') if hasattr(tx['fecha'], 'strftime') else str(tx['fecha'])
                st.markdown(
                    f"{emoji} {fecha_str} — {tx['tipo']} {tx['cantidad']:.6f} {tx['crypto']} "
                    f"a {formato_usd(tx['precio_usd'])} = {formato_usd(tx['total_usd'])} ({tx['plataforma']})"
                )
    except Exception:
        st.warning('No se pudo cargar el historial.')


# --- 11. Gastos fijos ---

def render_fijos(mes, anio):
    st.header(f'Gastos fijos — {nombre_mes(mes)}')

    df = cargar_gastos_fijos()
    if df.empty:
        st.info('No hay gastos fijos configurados.')
        return

    registrados = df[df['registrado']]
    pendientes = df[~df['registrado']]

    # Métricas
    total = len(df)
    n_reg = len(registrados)
    progreso = n_reg / total if total > 0 else 0

    c1, c2 = st.columns(2)
    c1.metric('Registrados', f'{n_reg}/{total}')
    c2.metric('Total pendiente', formato_ars(pendientes[pendientes['moneda'] == 'ARS']['monto'].sum()))
    st.progress(progreso)

    st.divider()

    # Pendientes
    if not pendientes.empty:
        st.subheader(f'Pendientes ({len(pendientes)})')
        for _, g in pendientes.iterrows():
            st.markdown(
                f"- {g['descripcion']} — {formato_moneda(g['monto'], g['moneda'])} "
                f"({g['tipo']}, {g['metodo_pago']})"
            )

    # Registrados
    if not registrados.empty:
        with st.expander(f'Registrados ({len(registrados)})'):
            for _, g in registrados.iterrows():
                st.markdown(
                    f"- ~~{g['descripcion']}~~ — {formato_moneda(g['monto'], g['moneda'])}"
                )


# --- 10. Comparativo M vs O ---

def render_comparativo(mes, anio):
    st.header(f'Comparativo — {nombre_mes(mes)}')

    df = filtrar_mes(cargar_transacciones(), mes, anio)
    if df.empty:
        st.info('No hay transacciones para este mes.')
        return

    df_ars = df[df['moneda'] == 'ARS']

    total_m = df_ars['monto_moises'].sum()
    total_o = df_ars['monto_oriana'].sum()

    c1, c2 = st.columns(2)
    c1.metric('Moises', formato_ars(total_m))
    c2.metric('Oriana', formato_ars(total_o))

    st.divider()

    # Por categoría
    categorias = df_ars['categoria'].unique().tolist()
    categorias.sort()
    moises_vals = []
    oriana_vals = []
    for cat in categorias:
        df_cat = df_ars[df_ars['categoria'] == cat]
        moises_vals.append(df_cat['monto_moises'].sum())
        oriana_vals.append(df_cat['monto_oriana'].sum())

    if categorias:
        st.plotly_chart(grafico_barras_agrupadas(
            categorias,
            {'Moises': moises_vals, 'Oriana': oriana_vals},
            'Gasto por categoría', dark=dark,
        ), use_container_width=True)

    # Tabla resumen
    st.divider()
    tabla = []
    for cat, m, o in zip(categorias, moises_vals, oriana_vals):
        tabla.append({
            'Categoría': cat,
            'Moises': formato_ars(m),
            'Oriana': formato_ars(o),
            'Diferencia': formato_ars(m - o),
        })
    if tabla:
        st.dataframe(pd.DataFrame(tabla), hide_index=True, use_container_width=True)


# ==================================================================
# ROUTING
# ==================================================================

if seccion == 'Resumen del mes':
    render_resumen(mes, anio)
elif seccion == 'Gastos por categoría':
    render_categorias(mes, anio)
elif seccion == 'Tendencias mensuales':
    render_tendencias(mes, anio)
elif seccion == 'Balance compartido':
    render_balance(mes, anio)
elif seccion == 'Presupuesto vs real':
    render_presupuesto(mes, anio)
elif seccion == 'Métodos de pago':
    render_metodos(mes, anio)
elif seccion == 'Cuotas activas':
    render_cuotas(mes, anio)
elif seccion == 'Flujo de caja':
    render_flujo(mes, anio)
elif seccion == 'Ahorro':
    render_ahorro(mes, anio)
elif seccion == 'Crypto':
    render_crypto(mes, anio)
elif seccion == 'Gastos fijos':
    render_fijos(mes, anio)
elif seccion == 'Comparativo M vs O':
    render_comparativo(mes, anio)
