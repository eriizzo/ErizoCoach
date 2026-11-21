"""Ficha de un objeto: descripción del cliente sin HTML, árbol de componentes y en qué orden
comprarlos, y por dónde la pide la ventana."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import aiohttp
import pytest

from erizocoach.bus import EventBus
from erizocoach.gamedata.catalog import GameData
from erizocoach.gamedata.itemtext import parse_description
from erizocoach.ui.desktop import DesktopBridge
from erizocoach.ui.web.icons import IconProvider
from erizocoach.ui.web.iteminfo import REASON_CHEAP, REASON_SAME, REASON_STATS, item_info
from erizocoach.ui.web.presenter import UiPresenter
from erizocoach.ui.web.server import UiServer

from .gamedata_fixture import fixture

# Descripciones reales del cliente (es_ES, parche 16.23)
INFINITY_EDGE = (
    "<mainText><stats><attention> 75</attention> de daño de ataque<br><attention> 25%</attention>"
    " de probabilidad de impacto crítico<br><attention> 30%</attention> de daño de impacto "
    "crítico</stats><br><br></mainText>"
)
ARCHANGEL = (
    "<mainText><stats><attention> 70</attention> de poder de habilidad<br><attention> 600"
    "</attention> de maná</stats><br><br><passive>Asombro</passive><br>Otorga poder de "
    "habilidad equivalente a un <scaleMana>1% del maná adicional.</scaleMana><br><br><passive>"
    "Flujo de maná</passive>  (8 s, máximo 5 cargas)<br>Asestar habilidades otorga <scaleMana>"
    "5 de maná máximo</scaleMana>.<br>Con <scaleMana>360 de maná máximo</scaleMana>, se "
    "convierte en <rarityLegendary>Abrazo del serafín</rarityLegendary>.</mainText>"
)
SERPENT = (
    "<mainText><stats><attention> 55</attention> de daño de ataque</stats><br><br><passive>"
    "Siegaescudos</passive><br>Reduce los escudos un 0% durante 3&nbsp;s. <br>Si no está "
    "afectado por <passive>Siegaescudos</passive>, reduces todos sus escudos.</mainText>"
)
ZHONYA = (
    "<mainText><stats><attention> 105</attention> de poder de habilidad</stats><br><br><br> <br>"
    "<active>Tiempo detenido</active><br>Entras en <keyword>estasis</keyword> durante 2.5 s."
    "</mainText>"
)


def test_stats_are_split_into_value_and_text() -> None:
    text = parse_description(INFINITY_EDGE)
    assert [(s.value, s.text) for s in text.stats] == [
        ("75", "de daño de ataque"),
        ("25%", "de probabilidad de impacto crítico"),
        ("30%", "de daño de impacto crítico"),
    ]
    assert text.blocks == ()


def test_passives_get_their_name_meta_and_coloured_text() -> None:
    text = parse_description(ARCHANGEL)
    first, second = text.blocks
    assert (first.kind, first.name, first.meta) == ("passive", "Asombro", "")
    assert [(r.text, r.tone) for r in first.runs] == [
        ("Otorga poder de habilidad equivalente a un ", ""),
        ("1% del maná adicional.", "scale"),
    ]
    assert (second.name, second.meta) == ("Flujo de maná", "(8 s, máximo 5 cargas)")
    assert ("Abrazo del serafín", "item") in [(r.text, r.tone) for r in second.runs]
    assert "\n" in "".join(r.text for r in second.runs)  # los <br> son saltos de línea


def test_a_passive_named_inside_the_text_is_not_a_new_block() -> None:
    (block,) = parse_description(SERPENT).blocks
    assert block.name == "Siegaescudos"
    runs = [(r.text, r.tone) for r in block.runs]
    assert ("Siegaescudos", "keyword") in runs
    assert "3 s" in "".join(r.text for r in block.runs)  # &nbsp; -> espacio


def test_actives_and_no_html_left() -> None:
    (block,) = parse_description(ZHONYA).blocks
    assert (block.kind, block.name) == ("active", "Tiempo detenido")
    joined = "".join(r.text for r in block.runs)
    assert joined == "Entras en estasis durante 2.5 s."
    hostile = parse_description('<mainText><img src=x onerror="alert(1)">hola<script>x</script>')
    texts = "".join(r.text for b in hostile.blocks for r in b.runs)
    assert "<" not in texts and ">" not in texts


def test_empty_or_odd_descriptions_do_not_break() -> None:
    assert parse_description("") == parse_description("<mainText></mainText>")
    assert parse_description("<stats></stats><br><br>").blocks == ()
    parse_description("<passive>sin cerrar<br>" * 50)  # no se cuelga ni falla


def gamedata_with(descriptions: dict[int, str]) -> GameData:
    data = fixture()
    items = [
        dict(item, description=descriptions.get(item["id"], ""), price=item.get("price", 0))
        for item in data["items"]
    ]
    gd = GameData()
    gd.load_static({**data, "items": items}, data["version"])
    return gd


def test_recipe_tree_and_buy_order() -> None:
    gd = gamedata_with({3031: INFINITY_EDGE})
    info = item_info(gd, 3031)  # Filo infinito = Espadón + Pico + Capa de agilidad
    assert info is not None
    assert info["name"] == "Filo infinito" and info["price"] == 3500 and info["combine"] == 725
    children = info["tree"]["children"]
    assert [c["id"] for c in children] == [1038, 1037, 1018]
    # Del más caro al más barato (ninguno trae pasiva)
    prices = [children[step["index"]]["price"] for step in info["order"]]
    assert prices == sorted(prices, reverse=True)
    assert info["order"][0]["reason"] == REASON_STATS
    assert info["order"][-1]["reason"] == REASON_CHEAP
    assert info["stats"][0] == {"value": "75", "text": "de daño de ataque"}


def test_a_component_with_its_own_passive_goes_first() -> None:
    gd = GameData()
    gd.load_static(fixture(), fixture()["version"])
    item = next(
        i
        for i in (gd.item(x["id"]) for x in fixture()["items"])
        if i is not None and len(set(i.from_ids)) >= 2
    )
    cheapest = min(item.from_ids, key=lambda c: gd.item(c).price_total)  # type: ignore[union-attr]
    gd = gamedata_with({cheapest: "<mainText><passive>Algo</passive><br>Hace cosas.</mainText>"})
    info = item_info(gd, item.id)
    assert info is not None
    first = info["tree"]["children"][info["order"][0]["index"]]
    assert first["id"] == cheapest
    assert "pasiva" in info["order"][0]["reason"]


def test_basic_items_have_no_recipe_but_say_what_they_build_into() -> None:
    info = item_info(gamedata_with({}), 1038)  # Espadón
    assert info is not None
    assert info["tree"]["children"] == [] and info["order"] == [] and info["combine"] == 0
    assert 3031 in [i["id"] for i in info["into"]]


def test_unknown_item() -> None:
    assert item_info(gamedata_with({}), 999_999) is None


@pytest.fixture
async def server() -> AsyncIterator[UiServer]:
    gd = gamedata_with({3031: INFINITY_EDGE})
    ui = UiServer(UiPresenter(EventBus(), gd), gd, None)
    await ui.start()
    try:
        yield ui
    finally:
        await ui.stop()


async def test_server_serves_the_sheet_only_with_the_key(server: UiServer) -> None:
    base = f"http://127.0.0.1:{server.port}"
    async with aiohttp.ClientSession() as http:
        assert (await http.get(base + "/item/3031.json")).status == 403
        assert (await http.get(base + "/item/3031.json?t=mala")).status == 403
        ok = await http.get(f"{base}/item/3031.json?t={server.token}")
        assert ok.status == 200
        assert (await ok.json())["name"] == "Filo infinito"
        assert ok.headers["Content-Security-Policy"].startswith("default-src 'none'")
        assert (await http.get(f"{base}/item/999999.json?t={server.token}")).status == 404
        assert (await http.get(f"{base}/item/abc.json?t={server.token}")).status == 404


@pytest.fixture
async def running_loop() -> AsyncIterator[asyncio.AbstractEventLoop]:
    yield asyncio.get_running_loop()


async def test_bridge_item_info_only_takes_numbers(
    running_loop: asyncio.AbstractEventLoop,
) -> None:
    gd = gamedata_with({3031: INFINITY_EDGE})
    bridge = DesktopBridge(UiPresenter(EventBus(), gd), IconProvider(gd, None), running_loop)
    # El puente se llama desde el hilo de la ventana; el bucle de la app es este.
    info = await asyncio.to_thread(bridge.item_info, 3031)
    assert info is not None and info["id"] == 3031
    for bad in ("3031", 3031.0, True, -1, 0, None, [3031]):
        assert await asyncio.to_thread(bridge.item_info, bad) is None


def test_two_equal_components_say_so() -> None:
    gd = gamedata_with({})
    item = next(
        i
        for i in (gd.item(x["id"]) for x in fixture()["items"])
        if i is not None and len(i.from_ids) == 2 and i.from_ids[0] == i.from_ids[1]
    )
    info = item_info(gd, item.id)
    assert info is not None
    assert info["order"][0]["reason"] == REASON_SAME
