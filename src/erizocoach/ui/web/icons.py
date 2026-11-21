"""Iconos de objetos, campeones, runas y hechizos, sacados del propio cliente de LoL (con caché).

Solo se piden por tipo e id numérico, y solo de los recursos del juego
(``/lol-game-data/assets/``): no se puede usar para pedir otra cosa al cliente.
"""

from __future__ import annotations

from collections import OrderedDict

from ...gamedata.catalog import GameData, is_game_asset
from ...lcu.client import LcuError
from ...lcu.connector import LcuConnector

CACHE_SIZE = 400
CHAMPION_ICON = "/lol-game-data/assets/v1/champion-icons/{champion_id}.png"
KINDS = frozenset({"item", "champion", "perk", "style", "spell"})


class IconProvider:
    def __init__(self, gamedata: GameData, connector: LcuConnector | None) -> None:
        self._gamedata = gamedata
        self._connector = connector
        self._cache: OrderedDict[str, bytes] = OrderedDict()

    @property
    def gamedata(self) -> GameData:
        return self._gamedata

    def path_for(self, kind: str, ident: int) -> str | None:
        if kind == "item":
            item = self._gamedata.item(ident)
            path = item.icon_path if item else ""
            return path if is_game_asset(path) else None
        if kind == "champion" and ident > 0:
            return CHAMPION_ICON.format(champion_id=ident)
        if kind in KINDS:
            return self._gamedata.icon_path(kind, ident)
        return None

    async def get(self, kind: str, ident: int) -> bytes | None:
        if kind not in KINDS:
            return None
        path = self.path_for(kind, ident)
        if path is None:
            return None
        body = self._cache.get(path)
        if body is not None:
            self._cache.move_to_end(path)
            return body
        client = self._connector.client if self._connector else None
        if client is None:
            return None
        try:
            body = await client.get_bytes(path)
        except (LcuError, ValueError):
            return None
        self._cache[path] = body
        if len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return body
