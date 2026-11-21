"""Ventana de escritorio: página incrustada, puente con la app y elección del modo."""

from __future__ import annotations

import asyncio
import base64
import json
import re
import threading
from pathlib import Path

import pytest

from erizocoach.__main__ import choose_ui_mode
from erizocoach.app import UiMode
from erizocoach.bus import EventBus
from erizocoach.config import Settings
from erizocoach.ui import desktop
from erizocoach.ui.desktop import DesktopBridge, build_html, render_script
from erizocoach.ui.web.presenter import UiPresenter

from .gamedata_fixture import loaded_gamedata

PNG = b"\x89PNG\r\n\x1a\nfalso"


class FakeIcons:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    async def get(self, kind: str, ident: int) -> bytes | None:
        self.calls.append((kind, ident))
        return PNG if ident == 3157 else None


@pytest.fixture
def running_loop():
    """Un bucle en otro hilo, como el de la app cuando la ventana ocupa el hilo principal."""
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


# --- Página -------------------------------------------------------------------------


def test_html_is_self_contained_with_strict_policy() -> None:
    html = build_html("NONCE123")
    assert 'data-mode="desktop"' in html
    assert 'src="/static' not in html and 'href="/static' not in html  # todo incrustado
    assert "/static/" not in html  # los logos de style.css también
    assert html.count("data:image/png;base64,iVBORw0KGgo") == 2  # el erizo grande y el pequeño
    csp = re.search(r'Content-Security-Policy" content="([^"]+)"', html)
    assert csp is not None
    policy = csp.group(1)
    assert "default-src 'none'" in policy and "connect-src 'none'" in policy
    assert "script-src 'nonce-NONCE123'" in policy and "img-src data:" in policy
    assert html.count('nonce="NONCE123"') == 2  # el estilo y el código, nada más


def test_each_launch_uses_a_new_nonce() -> None:
    first = re.search(r"nonce-([\w-]+)", build_html())
    second = re.search(r"nonce-([\w-]+)", build_html())
    assert first and second and first.group(1) != second.group(1)


def test_render_script_is_safe_json() -> None:
    script = render_script({"phaseLabel": "</script><b>hola</b>   ñ"})
    prefix = "window.erizocoach && window.erizocoach.render("
    payload = script.removeprefix(prefix).removesuffix(")")
    assert json.loads(payload)["phaseLabel"].startswith("</script>")
    assert "ñ" not in script and " " not in script  # solo ASCII


# --- Puente con la app -----------------------------------------------------------------


def test_bridge_returns_state_and_icons(running_loop: asyncio.AbstractEventLoop) -> None:
    presenter = UiPresenter(EventBus(), loaded_gamedata())
    icons = FakeIcons()
    bridge = DesktopBridge(presenter, icons, running_loop)  # type: ignore[arg-type]
    assert bridge.get_state()["phaseLabel"] == "Esperando al cliente de LoL"
    src = bridge.icon("item", "3157")
    assert src == "data:image/png;base64," + base64.b64encode(PNG).decode()
    assert bridge.icon("item", 1) is None  # no existe


@pytest.mark.parametrize(
    ("kind", "ident"),
    [("file", 1), ("item", "../../secreto"), ("item", -5), ("item", 10**9), ("champion", None)],
)
def test_bridge_rejects_anything_else(
    running_loop: asyncio.AbstractEventLoop, kind: object, ident: object
) -> None:
    icons = FakeIcons()
    bridge = DesktopBridge(UiPresenter(EventBus(), loaded_gamedata()), icons, running_loop)  # type: ignore[arg-type]
    assert bridge.icon(kind, ident) is None
    assert icons.calls == []  # ni siquiera se intenta


def test_bridge_exposes_only_eight_methods() -> None:
    public = [name for name in dir(DesktopBridge) if not name.startswith("_")]
    assert public == [
        "background", "get_state", "icon", "item_info", "launch_client", "set_runes",
        "set_spells", "update_app",
    ]  # fmt: skip


def test_bridge_update_app(running_loop: asyncio.AbstractEventLoop) -> None:
    from erizocoach.events import UpdateRequested, UpdateState, UpdateStatus

    bus = EventBus()
    seen: list[UpdateRequested] = []
    bus.subscribe(UpdateRequested, seen.append)
    bridge = DesktopBridge(UiPresenter(bus, loaded_gamedata()), FakeIcons(), running_loop)  # type: ignore[arg-type]
    assert not bridge.update_app()  # aún no hay versión nueva
    assert seen == []
    asyncio.run_coroutine_threadsafe(
        bus.publish(UpdateStatus("0.30.0", "", UpdateState.AVAILABLE)), running_loop
    ).result(timeout=5)
    assert bridge.update_app()
    assert len(seen) == 1


def test_bridge_set_spells_only_passes_two_spells(
    running_loop: asyncio.AbstractEventLoop,
) -> None:
    from erizocoach.events import SpellsEditRequested

    bus = EventBus()
    seen: list[SpellsEditRequested] = []
    bus.subscribe(SpellsEditRequested, seen.append)
    bridge = DesktopBridge(UiPresenter(bus, loaded_gamedata()), FakeIcons(), running_loop)  # type: ignore[arg-type]
    assert not bridge.set_spells({"spell1Id": 4, "spell2Id": "x"})
    assert bridge.set_spells({"spell1Id": 4, "spell2Id": 14})
    assert seen == [SpellsEditRequested((4, 14))]


