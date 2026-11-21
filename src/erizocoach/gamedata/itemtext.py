"""La descripción de un objeto (``description`` de ``items.json``) en datos que la ventana
puede pintar sin HTML.

El cliente la da con etiquetas propias (``<stats>``, ``<passive>``, ``<magicDamage>``…).
Aquí se convierte en estadísticas y bloques (pasivas, activas y texto) con trozos de texto
marcados con un «tono» para colorearlos. La ventana solo pone texto (nunca HTML), así que
nada de la descripción se puede ejecutar ni inyectar.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

MAX_DESCRIPTION = 20_000  # las más largas rondan los 2.000 caracteres
MAX_BLOCKS = 12

_TAG = re.compile(r"<\s*(/?)\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>")
_SPACES = re.compile(r"[ \t\r\f\v]+")

# Etiqueta del cliente -> tono con el que se colorea en la ventana
TONES = {
    "magicdamage": "magic",
    "physicaldamage": "physical",
    "truedamage": "true",
    "healing": "heal",
    "lifesteal": "heal",
    "omnivamp": "heal",
    "health": "heal",
    "shield": "shield",
    "speed": "speed",
    "attackspeed": "speed",
    "ms": "speed",
    "gold": "gold",
    "keyword": "keyword",
    "keywordmajor": "keyword",
    "keywordstealth": "keyword",
    "status": "keyword",
    "onhit": "keyword",
    "spellname": "keyword",
    "passive": "keyword",  # una pasiva nombrada dentro del texto
    "active": "keyword",
    "raritylegendary": "item",
    "raritymythic": "item",
    "raritygeneric": "item",
    "rules": "note",
    "flavortext": "note",
    "danger": "danger",
}
SCALE_PREFIX = "scale"  # scaleAP, scaleMana, scaleHealth... -> "scale"
BLOCK_KINDS = {"passive": "passive", "active": "active"}


@dataclass(frozen=True, slots=True)
class Run:
    text: str
    tone: str = ""  # "" = texto normal


@dataclass(frozen=True, slots=True)
class Stat:
    value: str  # "75", "25%"
    text: str  # "de daño de ataque"


@dataclass(slots=True)
class Block:
    kind: str  # "passive", "active" o "text"
    name: str = ""
    meta: str = ""  # lo que va junto al nombre: «(8 s, máximo 5 cargas)»
    runs: list[Run] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.name and not any(r.text.strip() for r in self.runs)


@dataclass(frozen=True, slots=True)
class ItemText:
    stats: tuple[Stat, ...]
    blocks: tuple[Block, ...]


def _tone(tag: str) -> str:
    if tag.startswith(SCALE_PREFIX):
        return "scale"
    return TONES.get(tag, "")


def _clean(text: str) -> str:
    return _SPACES.sub(" ", html.unescape(text).replace("\xa0", " "))


def _tokens(description: str) -> list[tuple[str, str, bool]]:
    """(«text», texto, False) o («tag», nombre en minúsculas, cierra)."""
    out: list[tuple[str, str, bool]] = []
    pos = 0
    for match in _TAG.finditer(description):
        if match.start() > pos:
            out.append(("text", description[pos : match.start()], False))
        out.append(("tag", match.group(2).lower(), bool(match.group(1))))
        pos = match.end()
    if pos < len(description):
        out.append(("text", description[pos:], False))
    return out


def parse_description(description: str) -> ItemText:
    description = description[:MAX_DESCRIPTION]
    stats_html, rest = _split_stats(description)
    return ItemText(stats=_parse_stats(stats_html), blocks=_parse_blocks(rest))


def _split_stats(description: str) -> tuple[str, str]:
    match = re.search(r"<stats>(.*?)</stats>", description, re.IGNORECASE | re.DOTALL)
    if match is None:
        return "", description
    return match.group(1), description[: match.start()] + description[match.end() :]


def _parse_stats(stats_html: str) -> tuple[Stat, ...]:
    stats: list[Stat] = []
    for line in re.split(r"<br\s*/?>", stats_html, flags=re.IGNORECASE):
        value_match = re.search(r"<attention>(.*?)</attention>", line, re.IGNORECASE | re.DOTALL)
        value = _clean(_TAG.sub("", value_match.group(1))).strip() if value_match else ""
        rest = line[value_match.end() :] if value_match else line
        text = _clean(_TAG.sub("", rest)).strip()
        if value or text:
            stats.append(Stat(value, text))
    return tuple(stats)


def _parse_blocks(rest: str) -> tuple[Block, ...]:
    blocks: list[Block] = [Block("text")]
    tones: list[str] = []  # etiquetas abiertas con tono (la última manda)
    naming: str | None = None  # dentro del nombre de una pasiva o activa nueva
    name_parts: list[str] = []
    after_name = False  # justo tras el nombre: lo que siga en la línea es su «meta»

    def current() -> Block:
        return blocks[-1]

    def at_line_start() -> bool:
        runs = current().runs
        if not runs:
            return True
        tail = "".join(r.text for r in runs[-3:])
        return tail.rstrip(" ").endswith("\n") or not tail.strip()

    def add(text: str, tone: str) -> None:
        runs = current().runs
        if runs and runs[-1].tone == tone:
            runs[-1] = Run(runs[-1].text + text, tone)
        else:
            runs.append(Run(text, tone))

    for kind, value, closing in _tokens(rest):
        if kind == "text":
            text = _clean(value)
            if naming is not None:
                name_parts.append(text)
            elif after_name:
                current().meta = (current().meta + text).strip() if text.strip() else current().meta
            elif text:
                add(text, tones[-1] if tones else "")
            continue
        tag = value
        if tag == "br" or tag == "li":
            if naming is not None:
                continue
            after_name = False
            add("\n" if tag == "br" else "\n• ", "")
            continue
        if tag in BLOCK_KINDS and not closing and naming is None and at_line_start():
            naming = tag
            name_parts = []
            if len(blocks) < MAX_BLOCKS:
                blocks.append(Block(BLOCK_KINDS[tag]))
            continue
        if tag == naming and closing:
            current().name = "".join(name_parts).strip()
            naming = None
            after_name = True
            continue
        tone = _tone(tag)
        if not tone or naming is not None:
            continue
        if closing:
            if tone in tones:
                tones.reverse()
                tones.remove(tone)
                tones.reverse()
        else:
            tones.append(tone)
    for block in blocks:
        block.runs = _trimmed(block.runs)
        block.meta = block.meta.strip()
    return tuple(b for b in blocks if not b.empty)


def _trimmed(runs: list[Run]) -> list[Run]:
    """Sin saltos de línea ni espacios sobrantes al principio, al final o repetidos."""
    text_runs: list[Run] = []
    for run in runs:
        text = re.sub(r" *\n *", "\n", run.text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        if text_runs and text_runs[-1].text.endswith("\n") and text.startswith("\n"):
            text = text.lstrip("\n") if text_runs[-1].text.endswith("\n\n") else text[1:]
        if text:
            text_runs.append(Run(text, run.tone))
    while text_runs and not text_runs[0].text.strip():
        text_runs.pop(0)
    while text_runs and not text_runs[-1].text.strip():
        text_runs.pop()
    if text_runs:
        text_runs[0] = Run(text_runs[0].text.lstrip(), text_runs[0].tone)
        text_runs[-1] = Run(text_runs[-1].text.rstrip(), text_runs[-1].tone)
    return text_runs
