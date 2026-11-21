"""Objetos del juego (``/lol-game-data/assets/v1/items.json``)."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from ..util import as_int, as_list, as_str

# Los objetos de la Grieta tienen id < 10000; los de otros modos (Arena, etc.) usan rangos altos.
RIFT_ITEM_ID_LIMIT = 10_000


@dataclass(frozen=True, slots=True)
class Item:
    id: int
    name: str
    price_total: int
    from_ids: tuple[int, ...]  # componentes
    into_ids: tuple[int, ...]  # objetos que lo usan como componente
    categories: frozenset[str]  # "SpellDamage", "Armor", "SpellBlock", "Boots"...
    in_store: bool
    display_in_item_sets: bool
    required_champion: str
    required_ally: str
    icon_path: str = ""  # ruta del icono en el cliente (/lol-game-data/assets/...)
    # Objeto del que sale al transformarse (Abrazo del serafín ← Bastón del arcángel); 0 = ninguno
    upgraded_from: int = 0
    description: str = ""  # texto del cliente con sus etiquetas (gamedata/itemtext.py lo lee)
    combine_cost: int = 0  # lo que cuesta juntar los componentes (el total sin ellos)

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> Item:
        return cls(
            id=as_int(data.get("id")),
            name=as_str(data.get("name")),
            price_total=as_int(data.get("priceTotal")),
            from_ids=tuple(as_int(i) for i in as_list(data.get("from"))),
            into_ids=tuple(as_int(i) for i in as_list(data.get("to"))),
            categories=frozenset(c for c in as_list(data.get("categories")) if isinstance(c, str)),
            in_store=bool(data.get("inStore")),
            display_in_item_sets=bool(data.get("displayInItemSets")),
            required_champion=as_str(data.get("requiredChampion")),
            required_ally=as_str(data.get("requiredAlly")),
            icon_path=as_str(data.get("iconPath")),
            upgraded_from=as_int(data.get("specialRecipe")),
            description=as_str(data.get("description")),
            combine_cost=as_int(data.get("price")),
        )

    @property
    def buyable(self) -> bool:
        """Se puede comprar en la tienda de la Grieta y mostrar en un conjunto de objetos."""
        return (
            0 < self.id < RIFT_ITEM_ID_LIMIT
            and self.in_store
            and self.display_in_item_sets
            and not self.required_champion
            and not self.required_ally
        )

    @property
    def is_boots(self) -> bool:
        return "Boots" in self.categories

    @property
    def is_upgraded_boots(self) -> bool:
        """Botas mejoradas (salen de otras). Las Botas y el Calzado ligeramente mágico de la
        runa no tienen receta: son las de base, aún sin mejorar."""
        return self.is_boots and bool(self.from_ids)

    @property
    def is_basic_boots(self) -> bool:
        return self.is_boots and not self.from_ids


MAX_UPGRADE_CHAIN = 5  # Atlas mundial → Brújula rúnica → Botín universal... (y contra bucles)


def with_upgraded(owned: Iterable[int], item: Callable[[int], Item | None]) -> set[int]:
    """Lo que tienes, contando también los objetos de los que salen tus objetos mejorados:
    con el Abrazo del serafín ya tienes tu Bastón del arcángel (se transformó)."""
    result: set[int] = set()
    for item_id in owned:
        current: int = item_id
        for _ in range(MAX_UPGRADE_CHAIN + 1):
            if current <= 0 or current in result:
                break
            result.add(current)
            found = item(current)
            current = found.upgraded_from if found is not None else 0
    return result