def test_bridge_set_runes_only_passes_a_rune_page(
    running_loop: asyncio.AbstractEventLoop,
) -> None:
    from erizocoach.events import RunesEditRequested

    bus = EventBus()
    seen: list[RunesEditRequested] = []
    bus.subscribe(RunesEditRequested, seen.append)
    bridge = DesktopBridge(UiPresenter(bus, loaded_gamedata()), FakeIcons(), running_loop)  # type: ignore[arg-type]
    perks = [8112, 8139, 8140, 8106, 8226, 8210, 5005, 5008, 5011]
    assert not bridge.set_runes({"primaryStyleId": 8100, "subStyleId": 8200, "perkIds": "x"})
    assert not bridge.set_runes(None)
    assert seen == []
    assert bridge.set_runes({"primaryStyleId": 8100, "subStyleId": 8200, "perkIds": perks})
    assert len(seen) == 1 and list(seen[0].page.perk_ids) == perks


def test_bridge_background_calls_the_window_and_never_raises(
    running_loop: asyncio.AbstractEventLoop,
) -> None:
    presenter = UiPresenter(EventBus(), loaded_gamedata())
    calls: list[str] = []

    def hide() -> bool:
        calls.append("hide")
        return True

    def broken() -> bool:
        raise RuntimeError("la ventana se está cerrando")

    assert DesktopBridge(presenter, FakeIcons(), running_loop, hide).background() is True  # type: ignore[arg-type]
    assert calls == ["hide"]
    assert DesktopBridge(presenter, FakeIcons(), running_loop, broken).background() is False  # type: ignore[arg-type]
    assert DesktopBridge(presenter, FakeIcons(), running_loop).background() is False  # type: ignore[arg-type]


# --- Elección del modo ------------------------------------------------------------------


def settings(**changes: object) -> Settings:
    return Settings(data_dir=Path("."), **changes)  # type: ignore[arg-type]


def test_ui_mode_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(desktop, "desktop_available", lambda: True)
    assert choose_ui_mode(settings(), demo=False, browser=False) == UiMode.DESKTOP
    assert choose_ui_mode(settings(), demo=False, browser=True) == UiMode.BROWSER
    assert (
        choose_ui_mode(settings(window_mode="navegador"), demo=False, browser=False)
        == UiMode.BROWSER
    )
    assert choose_ui_mode(settings(window=False), demo=False, browser=False) == UiMode.NONE
    assert choose_ui_mode(settings(window=False), demo=True, browser=False) == UiMode.SERVER_ONLY


def test_falls_back_to_edge_without_webview2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(desktop, "desktop_available", lambda: False)
    assert choose_ui_mode(settings(), demo=False, browser=False) == UiMode.BROWSER


# --- Si la ventana de escritorio falla, se abre con Edge ---------------------------------


class FakeApp:
    created: list[UiMode] = []

    def __init__(self, _settings: Settings, *, demo: bool, ui_mode: UiMode) -> None:
        FakeApp.created.append(ui_mode)
        self.started = threading.Event()
        self.stopped = threading.Event()

    async def run(self) -> None:
        self.started.set()
        await asyncio.to_thread(self.stopped.wait, 5)

    def request_stop(self) -> None:
        self.stopped.set()


def broken_window(*, shown: bool) -> type:
    class BrokenWindow:
        def __init__(self, _app: object, _settings: Settings) -> None:
            self.shown = shown

        def run(self) -> None:
            raise RuntimeError("WebView2 no arranca")

    return BrokenWindow


def test_desktop_window_that_never_opens_falls_back_to_edge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from erizocoach import __main__ as entry

    monkeypatch.setattr(entry, "Application", FakeApp)
    monkeypatch.setattr(desktop, "DesktopWindow", broken_window(shown=False))
    assert entry.run_desktop(settings(), demo=False) is False


def test_errors_after_the_window_opened_are_not_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    from erizocoach import __main__ as entry

    monkeypatch.setattr(entry, "Application", FakeApp)
    monkeypatch.setattr(desktop, "DesktopWindow", broken_window(shown=True))
    with pytest.raises(RuntimeError):
        entry.run_desktop(settings(), demo=False)


def test_main_reopens_in_edge_when_the_desktop_window_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from erizocoach import __main__ as entry

    class OneShotApp(FakeApp):
        async def run(self) -> None:  # en modo Edge: arranca y se cierra enseguida
            self.started.set()

    FakeApp.created = []
    monkeypatch.setattr(entry, "load_settings", lambda **_kw: (Settings(data_dir=tmp_path), []))
    monkeypatch.setattr(entry, "setup_logging", lambda *_a, **_kw: None)
    monkeypatch.setattr(entry, "choose_ui_mode", lambda *_a, **_kw: UiMode.DESKTOP)
    monkeypatch.setattr(entry, "run_desktop", lambda *_a, **_kw: False)
    monkeypatch.setattr(entry, "Application", OneShotApp)
    assert entry.main([]) == 0
    assert FakeApp.created == [UiMode.BROWSER]
