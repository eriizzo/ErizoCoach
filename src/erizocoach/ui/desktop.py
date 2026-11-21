"""Ventana de escritorio de Erizo Coach (pywebview + WebView2 de Windows).

* Es una ventana propia, con su nombre e icono (sin Edge ni navegador), con el mismo
  diseño que la versión web.
* La ventana y la app se comunican directamente con el puente de pywebview: **no hay
  servidor ni puerto abierto** en tu PC.
* La página solo puede pedir siete cosas a la app (``DesktopBridge``): el estado actual,
  el icono de un objeto, campeón, runa o hechizo por su id numérico, la ficha de un objeto
  (también por id), pasar a segundo
  plano, abrir el cliente de LoL, poner otra página de runas u otros hechizos (solo números,
  que la app valida antes de escribir) y actualizar Erizo Coach.
* Se carga con una política de seguridad estricta: solo su propio código (marcado con
  un *nonce* aleatorio en cada arranque), iconos incrustados y ninguna conexión de red.
* Al cerrar la ventana se cierra Erizo Coach.
* **Segundo plano**: el botón de la cabecera esconde la ventana (y la quita de la barra
  de tareas) y la app sigue trabajando igual. Se vuelve a abrir con el icono de Erizo Coach
  en la bandeja de Windows, junto al reloj, o abriendo Erizo Coach otra vez.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import sys
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from ..config import Settings
from ..events import LaunchState
from .intro import LaunchIntro
from .page import inline_page
from .tray import TrayIcon, default_icon_path
from .web.icons import KINDS, IconProvider
from .web.iteminfo import item_info
from .web.presenter import State, UiPresenter
from .web.window import DEFAULT_SIZE, list_monitors, window_geometry

if TYPE_CHECKING:
    from ..app import Application

log = logging.getLogger(__name__)

TITLE = "Erizo Coach"
LOGOS = ("logo.png", "logo-mini.png")  # imágenes de style.css
BACKGROUND = "#060d1c"  # el mismo fondo que --abyss en style.css (sin destello al abrir)
MIN_SIZE = (380, 480)
ICON_TIMEOUT = 5.0
WEBVIEW2_CLIENT_ID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
APP_USER_MODEL_ID = "ErizoCoach.Desktop"
BACKGROUND_NOTICE = (
    "Erizo Coach sigue en marcha",
    "Las runas, los hechizos y la build se siguen poniendo solos. "
    "Haz clic en este icono para volver a abrir la ventana.",
)


def webview2_available() -> bool:
    """¿Está instalado el motor WebView2 de Microsoft? (Viene de serie en Windows 11)."""
    if sys.platform != "win32":
        return False
    import winreg

    clients = rf"Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}"
    locations = (
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\{clients}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\{clients}"),
        (winreg.HKEY_CURRENT_USER, rf"Software\{clients}"),
    )
    for root, path in locations:
        try:
            with winreg.OpenKey(root, path) as key:
                version, _ = winreg.QueryValueEx(key, "pv")
        except OSError:
            continue
        if version and version != "0.0.0.0":
            return True
    return False


def desktop_available() -> bool:
    if not webview2_available():
        return False
    try:
        import webview  # noqa: F401
    except Exception as exc:  # pragma: no cover - depende del sistema
        log.debug("pywebview no disponible: %s", exc)
        return False
    return True


def build_html(nonce: str | None = None) -> str:
    """La misma página que la versión web, con estilos y código incrustados y CSP estricta."""
    return inline_page(
        "index.html",
        css="style.css",
        script="app.js",
        images=LOGOS,
        replacements={'<html lang="es">': '<html lang="es" data-mode="desktop">'},
        nonce=nonce,
    )


class DesktopBridge:
    """Lo único que la página puede pedir a la app (expuesto como ``window.pywebview.api``).

    Los atributos empiezan por ``_`` para que pywebview no los exponga a la página.
    """

    def __init__(
        self,
        presenter: UiPresenter,
        icons: IconProvider,
        loop: asyncio.AbstractEventLoop,
        to_background: Callable[[], bool] | None = None,
    ) -> None:
        self._presenter = presenter
        self._icons = icons
        self._loop = loop
        self._to_background = to_background

    def get_state(self) -> State:
        return self._presenter.state

    def icon(self, kind: Any, ident: Any) -> str | None:
        """Icono como imagen incrustada (``data:``), o None si no existe."""
        if kind not in KINDS:
            return None
        try:
            number = int(ident)
        except (TypeError, ValueError):
            return None
        if not 0 < number < 1_000_000:
            return None
        future = asyncio.run_coroutine_threadsafe(self._icons.get(kind, number), self._loop)
        try:
            body = future.result(timeout=ICON_TIMEOUT)
        except Exception:
            return None
        return "data:image/png;base64," + base64.b64encode(body).decode("ascii") if body else None

    def item_info(self, ident: Any) -> State | None:
        """La ficha de un objeto (composición, orden de compra, estadísticas y pasivas)."""
        if type(ident) is not int or not 0 < ident < 1_000_000:
            return None

        async def read() -> State | None:  # en el hilo de la app, como todo lo demás
            return item_info(self._icons.gamedata, ident)

        future = asyncio.run_coroutine_threadsafe(read(), self._loop)
        try:
            return future.result(timeout=ICON_TIMEOUT)
        except Exception:
            log.exception("No se pudo leer la ficha del objeto %s", ident)
            return None

    def set_runes(self, page: Any) -> bool:
        """Pone en el cliente la página de runas que has elegido en la ventana."""
        future = asyncio.run_coroutine_threadsafe(self._presenter.request_runes(page), self._loop)
        try:
            return bool(future.result(timeout=ICON_TIMEOUT))
        except Exception:
            log.exception("No se pudieron cambiar las runas desde la ventana")
            return False

    def set_spells(self, spells: Any) -> bool:
        """Pone en el cliente los hechizos que has elegido en la ventana."""
        future = asyncio.run_coroutine_threadsafe(
            self._presenter.request_spells(spells), self._loop
        )
        try:
            return bool(future.result(timeout=ICON_TIMEOUT))
        except Exception:
            log.exception("No se pudieron cambiar los hechizos desde la ventana")
            return False

    def launch_client(self) -> bool:
        """Abre el cliente de League of Legends (botón de la ventana)."""
        future = asyncio.run_coroutine_threadsafe(self._presenter.request_launch(), self._loop)
        try:
            return bool(future.result(timeout=ICON_TIMEOUT))
        except Exception:
            log.exception("No se pudo pedir que se abra el cliente de LoL")
            return False

    def update_app(self) -> bool:
        """Actualiza Erizo Coach a la versión nueva (botón «Actualizar» de la ventana)."""
        future = asyncio.run_coroutine_threadsafe(self._presenter.request_update(), self._loop)
        try:
            return bool(future.result(timeout=ICON_TIMEOUT))
        except Exception:
            log.exception("No se pudo pedir la actualización")
            return False

    def background(self) -> bool:
        """Esconde la ventana; la app sigue funcionando. False si no se puede (sin bandeja)."""
        if self._to_background is None:
            return False
        try:
            return bool(self._to_background())
        except Exception:
            log.exception("No se pudo pasar a segundo plano")
            return False


def render_script(state: State) -> str:
    """Código que la app ejecuta en la página para pintar un estado nuevo."""
    payload = json.dumps(state, ensure_ascii=True)
    return f"window.erizocoach && window.erizocoach.render({payload})"


class DesktopWindow:
    def __init__(self, app: Application, settings: Settings) -> None:
        self._app = app
        self._settings = settings
        self._window: Any = None
        self._loaded = False
        self.shown = False  # la ventana llegó a abrirse alguna vez
        self._hidden = False
        self._minimized = False
        self._noticed = False  # el aviso de «sigue en marcha» sale solo la primera vez
        self._visibility = threading.Lock()
        self._tray: TrayIcon | None = None
        self._intro = LaunchIntro()
        self._launch = ""  # último estado del botón «Abrir League of Legends»

    def run(self) -> None:
        """Abre la ventana y espera a que la cierres (ocupa el hilo principal)."""
        import webview

        _set_app_user_model_id()
        loop = self._app.loop
        if loop is None:
            raise RuntimeError("La app aún no ha arrancado")
        geometry = window_geometry(
            list_monitors(), prefer_secondary=self._settings.window_on_secondary
        )
        x, y, width, height = geometry or (None, None, *DEFAULT_SIZE)
        self._window = webview.create_window(
            TITLE,
            html=build_html(),
            js_api=DesktopBridge(
                self._app.presenter, self._app.icons, loop, to_background=self.to_background
            ),
            x=x,
            y=y,
            width=width,
            height=height,
            min_size=MIN_SIZE,
            background_color=BACKGROUND,
            text_select=False,
            on_top=self._settings.window_on_top,
        )
        self._window.events.loaded += self._on_loaded
        self._window.events.closed += self._on_closed
        self._window.events.minimized += self._on_minimized
        self._window.events.restored += self._on_restored
        self._window.events.maximized += self._on_restored
        self._app.presenter.add_listener(self._push)
        self._app.quit = self.quit  # actualizar cierra la ventana (y con ella, la app)
        tray = TrayIcon(on_open=self.bring_back, on_quit=self.quit, icon_path=default_icon_path())
        self._tray = tray if tray.start() else None
        try:
            webview.start(gui="edgechromium", private_mode=True)
        finally:
            if self._tray is not None:
                self._tray.stop()
                self._tray = None

    # --- Segundo plano ---------------------------------------------------------------

    def to_background(self) -> bool:
        """Esconde la ventana (y la quita de la barra de tareas). La app sigue igual."""
        tray = self._tray
        if tray is None or self._window is None:
            return False  # sin icono en la bandeja no habría forma de volver
        with self._visibility:
            if not self._hidden:
                self._window.hide()
                self._hidden = True
        log.info("Erizo Coach en segundo plano: ábrelo desde el icono junto al reloj.")
        if not self._noticed:
            self._noticed = True
            tray.notify(*BACKGROUND_NOTICE)
        return True

    def bring_back(self) -> None:
        """Vuelve a mostrar la ventana, delante y al día (desde la bandeja o al reabrir)."""
        window = self._window
        if window is None:
            return
        with self._visibility:
            was_hidden, self._hidden = self._hidden, False
            if was_hidden:
                # En segundo plano no se repinta: primero el estado actual, luego se enseña.
                self._evaluate(render_script(self._app.presenter.state))
            window.show()  # también la pone delante si ya estaba visible
            if self._minimized:
                window.restore()

    def quit(self) -> None:
        """«Cerrar Erizo Coach» del menú de la bandeja: igual que cerrar la ventana."""
        if self._window is not None:
            self._window.destroy()

    def _on_loaded(self) -> None:
        self._loaded = True
        self.shown = True
        self._evaluate(render_script(self._app.presenter.state))

    def _on_minimized(self) -> None:
        self._minimized = True

    def _on_restored(self) -> None:
        self._minimized = False

    def _on_closed(self) -> None:
        self._loaded = False
        self._app.request_stop()

    async def _push(self, state: State) -> None:
        self._intro_on_launch(state)
        if self._loaded and not self._hidden:  # escondida no se repinta (ahorra trabajo)
            await asyncio.get_running_loop().run_in_executor(
                None, self._evaluate, render_script(state)
            )

    def _intro_on_launch(self, state: State) -> None:
        """Intro en el monitor principal cuando empieza a abrirse el LoL (una vez por clic)."""
        launch = state.get("launch", "")
        starting = launch == LaunchState.STARTING and not state.get("connected")
        if starting and self._launch != LaunchState.STARTING and self._settings.launch_intro:
            self._intro.play()
        self._launch = launch

    def _evaluate(self, script: str) -> None:
        try:
            self._window.evaluate_js(script)
        except Exception as exc:  # la ventana se está cerrando, etc.
            log.debug("No se pudo actualizar la ventana: %s", exc)


def _set_app_user_model_id() -> None:
    """Que Windows agrupe la ventana como «Erizo Coach» en la barra de tareas."""
    if sys.platform == "win32":
        import ctypes

        with contextlib.suppress(AttributeError, OSError):
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
