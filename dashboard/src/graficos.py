# Fábrica de gráficos Plotly con layout mobile-optimizado.

import plotly.express as px
import plotly.graph_objects as go
import pandas as pd
from .formato import formato_ars, formato_usd

# Paleta pastel (light mode)
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

# Paleta vibrante (dark mode)
COLORES_DARK = [
    '#5CB8FF',  # Azul brillante
    '#FF7B7B',  # Rojo coral
    '#6EE6A7',  # Verde neón suave
    '#FFD166',  # Amarillo dorado
    '#B388FF',  # Violeta brillante
    '#4DD0E1',  # Cyan
    '#FF80AB',  # Rosa vibrante
    '#69F0AE',  # Verde lima
    '#FFB74D',  # Naranja cálido
    '#CE93D8',  # Púrpura claro
    '#80DEEA',  # Turquesa brillante
]


def _get_colores(dark=False):
    return COLORES_DARK if dark else COLORES


def _layout_mobile(fig, titulo=None, dark=False):
    """Aplica layout optimizado para mobile."""
    if dark:
        text_color = '#E0E3EB'
        grid_color = '#3A3A48'
        bg = 'rgba(0,0,0,0)'
    else:
        text_color = '#3d3d3d'
        grid_color = '#f0f2f6'
        bg = 'rgba(0,0,0,0)'

    fig.update_layout(
        title=dict(text=titulo, font=dict(size=16, color=text_color)) if titulo else None,
        margin=dict(l=10, r=10, t=40 if titulo else 10, b=10),
        legend=dict(orientation='h', yanchor='bottom', y=-0.3, xanchor='center', x=0.5,
                    font=dict(color=text_color)),
        font=dict(size=12, color=text_color),
        paper_bgcolor=bg,
        plot_bgcolor=bg,
        height=350,
    )
    fig.update_xaxes(gridcolor=grid_color, tickfont=dict(color=text_color))
    fig.update_yaxes(gridcolor=grid_color, tickfont=dict(color=text_color))
    return fig


def grafico_dona(labels, values, titulo=None, es_usd=False, dark=False):
    """Gráfico de dona para distribución de gastos."""
    fmt = formato_usd if es_usd else formato_ars
    colores = _get_colores(dark)
    fig = go.Figure(data=[go.Pie(
        labels=labels,
        values=values,
        hole=0.5,
        marker=dict(colors=colores[:len(labels)]),
        textinfo='percent',
        hovertemplate='%{label}<br>%{customdata}<extra></extra>',
        customdata=[fmt(v) for v in values],
    )])
    return _layout_mobile(fig, titulo, dark=dark)


def grafico_barras_h(categorias, valores, titulo=None, es_usd=False, colores=None, dark=False):
    """Barras horizontales — ideal para mobile, labels legibles."""
    fmt = formato_usd if es_usd else formato_ars
    paleta = _get_colores(dark)
    # Ordenar descendente (mayor arriba)
    pares = sorted(zip(categorias, valores), key=lambda x: x[1])
    cats = [p[0] for p in pares]
    vals = [p[1] for p in pares]

    fig = go.Figure(data=[go.Bar(
        y=cats,
        x=vals,
        orientation='h',
        marker_color=colores or paleta[0],
        hovertemplate='%{y}: %{customdata}<extra></extra>',
        customdata=[fmt(v) for v in vals],
        text=[fmt(v) for v in vals],
        textposition='outside',
    )])
    fig.update_xaxes(visible=False)
    fig.update_yaxes(tickfont=dict(size=11))
    height = max(250, len(cats) * 35 + 60)
    fig = _layout_mobile(fig, titulo, dark=dark)
    fig.update_layout(height=height)
    return fig


def grafico_lineas(meses, series, titulo=None, es_usd=False, dark=False):
    """Gráfico de líneas para tendencias mensuales.

    series: dict de {nombre: [valores]}
    """
    colores = _get_colores(dark)
    fig = go.Figure()
    for i, (nombre, valores) in enumerate(series.items()):
        fig.add_trace(go.Scatter(
            x=meses,
            y=valores,
            name=nombre,
            mode='lines+markers',
            line=dict(color=colores[i % len(colores)], width=2),
            marker=dict(size=6),
        ))
    return _layout_mobile(fig, titulo, dark=dark)


def grafico_barras_agrupadas(categorias, series, titulo=None, es_usd=False, dark=False):
    """Barras agrupadas para comparativos.

    series: dict de {nombre: [valores]}
    """
    fmt = formato_usd if es_usd else formato_ars
    colores = _get_colores(dark)
    fig = go.Figure()
    for i, (nombre, valores) in enumerate(series.items()):
        fig.add_trace(go.Bar(
            x=categorias,
            y=valores,
            name=nombre,
            marker_color=colores[i % len(colores)],
            hovertemplate='%{x}: %{customdata}<extra></extra>',
            customdata=[fmt(v) for v in valores],
        ))
    fig.update_layout(barmode='group')
    fig.update_xaxes(tickangle=-45, tickfont=dict(size=10))
    fig.update_yaxes(visible=False)
    return _layout_mobile(fig, titulo, dark=dark)


def grafico_barras_apiladas(meses, series, titulo=None, dark=False):
    """Barras apiladas para composición por mes."""
    colores = _get_colores(dark)
    fig = go.Figure()
    for i, (nombre, valores) in enumerate(series.items()):
        fig.add_trace(go.Bar(
            x=meses,
            y=valores,
            name=nombre,
            marker_color=colores[i % len(colores)],
        ))
    fig.update_layout(barmode='stack')
    fig.update_xaxes(tickfont=dict(size=10))
    fig.update_yaxes(visible=False)
    return _layout_mobile(fig, titulo, dark=dark)


def grafico_presupuesto(categorias, presupuestado, real, titulo=None, dark=False):
    """Barras de presupuesto vs real con colores según porcentaje."""
    if dark:
        col_ok, col_warn, col_over, col_default = '#6EE6A7', '#FFD166', '#FF7B7B', '#5CB8FF'
        marker_color = '#A0A4B8'
    else:
        col_ok, col_warn, col_over, col_default = '#a8d5a2', '#f7d794', '#f4a7a0', COLORES[0]
        marker_color = '#666666'

    colores_barra = []
    for p, r in zip(presupuestado, real):
        if p <= 0:
            colores_barra.append(col_default)
        elif r / p > 1:
            colores_barra.append(col_over)
        elif r / p > 0.8:
            colores_barra.append(col_warn)
        else:
            colores_barra.append(col_ok)

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
        marker=dict(symbol='line-ns', size=20, color=marker_color, line=dict(width=2)),
    ))
    fig.update_xaxes(visible=False)
    height = max(300, len(cats) * 40 + 80)
    fig = _layout_mobile(fig, titulo, dark=dark)
    fig.update_layout(height=height)
    return fig
