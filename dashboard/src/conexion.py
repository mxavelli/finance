# Conexión a Google Sheets via Service Account (solo lectura).

import streamlit as st
import gspread
from google.oauth2.service_account import Credentials

SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
]


@st.cache_resource
def _get_client():
    """Crea y cachea el cliente de gspread autenticado."""
    creds = Credentials.from_service_account_info(
        st.secrets['gcp_service_account'],
        scopes=SCOPES,
    )
    return gspread.authorize(creds)


def get_sheet():
    """Retorna el spreadsheet abierto."""
    client = _get_client()
    return client.open_by_key(st.secrets['google_sheets']['sheet_id'])
