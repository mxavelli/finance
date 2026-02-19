# Fábrica de gráficos Plotly con layout mobile-optimizado.

import plotly.express as px
import plotly.graph_objects as go
import pandas as pd
from .formato import formato_ars, formato_usd

# Paleta pastel
COLORES = [
    '#7eb8da',  # Azul pastel
    '#f4a7a0',  # Rosa salmón
    '#a8d5a2',  # Verde menta
    '#f7d794',  # Amarillo durazno
    '#c3aed6',  # Lila
    '#87ceeb',  # Celeste
    '#f8b4c8',  # Rosa claro
    '#b5ead7',  # Verde agua
    '#ffd1a9',  # Naranja melocotón
    '#d4a5e5',  # Violeta suave
    '#a0d2db',  # Turquesa pastel
]


def _layout_mobile(fig, titulo=None):
    """Aplica layout optimizado para mobile."""
    fig.update_layout(
        title=dict(text=titulo, font=dict(size=16)) if titulo else None,
        margin=dict(l=10, r=10, t=40 if titulo else 10, b=10),
        legend=dict(orientation='h', yanchor='bottom', y=-0.3, xanchor='center', x=0.5),
        font=dict(size=12),
        paper_bgcolor='rgba(0,0,0,0)',
        plot_bgcolor='rgba(0,0,0,0)',
        height=350,
    )
    return fig


def grafico_dona(labels, values, titulo=None, es_usd=False):
    """Gráfico de dona para distribución de gastos."""
    fmt = formato_usd if es_usd else formato_ars
    fig = go.Figure(data=[go.Pie(
        labels=labels,
        values=values,
        hole=0.5,
        marker=dict(colors=COLORES[:len(labels)]),
        textinfo='percent',
        hovertemplate='%{label}<br>%{customdata}<extra></extra>',
        customdata=[fmt(v) for v in values],
    )])
    return _layout_mobile(fig, titulo)


def grafico_barras_h(categorias, valores, titulo=None, es_usd=False, colores=None):
    """Barras horizontales — ideal para mobile, labels legibles."""
    fmt = formato_usd if es_usd else formato_ars
    # Ordenar descendente (mayor arriba)
    pares = sorted(zip(categorias, valores), key=lambda x: x[1])
    cats = [p[0] for p in pares]
    vals = [p[1] for p in pares]

    fig = go.Figure(data=[go.Bar(
        y=cats,
        x=vals,
        orientation='h',
        marker_color=colores or COLORES[0],
        hovertemplate='%{y}: %{customdata}<extra></extra>',
        customdata=[fmt(v) for v in vals],
        text=[fmt(v) for v in vals],
        textposition='outside',
    )])
    fig.update_xaxes(visible=False)
    fig.update_yaxes(tickfont=dict(size=11))
    height = max(250, len(cats) * 35 + 60)
    fig = _layout_mobile(fig, titulo)
    fig.update_layout(height=height)
    return fig


def grafico_lineas(meses, series, titulo=None, es_usd=False):
    """Gráfico de líneas para tendencias mensuales.

    series: dict de {nombre: [valores]}
    """
    fig = go.Figure()
    for i, (nombre, valores) in enumerate(series.items()):
        fig.add_trace(go.Scatter(
            x=meses,
            y=valores,
            name=nombre,
            mode='lines+markers',
            line=dict(color=COLORES[i % len(COLORES)], width=2),
            marker=dict(size=6),
        ))
    fig.update_yaxes(gridcolor='#f0f2f6')
    fig.update_xaxes(gridcolor='#f0f2f6')
    return _layout_mobile(fig, titulo)


def grafico_barras_agrupadas(categorias, series, titulo=None, es_usd=False):
    """Barras agrupadas para comparativos.

    series: dict de {nombre: [valores]}
    """
    fmt = formato_usd if es_usd else formato_ars
    fig = go.Figure()
    for i, (nombre, valores) in enumerate(series.items()):
        fig.add_trace(go.Bar(
            x=categorias,
            y=valores,
            name=nombre,
            marker_color=COLORES[i % len(COLORES)],
            hovertemplate='%{x}: %{customdata}<extra></extra>',
            customdata=[fmt(v) for v in valores],
        ))
    fig.update_layout(barmode='group')
    fig.update_xaxes(tickangle=-45, tickfont=dict(size=10))
    fig.update_yaxes(gridcolor='#f0f2f6', visible=False)
    return _layout_mobile(fig, titulo)


def grafico_barras_apiladas(meses, series, titulo=None):
    """Barras apiladas para composición por mes."""
    fig = go.Figure()
    for i, (nombre, valores) in enumerate(series.items()):
        fig.add_trace(go.Bar(
            x=meses,
            y=valores,
            name=nombre,
            marker_color=COLORES[i % len(COLORES)],
        ))
    fig.update_layout(barmode='stack')
    fig.update_xaxes(tickfont=dict(size=10))
    fig.update_yaxes(gridcolor='#f0f2f6', visible=False)
    return _layout_mobile(fig, titulo)


def grafico_presupuesto(categorias, presupuestado, real, titulo=None):
    """Barras de presupuesto vs real con colores según porcentaje."""
    colores_barra = []
    for p, r in zip(presupuestado, real):
        if p <= 0:
            colores_barra.append(COLORES[0])  # Sin presupuesto
        elif r / p > 1:
            colores_barra.append('#f4a7a0')  # Rosa salmón >100%
        elif r / p > 0.8:
            colores_barra.append('#f7d794')  # Durazno >80%
        else:
            colores_barra.append('#a8d5a2')  # Verde menta <80%

    # Ordenar por % usado descendente
    pares = sorted(zip(categorias, real, presupuestado, colores_barra),
                   key=lambda x: x[1] / max(x[2], 1), reverse=True)
    cats = [p[0] for p in pares]
    reales = [p[1] for p in pares]
    presups = [p[2] for p in pares]
    cols = [p[3] for p in pares]

    fig = go.Figure()
    # Barras de gasto real
    fig.add_trace(go.Bar(
        y=cats,
        x=reales,
        orientation='h',
        name='Gastado',
        marker_color=cols,
        text=[formato_ars(v) for v in reales],
        textposition='outside',
    ))
    # Marcadores de presupuesto
    fig.add_trace(go.Scatter(
        y=cats,
        x=presups,
        mode='markers',
        name='Presupuesto',
        marker=dict(symbol='line-ns', size=20, color='#666666', line=dict(width=2)),
    ))
    fig.update_xaxes(visible=False)
    height = max(300, len(cats) * 40 + 80)
    fig = _layout_mobile(fig, titulo)
    fig.update_layout(height=height)
    return fig
