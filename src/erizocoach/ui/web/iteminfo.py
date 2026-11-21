"""La ficha de un objeto que se abre al tocarlo en la ventana: su composición (árbol de
componentes), en qué orden comprar los componentes y todo lo que da (estadísticas,
pasivas y activas).

Se pide bajo demanda y por id numérico (no va en el estado que se repinta cada segundo).
"""

from __future__ import annotations

from typing import Any

from ...gamedata.catalog import GameData
from ...gamedata.items import Item
from ...gamedata.itemtext import parse_description

State = dict[str, Any]

MAX_DEPTH = 3  # objeto -> componente -> componente básico (no hay más niveles en la tienda)
MAX_INTO = 8

REASON_POWER = "Tiene {what} propia: la notas nada más comprarlo"
REASON_STATS = "El componente más caro: más estadísticas desde la primera vuelta a base"
REASON_CHEAP = "El más barato: para cuando vuelvas con poco oro"
REASON_THEN = "Después"
REASON_SAME = "Son iguales: empieza por cualquiera"


def item_info(gd: GameData, item_id: int) -> State | None:
    item = gd.item(item_id)
    if item is None:
        return None
    text = parse_description(item.description)
    return {
        "id": item.id,
        "name": item.name,
        "price": item.price_total,
        "combine": item.combine_cost if item.from_ids else 0,
        "tree": _tree(gd, item, 0, set()),
        "order": component_order(gd, item),
        "stats": [{"value": s.value, "text": s.text} for s in text.stats],
        "blocks": [
            {
                "kind": b.kind,
                "name": b.name,
                "meta": b.meta,
                "runs": [{"text": r.text, "tone": r.tone} for r in b.runs],
            }
            for b in text.blocks
        ],
        "into": [
            {"id": i.id, "name": i.name, "price": i.price_total}
            for i in sorted(
                (x for x in map(gd.item, item.into_ids) if x is not None and x.buyable),
                key=lambda x: (x.price_total, x.id),
            )[:MAX_INTO]
        ],
    }


def _tree(gd: GameData, item: Item, depth: int, path: set[int]) -> State:
    node: State = {"id": item.id, "name": item.name, "price": item.price_total, "children": []}
    if depth >= MAX_DEPTH or item.id in path:  # contra recetas en bucle
        return node
    for child_id in item.from_ids:
        child = gd.item(child_id)
        if child is not None:
            node["children"].append(_tree(gd, child, depth + 1, path | {item.id}))
    return node


def _has_power(item: Item) -> str:
    """«pasiva» o «activa» si el componente trae una (Lágrima, Brillo, Ascuas de Bami...)."""
    for block in parse_description(item.description).blocks:
        if block.kind == "passive":
            return "pasiva"
        if block.kind == "active":
            return "activa"
    return ""


def component_order(gd: GameData, item: Item) -> list[State]:
    """En qué orden comprar los componentes directos: ``[{"index", "reason"}]``, con
    ``index`` la posición en la receta (puede haber dos iguales, como dos Varas).

    Primero los que traen pasiva o activa propia (se notan al momento: Lágrima de la
    diosa, Brillo...), luego del más caro al más barato: el caro da más estadísticas ya,
    y los baratos caben en una vuelta a base con poco oro."""
    parts = [(index, gd.item(child_id)) for index, child_id in enumerate(item.from_ids)]
    known = [(index, child) for index, child in parts if child is not None]
    if not known:
        return []
    powers = {index: _has_power(child) for index, child in known}
    ranked = sorted(
        known,
        key=lambda p: (not powers[p[0]], -p[1].price_total, p[0]),
    )
    order: list[State] = []
    for position, (index, child) in enumerate(ranked):
        if position == 0:
            power = powers[index]
            twin = len(ranked) > 1 and ranked[1][1].id == child.id
            reason = (
                REASON_POWER.format(what=power) if power else REASON_SAME if twin else REASON_STATS
            )
        elif position == len(ranked) - 1 and child.price_total < ranked[0][1].price_total:
            reason = REASON_CHEAP
        else:
            reason = REASON_THEN
        order.append({"index": index, "reason": reason})
    return order
