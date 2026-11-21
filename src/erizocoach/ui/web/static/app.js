"use strict";

// La ventana solo pinta el estado que le envía Erizo Coach. Funciona de dos formas:
// * Escritorio (pywebview): puente directo con la app, sin servidor ni red.
// * Navegador (respaldo): servidor local con websocket.
// Todo el texto se inserta con textContent (nunca como HTML).

const DESKTOP = document.documentElement.dataset.mode === "desktop";
const token = new URLSearchParams(location.search).get("t") || "";
const app = document.getElementById("app");
const iconCache = new Map(); // escritorio: clave -> imagen incrustada (o promesa)
let retries = 0;
let socket = null;    // navegador: canal con la app (también para cambiar las runas)
let lastState = null; // para repintar al tocar el editor de runas sin esperar a la app

// La app llama a window.erizocoach.render(estado) cuando algo cambia (escritorio).
window.erizocoach = { render: (state) => render(state) };

function startDesktop() {
  window.addEventListener("pywebviewready", async () => {
    setConnection(true);
    setupBackground();
    render(await window.pywebview.api.get_state());
  });
}

// Botón «Segundo plano»: la app esconde la ventana y sigue trabajando (solo escritorio;
// en el navegador no hay icono en la bandeja con el que volver).
function setupBackground() {
  const button = document.getElementById("to-background");
  if (!button || !window.pywebview.api.background) return;
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    let ok = false;
    try { ok = await window.pywebview.api.background(); } catch { ok = false; }
    if (ok) {
      button.disabled = false;
      button.blur(); // al volver, que no se quede marcado
    } else {
      button.title = "No disponible: Windows no ha dejado poner el icono de Erizo Coach junto al reloj.";
    }
  });
}

function setIcon(img, kind, id) {
  if (!DESKTOP) {
    img.src = `/icon/${kind}/${id}.png`;
    return;
  }
  const key = `${kind}:${id}`;
  const cached = iconCache.get(key);
  if (typeof cached === "string") {
    if (cached) img.src = cached;
    return;
  }
  const api = window.pywebview && window.pywebview.api;
  if (!api) return;
  const pending = cached || api.icon(kind, id)
    .then((src) => { iconCache.set(key, src || ""); return src || ""; })
    .catch(() => { iconCache.delete(key); return ""; });
  iconCache.set(key, pending);
  pending.then((src) => { if (src) img.src = src; });
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
  socket.onopen = () => { retries = 0; setConnection(true); };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") render(message.state);
  };
  socket.onclose = () => {
    setConnection(false);
    setTimeout(connect, Math.min(1000 * 2 ** retries++, 10000));
  };
}

function setConnection(on) {
  document.getElementById("connection").className = on ? "dot on" : "dot off";
  setText("connection-text", on ? "Conectado a Erizo Coach" : "Sin conexión con Erizo Coach (¿está abierto?)");
}

// --- Movimiento ----------------------------------------------------------------------
// La ventana se repinta entera en cada actualización (cada ~3 s en partida), así que solo
// se anima lo que CAMBIA respecto a lo pintado antes: la entrada al cambiar de pantalla,
// el oro, la compra recomendada, lo que acabas de comprar y los jugadores que cambian de
// estado. Siempre transform/opacity (las compone la GPU) y nada en bucle.
// Con «reducir movimiento» de Windows, los desplazamientos y rebotes pasan a ser fundidos
// cortos (no se quita todo: así nada aparece de golpe).

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const EASE_OUT = "cubic-bezier(.16, 1, .3, 1)";   // llegadas suaves
const EASE_POP = "cubic-bezier(.34, 1.56, .64, 1)"; // un rebote discreto

let memory = { view: null, phase: null, gold: null, buyId: null, canBuy: false, progress: 0, owned: new Set(), players: new Map() };
let seen = memory; // lo que se está pintando ahora; al terminar pasa a ser `memory`
let queue = [];    // animaciones que se lanzan cuando el DOM nuevo ya está en la página

function motion(fn) { queue.push(fn); }

function animate(node, keyframes, options) {
  if (!node || !node.animate) return null;
  try { return node.animate(keyframes, options); } catch { return null; }
}

// Animación completa, o un fundido de ≤150 ms si el usuario pidió reducir el movimiento.
function move(node, keyframes, options) {
  if (!reducedMotion.matches) return animate(node, keyframes, options);
  const hasFade = keyframes.some((frame) => "opacity" in frame);
  if (!hasFade || options.pseudoElement) return null;
  const opacities = keyframes.map((frame) => ({ opacity: frame.opacity ?? 1 }));
  return animate(node, opacities, { duration: 150, delay: Math.min(options.delay || 0, 150), easing: "ease-out", fill: options.fill });
}

function countUp(node, from, to, duration = 650) {
  if (reducedMotion.matches || from === to) { node.textContent = String(to); return; }
  const start = performance.now();
  node.textContent = String(from);
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    node.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Al cambiar de pantalla: las tarjetas entran escalonadas y su contenido les sigue.
function playEntrance() {
  [...app.children].forEach((card, index) => {
    const delay = index * 80;
    move(card, [{ opacity: 0, transform: "translateY(16px) scale(.98)" }, { opacity: 1, transform: "none" }],
      { duration: 560, delay, easing: EASE_OUT, fill: "backwards" });
    const parts = card.querySelectorAll(".player, .rune-page .rune-line, .rune-page .tree-head, .rune-page .shard-row, .spells, .icons > .item-tile, .situational .entry, .buy-body, .components, .hero > div, .empty > :not(.emblem)");
    parts.forEach((part, order) => move(part, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
      { duration: 420, delay: delay + 140 + Math.min(order, 10) * 35, easing: EASE_OUT, fill: "backwards" }));
    // Un destello dorado recorre los nombres de los objetos y de la piedra angular, uno tras otro.
    if (!reducedMotion.matches) {
      card.querySelectorAll(".item-name, .rune-line.keystone .rune-name").forEach((name, order) =>
        animate(name, [{ backgroundPosition: "100% 0" }, { backgroundPosition: "0 0" }],
          { duration: 1100, delay: delay + 420 + Math.min(order, 14) * 70, easing: "ease-in-out" }));
    }
  });
}

// --- Utilidades de DOM -----------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Cambia un texto solo si es distinto (así los lectores de pantalla no lo repiten).
function setText(id, text) {
  const node = document.getElementById(id);
  if (node && node.textContent !== text) node.textContent = text;
}

function classes(...names) {
  return names.filter(Boolean).join(" ");
}

// Icono de un objeto. `label`: con su nombre debajo, siempre a la vista. Tocarlo abre su
// ficha (composición y qué comprar primero); dejarlo pulsado, todo lo que da (ver itemSheet).
function itemIcon(item, { big = false, owned = false, next = false, count = 1, label = false } = {}) {
  if (!item) return null;
  const price = item.price ? ` (${item.price} de oro)` : "";
  const status = owned ? ", ya comprado" : next ? ", siguiente compra" : "";
  const img = el("img", { alt: label ? "" : owned ? `${item.name} (comprado)` : item.name });
  setIcon(img, "item", item.id);
  const icon = el("span", { class: classes("icon", big && "big", owned && "owned", next && "next") }, [
    img,
    count > 1 ? el("span", { class: "count", text: `x${count}` }) : null,
  ]);
  const says = `${item.name}${price}${status}. Toca para ver su composición; déjalo pulsado para ver todo lo que da`;
  const tile = el("span", {
    class: classes("item-tile", label && "labeled"), role: "button", tabindex: "0",
    "aria-label": says, title: `${item.name}${price}`, "data-focus-key": `item:${item.id}`,
  }, [icon, label ? el("span", { class: "item-name", "aria-hidden": "true", text: item.name }) : null]);
  tile.icon = icon; // para animar el icono (compras) sin tocar el nombre
  pressable(tile, item);
  return tile;
}

function championIcon(id, name, { big = false } = {}) {
  const className = classes("icon", "champ", big && "big");
  if (!id) return el("span", { class: className });
  const img = el("img", { alt: name });
  setIcon(img, "champion", id);
  return el("span", { class: className, title: name }, [img]);
}

// Tarjeta de vidrio con título y, opcionalmente, un dato a la derecha del título.
function card(title, children, { className = "", extra = null } = {}) {
  return el("section", { class: classes("card", className) }, [
    el("div", { class: "card-head" }, [el("h2", { text: title }), extra]),
    ...children,
  ]);
}

// 24300 -> "24,3k" (sin signo: para totales)
function goldAmount(gold) {
  return goldText(gold).slice(1);
}

function goldText(diff) {
  const abs = Math.abs(diff);
  const text = abs >= 1000 ? `${(abs / 1000).toFixed(1).replace(".", ",")}k` : `${abs}`;
  return `${diff >= 0 ? "+" : "−"}${text}`;
}

function bulletList(items) {
  return el("ul", { class: "list" }, items.map((text) => el("li", { text })));
}

function originLine(source, fallback) {
  const text = source && source.startsWith("estadísticas") ? `Base: ${source}` : `Base: ${fallback}`;
  return el("div", { class: "muted small origin", text });
}

// --- Vistas ------------------------------------------------------------------------

function viewOf(state) {
  if (state.game) return "game";
  if (state.champion || state.loadout || state.build || state.counters || state.bans) return "champ";
  return state.connected ? "menu" : "offline";
}

// `boot`: el estado provisional del arranque se pinta sin animar; la entrada la hace el primero real.
function render(state, boot = false) {
  lastState = state;
  if (press && !boot) { pressDeferred = true; return; } // pulsando un objeto: se repinta al soltarlo
  const view = viewOf(state);
  const phase = state.phaseLabel || "";
  seen = { view: boot ? null : view, entering: !boot && view !== memory.view, phase, gold: null, buyId: null, canBuy: false, progress: 0, owned: new Set(), players: new Map() };
  queue = [];

  setText("phase", phase);
  document.getElementById("phase").title = phase; // por si no cabe entera
  setText("clock", state.game ? state.game.time : "");
  setText("version", state.version ? `v${state.version}` : "");
  if (!boot && memory.phase !== null && memory.phase !== phase) {
    motion(() => move(document.getElementById("phase"), [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }],
      { duration: 260, easing: EASE_OUT }));
  }

  let sections;
  if (view === "game") sections = renderGame(state);
  else if (view === "champ") sections = renderChampSelect(state);
  else sections = [renderIdle(state)];
  if (state.stats && state.stats.problem) {
    sections.unshift(card("Aviso", [el("div", { text: state.stats.text })], { className: "notice wide" }));
  }
  if (updateShown(state)) sections.unshift(renderUpdate(state.update));
  // Se repinta todo: el botón que tenías enfocado (teclado) recupera el foco.
  const focused = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.focusKey : null;
  app.replaceChildren(...sections.filter(Boolean));
  if (focused) {
    const again = app.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  if (seen.entering) motion(playEntrance);
  for (const run of queue) run();
  memory = seen;
}

function renderIdle(state) {
  const choosing = state.connected && state.phase === "ChampSelect";
  const title = choosing ? "Selección de campeones"
    : state.connected ? "Esperando a la selección de campeones" : "Esperando al cliente de LoL";
  const hint = choosing
    ? "Preselecciona o mira un campeón y verás aquí sus runas y hechizos. Se ponen solos al hacerse el último pick."
    : state.connected
      ? "En la selección verás las runas y hechizos del campeón que preselecciones; al último pick se ponen solos, con tu build. Durante la partida, qué comprar y quién va fuerte."
      : "Ábrelo con este botón o como siempre: Erizo Coach se conectará solo.";
  const stats = state.stats && !state.stats.problem ? el("div", { class: "small stats", text: state.stats.text }) : null;
  const emblem = el("span", { class: "emblem", "aria-hidden": "true" });
  if (seen.entering) {
    // El emblema se «arma» una vez: el anillo gira un cuarto de vuelta y el erizo aparece.
    motion(() => {
      move(emblem, [{ transform: "rotate(-90deg)" }, { transform: "none" }], { duration: 1400, easing: EASE_OUT, pseudoElement: "::before" });
      move(emblem, [{ opacity: 0, transform: "translateY(10px) scale(.6)" }, { opacity: 1, transform: "none" }],
        { duration: 700, delay: 200, easing: EASE_POP, fill: "backwards", pseudoElement: "::after" });
    });
  }
  // Abriendo el LoL: la animación ocupa el sitio del título (no hace falta leer nada más).
  const opening = !state.connected && state.launch === "starting";
  if (!opening) launchStartedAt = null;
  return el("section", { class: "card empty wide" }, [
    emblem,
    opening ? null : el("h2", { class: "big", text: title }),
    opening ? null : el("div", { class: "hint", text: hint }),
    state.connected ? null : opening ? renderLaunchShow() : renderLaunch(state.launch),
    stats,
  ]);
}

// Botón «Abrir League of Legends» (con el cliente cerrado). La app abre el cliente de Riot
// igual que su acceso directo; al conectar, esta tarjeta cambia sola.
const LAUNCH_NOTES = {
  starting: "Puede tardar un poco (más si se actualiza). Erizo Coach se conectará solo.",
  notFound: "No encuentro el cliente de Riot en este PC. Ábrelo tú y Erizo Coach se conectará solo.",
  failed: "Windows no ha dejado abrirlo. Prueba otra vez o ábrelo tú.",
};

function renderLaunch(launch) {
  const button = el("button", { class: "cta", type: "button" }, [
    svgGlyph("M5.5 3.5v9l7-4.5z"),
    el("span", { text: "Abrir League of Legends" }),
  ]);
  button.addEventListener("click", launchClient);
  const note = LAUNCH_NOTES[launch];
  return el("div", { class: "launch" }, [
    button,
    note ? el("div", { class: "small warn", role: "status", text: note }) : null,
  ]);
}

// Animación «LEAGUE OF LEGENDS» mientras se abre. Es CSS: como la ventana se repinta entera
// a menudo, cada repintado le dice cuánto lleva (`--since`, negativo) y sigue donde iba en
// vez de empezar de nuevo.
let launchStartedAt = null;

function renderLaunchShow() {
  if (launchStartedAt === null) launchStartedAt = performance.now();
  const show = el("div", { class: "launch-show", role: "status", "aria-label": "Abriendo League of Legends" }, [
    el("div", { class: "ls-rings", "aria-hidden": "true" }),
    el("div", { class: "ls-eyebrow", "aria-hidden": "true", text: "Abriendo" }),
    showLine("LEAGUE", "ls-big", 0),
    showLine("OF LEGENDS", "ls-small", 6),
    el("div", { class: "ls-bar", "aria-hidden": "true" }, [el("span")]),
    el("div", { class: "small muted ls-note", text: LAUNCH_NOTES.starting }),
  ]);
  // Por CSSOM y no con el atributo style: la CSP de la ventana no deja estilos en línea.
  show.style.setProperty("--since", `${(-(performance.now() - launchStartedAt) / 1000).toFixed(3)}s`);
  return show;
}

function showLine(text, size, first) {
  const letters = [...text].map((ch, i) => {
    const letter = el("span", { class: "ls-ch", text: ch === " " ? " " : ch });
    letter.style.setProperty("--i", String(first + i));
    return letter;
  });
  return el("div", { class: `ls-line ${size}`, "data-text": text, "aria-hidden": "true" }, letters);
}

function svgGlyph(path) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "glyph");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function launchClient() {
  if (DESKTOP) {
    const api = window.pywebview && window.pywebview.api;
    if (api && api.launch_client) api.launch_client().catch(() => {});
  } else if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "launchClient" }));
  }
}

// --- Actualización de Erizo Coach ------------------------------------------------------
// Solo se ofrece con el cliente cerrado o en una fase en la que cerrar la app no molesta
// (nunca en selección ni en partida). Copia de SAFE_PHASES en update/service.py: un test
// comprueba que las dos listas coinciden. La app lo vuelve a comprobar antes de instalar.
const UPDATE_SAFE_PHASES = ["None", "Lobby", "EndOfGame"];

function updateShown(state) {
  return Boolean(state.update) && (!state.connected || UPDATE_SAFE_PHASES.includes(state.phase));
}

function renderUpdate(update) {
  const children = [];
  if (update.state === "downloading") {
    const percent = Math.max(0, Math.min(100, Math.round(update.progress || 0)));
    const fill = el("span", { class: "fill" });
    fill.style.setProperty("--p", (percent / 100).toFixed(2));
    children.push(
      el("div", { class: "small", text: `Descargando… ${percent} %` }),
      el("div", {
        class: "meter", role: "progressbar", "aria-label": "Descarga de la actualización",
        "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent),
      }, [fill]),
    );
  } else if (update.state === "installing") {
    children.push(el("div", { role: "status", text: "Instalando… Erizo Coach se volverá a abrir solo" }));
  } else {
    if (update.notes) children.push(el("div", { class: "update-notes small", text: update.notes }));
    if (update.state === "failed" && update.error) {
      children.push(el("div", { class: "small warn", role: "alert", text: update.error }));
    }
    const button = el("button", { class: "cta", type: "button", "data-focus-key": "update-app" }, [
      svgGlyph("M8 2.5v7M4.8 6.8 8 10l3.2-3.2M3.5 12.5h9"),
      el("span", { text: "Actualizar" }),
    ]);
    button.addEventListener("click", updateApp);
    children.push(el("div", { class: "update-action" }, [button]));
  }
  return card(`Erizo Coach ${update.version} disponible`, children, { className: "update wide" });
}

function updateApp() {
  if (DESKTOP) {
    const api = window.pywebview && window.pywebview.api;
    if (api && api.update_app) api.update_app().catch(() => {});
  } else if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "updateApp" }));
  }
}

function renderChampSelect(state) {
  const counters = state.counters ? renderCounters(state.counters) : null;
  const choosing = state.counters && !state.counters.locked;
  return [
    state.bans ? renderBans(state.bans) : null, // te toca banear: lo primero, a quién
    choosing ? counters : null, // aún eliges: lo primero, qué te puedes coger
    state.champion ? renderHero(state) : null,
    choosing ? null : counters,
    state.loadout ? renderLoadout(state.loadout, state) : null,
    state.build ? renderBuild(state.build) : null,
  ];
}

// Baneos recomendados para el campeón que preseleccionas: los rivales de tu línea que más
// te ganan, por lo a menudo que te tocan (de las partidas de alto elo).
function renderBans(bans) {
  const mine = bans.champion;
  const rows = bans.picks.map((pick, index) => {
    const says = `Banea a ${pick.name}: con ${mine.name} ganas el ${pick.winRate} % contra él `
      + `(${pick.wins} de ${pick.games} partidas de alto elo) y te toca en el ${pick.share} % `
      + "de tus partidas";
    return el("li", { class: "counter weak ban", title: says, "aria-label": says }, [
      el("span", { class: "ban-rank", "aria-hidden": "true", text: `${index + 1}` }),
      championIcon(pick.id, pick.name),
      el("div", { class: "counter-who" }, [
        el("span", { class: "counter-name", text: pick.name }),
        el("small", { class: "muted", text: `${pick.share} % de tus partidas` }),
      ]),
      el("span", { class: "counter-rate", "aria-hidden": "true", text: `${pick.winRate} %` }),
    ]);
  });
  const extra = el("span", { class: "counter-enemy" }, [
    mine.position ? el("span", { class: "tag", text: mine.position }) : null,
    championIcon(mine.id, mine.name),
  ]);
  return card(`A quién banear con ${mine.name}`, [
    el("ol", { class: "counters" }, rows),
    el("div", {
      class: "muted small",
      text: "Tus victorias contra él en alto elo. Primero los que más te ganan y más salen; "
        + "sin los ya baneados ni lo que miran tus aliados.",
    }),
  ], { className: "wide counters-card bans-card", extra });
}

// Counters contra tu rival de línea (de las partidas de alto elo) o, si ya has elegido,
// cómo va tu enfrentamiento.
function counterRow(pick, enemyName) {
  const says = `${pick.name} gana el ${pick.winRate} % contra ${enemyName} `
    + `(${pick.wins} de ${pick.games} partidas de alto elo; con pocas partidas se acerca a su media)`;
  const strength = pick.winRate >= 55 ? "strong" : pick.winRate < 48 ? "weak" : "";
  return el("li", { class: classes("counter", strength), title: says, "aria-label": says }, [
    championIcon(pick.id, pick.name),
    el("div", { class: "counter-who" }, [
      el("span", { class: "counter-name", text: pick.name }),
      el("small", { class: "muted", text: `${pick.games} partidas` }),
    ]),
    el("span", { class: "counter-rate", "aria-hidden": "true", text: `${pick.winRate} %` }),
  ]);
}

function renderCounters(counters) {
  const enemy = counters.enemy;
  const title = counters.locked ? `Tu enfrentamiento contra ${enemy.name}` : `Counters contra ${enemy.name}`;
  const extra = el("span", { class: "counter-enemy" }, [
    enemy.position ? el("span", { class: "tag", text: enemy.position }) : null,
    championIcon(enemy.id, enemy.name),
  ]);
  let body;
  if (counters.locked) {
    body = [el("ul", { class: "counters" }, [counterRow(counters.mine, enemy.name)])];
  } else {
    body = [
      el("ul", { class: "counters" }, counters.picks.map((p) => counterRow(p, enemy.name))),
      el("div", { class: "muted small", text: "Victorias en tu línea contra él en alto elo. Solo campeones que puedes elegir." }),
    ];
  }
  return card(title, body, { className: "wide counters-card", extra });
}

function renderHero(state) {
  const champion = state.champion;
  const archetype = state.build && state.build.archetype;
  const portrait = championIcon(champion.id, champion.name, { big: true });
  if (seen.entering) {
    motion(() => move(portrait, [{ opacity: 0, transform: "scale(.7) rotate(-8deg)" }, { opacity: 1, transform: "none" }],
      { duration: 700, delay: 120, easing: EASE_POP, fill: "backwards" }));
  }
  return el("section", { class: "card lens hero wide" }, [
    portrait,
    el("div", {}, [
      el("h2", { class: "name", text: champion.name }),
      el("div", { class: "meta" }, [
        champion.position ? el("span", { class: "tag", text: champion.position }) : null,
        champion.preview ? el("span", { class: "tag preview", text: "Previsión" }) : null,
        archetype ? el("span", { text: archetype }) : null,
      ]),
    ]),
  ]);
}

// --- Runas: la página con sus imágenes y el editor ------------------------------------
// Al tocar una runa en el editor, la página se cambia aquí al momento (borrador) y se envía
// a la app, que la valida y la escribe en tu página «Erizo Coach» del cliente. El borrador se
// enseña hasta que la app confirma (o 4 s, si algo falla: entonces vuelve lo que hay).

const SEND_DELAY = 350; // varios clics seguidos = un solo envío
const runeEditor = { open: false, pending: null, until: 0, timer: 0, problem: "" };

function gameIcon(kind, id, name, className) {
  const img = el("img", { alt: name || "" });
  if (id) setIcon(img, kind, id);
  return el("span", { class: classes("rune", className), title: name || "" }, [img]);
}

function samePerks(a, b) {
  return a.primaryStyleId === b.primaryStyleId && a.subStyleId === b.subStyleId
    && a.perkIds.length === b.perkIds.length && a.perkIds.every((id, i) => id === b.perkIds[i]);
}

function pageFromState(page) {
  return { primaryStyleId: page.primaryStyle.id, subStyleId: page.subStyle.id, perkIds: page.perkIds.slice() };
}

// La página que se enseña: tu borrador mientras la app lo pone; si no, la del estado.
function shownPage(loadout) {
  if (!loadout.page) return null;
  const real = pageFromState(loadout.page);
  const draft = runeEditor.pending;
  const failed = loadout.problem && loadout.problem !== runeEditor.problem;
  if (draft && (samePerks(draft, real) || Date.now() > runeEditor.until || failed)) {
    runeEditor.pending = null;
  }
  return runeEditor.pending || real;
}

function renderLoadout(loadout, state) {
  const catalog = state.runeCatalog;
  const page = shownPage(loadout);
  const names = catalog ? catalog.names : {};
  const name = (id) => names[id] || "";
  const styleName = (id) => {
    const style = catalog && catalog.styles.find((s) => s.id === id);
    return style ? style.name : "";
  };
  const children = [
    loadout.status ? el("div", { class: classes("small", "status-line", loadout.runesBy && "applied"), text: loadout.status }) : null,
    loadout.problem ? el("div", { class: "small problem", role: "alert", text: loadout.problem }) : null,
    originLine(loadout.source, "recomendación de Riot (aún sin datos suficientes de partidas reales)"),
  ];
  if (page && loadout.page) {
    const perks = page.perkIds;
    const fallback = loadout.page; // nombres por si aún no hay catálogo
    const perkName = (index, fromState) => name(perks[index]) || fromState.name;
    // Cada runa con su nombre a la vista, como la página del cliente: un árbol por columna.
    const line = (index, fromState, kind) => {
      const label = perkName(index, fromState);
      return el("div", { class: classes("rune-line", kind) }, [
        gameIcon("perk", perks[index], "", kind),
        el("span", { class: "rune-name", text: label }),
      ]);
    };
    const head = (styleId, fromState) => el("div", { class: "tree-head" }, [
      gameIcon("style", styleId, "", "style"),
      el("span", { class: "tree-name", text: styleName(styleId) || fromState.name }),
    ]);
    children.push(el("div", { class: "rune-page" }, [
      el("div", { class: "tree primary" }, [
        head(page.primaryStyleId, fallback.primaryStyle),
        line(0, fallback.keystone, "keystone"),
        ...[1, 2, 3].map((i) => line(i, fallback.primary[i - 1] || {}, "minor")),
      ]),
      el("div", { class: "tree secondary" }, [
        head(page.subStyleId, fallback.subStyle),
        ...[4, 5].map((i) => line(i, fallback.secondary[i - 4] || {}, "minor")),
        el("div", { class: "shard-row" }, [6, 7, 8].map((i) => el("span", { class: "shard-chip" }, [
          gameIcon("perk", perks[i], "", "shard"),
          el("span", { class: "shard-name", text: perkName(i, fallback.shards[i - 6] || {}) }),
        ]))),
      ]),
    ]));
  }
  if (loadout.spells.length) {
    const canEditSpells = Boolean(loadout.spells.length === 2 && state.connected
      && state.phase === "ChampSelect" && state.spellCatalog && state.spellCatalog.length);
    children.push(...renderSpells(loadout, state, canEditSpells));
  }
  if (loadout.laneOpponent) children.push(el("div", { class: "muted small", text: `Rival de línea probable: ${loadout.laneOpponent}` }));
  const canEdit = Boolean(loadout.editable && catalog && page && state.connected && state.phase === "ChampSelect");
  if (loadout.options && loadout.options.length > 1) children.push(renderRuneOptions(loadout.options, page, canEdit));
  if (canEdit) {
    const toggle = el("button", {
      class: "ghost edit-toggle", type: "button", "data-focus-key": "edit-toggle",
      "aria-expanded": runeEditor.open ? "true" : "false",
      text: runeEditor.open ? "Cerrar el editor" : "Cambiar runas",
    });
    toggle.addEventListener("click", () => { runeEditor.open = !runeEditor.open; render(lastState); });
    children.push(toggle);
    if (runeEditor.open) children.push(renderRuneEditor(page, catalog));
  } else if (!loadout.editable || state.phase !== "ChampSelect") {
    runeEditor.open = false;
  }
  const extra = [...loadout.adjustments, ...loadout.notes];
  if (extra.length) children.push(bulletList(extra));
  return card(loadout.preview && !loadout.runesBy ? "Runas y hechizos (previsión)" : "Runas y hechizos", children,
    { className: "loadout" });
}

// --- Hechizos: toca el de la D o el de la F y elige otro (como en el cliente: si eliges el
// que ya está en la otra tecla, se intercambian). Se ponen al momento en tu selección.

const SPELL_KEYS = ["D", "F"];
const spellEditor = { slot: -1, pending: null, until: 0 };

function shownSpells(loadout) {
  const real = loadout.spells.map((s) => s.id);
  const draft = spellEditor.pending;
  if (draft && ((draft[0] === real[0] && draft[1] === real[1]) || Date.now() > spellEditor.until)) {
    spellEditor.pending = null;
  }
  return spellEditor.pending || real;
}

function sendSpells(ids) {
  spellEditor.pending = ids;
  spellEditor.until = Date.now() + 4000;
  const spells = { spell1Id: ids[0], spell2Id: ids[1] };
  if (DESKTOP) {
    const api = window.pywebview && window.pywebview.api;
    if (api && api.set_spells) api.set_spells(spells).catch(() => {});
  } else if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "setSpells", spells }));
  }
  render(lastState);
}

// Aplastar: obligatorio en la jungla y prohibido en las demás posiciones (lo comprueba también
// la app antes de escribir nada en el cliente).
function smiteProblem(spells, state) {
  const hasSmite = spells.includes(state.smiteId);
  if (state.spellRule === "required" && !hasSmite) return "en la jungla Aplastar es obligatorio";
  if (state.spellRule === "forbidden" && hasSmite) return "Aplastar solo yendo a la jungla";
  return "";
}

function renderSpells(loadout, state, canEdit) {
  const ids = shownSpells(loadout);
  const names = {};
  for (const s of [...(state.spellCatalog || []), ...loadout.spells]) names[s.id] = s.name;
  if (!canEdit) spellEditor.slot = -1;
  const slots = ids.map((id, i) => {
    const key = el("span", { class: "key", "aria-hidden": "true", text: SPELL_KEYS[i] });
    if (!canEdit) return el("span", { class: "spell-slot", title: `${SPELL_KEYS[i]}: ${names[id] || ""}` }, [gameIcon("spell", id, names[id], "spell"), key]);
    const picking = spellEditor.slot === i;
    const button = el("button", {
      type: "button", class: classes("spell-slot", "editable", picking && "picking"),
      "aria-expanded": picking ? "true" : "false", "data-focus-key": `spell-slot:${i}`,
      "aria-label": `Cambiar el hechizo de la ${SPELL_KEYS[i]} (ahora ${names[id] || "?"})`,
      title: `Cambiar el hechizo de la ${SPELL_KEYS[i]}`,
    }, [gameIcon("spell", id, "", "spell"), key]);
    button.addEventListener("click", () => { spellEditor.slot = picking ? -1 : i; render(lastState); });
    return button;
  });
  const yours = loadout.spellsBy === "you_in_app" || loadout.spellsBy === "you_in_client";
  const parts = [el("div", { class: "spells" }, [
    el("span", { class: "section-label inline", text: "Hechizos" }),
    ...slots,
    yours ? el("span", { class: "small muted", text: "Tuyos: Erizo Coach no los toca" })
      : canEdit && spellEditor.slot < 0 ? el("span", { class: "small muted", text: "Toca uno para cambiarlo" }) : null,
  ])];
  if (canEdit && spellEditor.slot >= 0) {
    const slot = spellEditor.slot;
    parts.push(el("div", { class: "spell-picker", role: "group", "aria-label": `Elige el hechizo de la ${SPELL_KEYS[slot]}` },
      state.spellCatalog.map((s) => {
        const selected = ids[slot] === s.id;
        const next = ids.slice();
        const other = 1 - slot;
        if (next[other] === s.id) next[other] = next[slot]; // ya estaba en la otra tecla: se cambian
        next[slot] = s.id;
        const why = selected ? "" : smiteProblem(next, state);
        const button = el("button", {
          type: "button", class: classes("rune-option", "spell-option", selected && "selected", why && "blocked"),
          "aria-pressed": selected ? "true" : "false", "aria-disabled": why ? "true" : null,
          "aria-label": why ? `${s.name}: ${why}` : s.name, title: why ? `${s.name}: ${why}` : s.name,
          "data-focus-key": `spell:${s.id}`,
        }, [gameIcon("spell", s.id, "", "")]);
        button.addEventListener("click", () => {
          if (selected || why) return;
          spellEditor.slot = -1;
          sendSpells(next);
        });
        return button;
      })));
    if (state.spellRule) {
      parts.push(el("div", { class: "small muted", text: state.spellRule === "required"
        ? "Vas a la jungla: Aplastar tiene que ir en la D o en la F."
        : "No vas a la jungla: sin Aplastar." }));
    }
  }
  return parts;
}

// Hasta 3 páginas con piedras angulares distintas: tocar una la pone en el cliente.
function renderRuneOptions(options, page, canEdit) {
  const buttons = options.map((option, index) => {
    const choice = pageFromState(option.page);
    const selected = Boolean(page && samePerks(choice, page));
    const keystone = option.page.keystone;
    const button = el("button", {
      type: "button", class: classes("rune-choice", selected && "selected"),
      "aria-pressed": selected ? "true" : "false", disabled: canEdit ? null : "true",
      "data-focus-key": `option:${index}`,
      title: canEdit ? `Poner ${keystone.name} en el cliente` : keystone.name,
    }, [
      gameIcon("perk", keystone.id, "", "choice-keystone"),
      el("span", { class: "choice-text" }, [
        el("span", { class: "choice-name", text: keystone.name }),
        el("span", { class: "choice-detail", text: option.detail }),
      ]),
    ]);
    if (canEdit) button.addEventListener("click", () => { if (!selected) sendRunes(choice); });
    return button;
  });
  return el("div", { class: "rune-choices" }, [
    el("div", { class: "section-label", text: canEdit ? "Elige una de estas páginas" : "Otras páginas posibles" }),
    el("div", { class: "choice-row", role: "group", "aria-label": "Páginas de runas para elegir" }, buttons),
  ]);
}

function styleOf(catalog, id) {
  return catalog.styles.find((s) => s.id === id);
}

function rowIn(style, perkId) {
  return style ? style.rows.findIndex((row) => row.includes(perkId)) : -1;
}

// Cambios del editor: siempre devuelven una página válida (como hace el cliente).
function withPrimary(catalog, page, styleId) {
  const style = styleOf(catalog, styleId);
  if (!style || styleId === page.primaryStyleId) return page;
  let sub = page.subStyleId;
  const allowed = (id) => id !== styleId && styleOf(catalog, id) && (!style.allowedSub.length || style.allowedSub.includes(id));
  if (!allowed(sub)) sub = (catalog.styles.find((s) => allowed(s.id)) || {}).id;
  const subStyle = styleOf(catalog, sub);
  if (!subStyle) return page;
  const secondary = sub === page.subStyleId ? page.perkIds.slice(4, 6) : [subStyle.rows[1][0], subStyle.rows[2][0]];
  return { primaryStyleId: styleId, subStyleId: sub, perkIds: [...style.rows.map((row) => row[0]), ...secondary, ...page.perkIds.slice(6)] };
}

function withSub(catalog, page, styleId) {
  const style = styleOf(catalog, styleId);
  if (!style || styleId === page.subStyleId || styleId === page.primaryStyleId) return page;
  const perks = page.perkIds.slice();
  perks[4] = style.rows[1][0];
  perks[5] = style.rows[2][0];
  return { ...page, subStyleId: styleId, perkIds: perks };
}

function withPrimaryRune(page, row, perkId) {
  const perks = page.perkIds.slice();
  perks[row] = perkId; // fila 0 = piedra angular (índice 0); filas 1-3 = índices 1-3
  return { ...page, perkIds: perks };
}

function withSecondaryRune(catalog, page, perkId) {
  const style = styleOf(catalog, page.subStyleId);
  const picks = page.perkIds.slice(4, 6);
  if (picks.includes(perkId)) return page;
  const row = rowIn(style, perkId);
  const sameRow = picks.findIndex((id) => rowIn(style, id) === row);
  if (sameRow >= 0) picks[sameRow] = perkId;
  else { picks.shift(); picks.push(perkId); } // como el cliente: se va la más antigua
  const perks = page.perkIds.slice();
  perks.splice(4, 2, ...picks);
  return { ...page, perkIds: perks };
}

function withShard(page, row, perkId) {
  const perks = page.perkIds.slice();
  perks[6 + row] = perkId;
  return { ...page, perkIds: perks };
}

function sendRunes(page) {
  runeEditor.pending = page;
  runeEditor.problem = (lastState && lastState.loadout && lastState.loadout.problem) || "";
  runeEditor.until = Date.now() + 4000;
  clearTimeout(runeEditor.timer);
  runeEditor.timer = setTimeout(() => {
    const draft = runeEditor.pending;
    if (!draft) return;
    runeEditor.until = Date.now() + 4000;
    if (DESKTOP) {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.set_runes) api.set_runes(draft).catch(() => {});
    } else if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "setRunes", page: draft }));
    }
  }, SEND_DELAY);
  render(lastState);
}

function optionButton(kind, id, label, selected, onPick, size, group) {
  const button = el("button", {
    type: "button", class: classes("rune-option", size, selected && "selected"),
    "aria-pressed": selected ? "true" : "false", "aria-label": label, title: label,
    "data-focus-key": `${group}|${id}`,
  }, [gameIcon(kind, id, "", "")]);
  button.addEventListener("click", () => { if (!selected) onPick(); });
  return button;
}

function optionRow(label, options) {
  // options: [kind, id, etiqueta, elegida, al elegir, tamaño]
  return el("div", { class: "editor-row", role: "group", "aria-label": label },
    options.map((o) => optionButton(...o, label)));
}

function renderRuneEditor(page, catalog) {
  const name = (id) => catalog.names[id] || `Runa ${id}`;
  const primary = styleOf(catalog, page.primaryStyleId);
  const sub = styleOf(catalog, page.subStyleId);
  if (!primary || !sub) return null;
  const perks = page.perkIds;
  const pick = (next) => sendRunes(next);
  const rowLabels = ["Piedra angular", "Fila 1", "Fila 2", "Fila 3"];

  const primaryTrees = optionRow("Árbol principal", catalog.styles.map((s) =>
    ["style", s.id, `Árbol principal: ${s.name}`, s.id === primary.id, () => pick(withPrimary(catalog, page, s.id)), "tree-option"]));
  const primaryRows = primary.rows.map((row, r) => optionRow(`${primary.name}: ${rowLabels[r]}`, row.map((id) =>
    ["perk", id, name(id), perks[r] === id, () => pick(withPrimaryRune(page, r, id)), r === 0 ? "keystone-option" : "minor-option"])));
  const subTrees = optionRow("Árbol secundario", catalog.styles.filter((s) => s.id !== primary.id).map((s) =>
    ["style", s.id, `Árbol secundario: ${s.name}`, s.id === sub.id, () => pick(withSub(catalog, page, s.id)), "tree-option"]));
  const subRows = sub.rows.slice(1).map((row, r) => optionRow(`${sub.name}: ${rowLabels[r + 1]}`, row.map((id) =>
    ["perk", id, name(id), perks[4] === id || perks[5] === id, () => pick(withSecondaryRune(catalog, page, id)), "minor-option"])));
  const shardRows = catalog.shards.map((row, r) => optionRow(`Fragmentos: fila ${r + 1}`, row.map((id) =>
    ["perk", id, name(id), perks[6 + r] === id, () => pick(withShard(page, r, id)), "shard-option"])));

  return el("div", { class: "rune-editor" }, [
    el("div", { class: "muted small", text: "Toca una runa: se cambia al momento en tu página «Erizo Coach» del cliente." }),
    el("div", { class: "editor-columns" }, [
      el("div", { class: "editor-tree" }, [el("div", { class: "section-label", text: "Principal" }), primaryTrees, ...primaryRows]),
      el("div", { class: "editor-tree" }, [
        el("div", { class: "section-label", text: "Secundario (elige 2)" }), subTrees, ...subRows,
        el("div", { class: "section-label", text: "Fragmentos" }), ...shardRows,
      ]),
    ]),
  ]);
}

function renderBuild(build) {
  const labeled = (i, extra = {}) => itemIcon(i, { label: true, ...extra });
  const children = [
    originLine(build.source, "reglas por tipo de campeón (aún sin datos suficientes de partidas reales)"),
    el("div", { class: "section-label", text: "Inicio" }),
    el("div", { class: "icons" }, build.starting.map((i) => labeled(i, { count: i.count }))),
    el("div", { class: "section-label", text: "Núcleo, en orden" }),
    el("div", { class: "icons" }, build.core.flatMap((item, index) => [
      index ? el("span", { class: "arrow", "aria-hidden": "true", text: "›" }) : null, labeled(item),
    ])),
    el("div", { class: "section-label", text: "Build completa" }),
    el("div", { class: "icons" }, build.full.map((i) => labeled(i))),
  ];
  if (build.situational.length) {
    children.push(el("div", { class: "section-label", text: "Contra este equipo" }));
    children.push(el("div", { class: "situational" }, build.situational.map((s) =>
      el("div", { class: "entry" }, [itemIcon(s), el("span", { class: "small", text: s.reason })]))));
  }
  children.push(el("div", { class: "muted small hint-line", text: "Toca un objeto: su composición. Déjalo pulsado: todo lo que da." }));
  if (build.notes.length) children.push(bulletList(build.notes));
  return card("Build", children); // el arquetipo ya se ve junto a tu campeón
}

function renderGame(state) {
  const game = state.game;
  const team = game.team || [game.me, ...game.allies].filter(Boolean);
  return [
    renderPurchase(game),
    game.buildProgress.length ? renderProgress(game) : null,
    // Una fila por línea: tu compañero a la izquierda, su rival a la derecha y la diferencia
    // de oro en medio. Sin líneas (otros modos), las dos listas de siempre.
    ...(game.matchups && game.matchups.length ? [renderMatchups(game.matchups, game.teamGold)] : [
      team.length ? card("Tu equipo", [renderPlayers(team, game.me, "ally")]) : null,
      game.enemies.length ? card("Rivales", [renderPlayers(game.enemies, null, "enemy")]) : null,
    ]),
  ];
}

function renderCoins(gold) {
  const before = memory.gold;
  seen.gold = gold;
  const amount = el("span", { class: "amount", text: String(gold) });
  const coins = el("span", { class: "coins" }, [amount, el("small", { text: "de oro" })]);
  if (!seen.entering && before !== null && before !== gold) {
    motion(() => {
      countUp(amount, before, gold);
      if (gold - before >= 150) {
        move(coins, [{ transform: "scale(1)" }, { transform: "scale(1.45)" }, { transform: "scale(1)" }],
          { duration: 520, easing: EASE_OUT, pseudoElement: "::before" });
      }
    });
  }
  return coins;
}

function renderPurchase(game) {
  const next = game.next;
  const coins = renderCoins(game.gold);
  if (!next) {
    return card("Compra ahora", [el("div", { class: "muted", text: game.message || "Sin recomendación de compra en este modo." })],
      { className: "lens wide", extra: coins });
  }
  const sameItem = memory.buyId === next.id;
  const newItem = !sameItem && !seen.entering;
  const becameReady = sameItem && next.canBuy && !memory.canBuy;
  const progress = next.canBuy ? 1 : next.price > 0 ? Math.min(1, Math.max(0, 1 - next.remaining / next.price)) : 0;
  seen.buyId = next.id;
  seen.canBuy = next.canBuy;
  seen.progress = progress;
  if (!sameItem || becameReady) {
    // Solo se anuncia lo que cambia de verdad, no cada actualización del oro.
    setText("announce", `Compra ahora: ${next.name}. ${next.canBuy ? "Te llega el oro." : `Te faltan ${next.remaining} de oro.`}`);
  }

  // Objetos iniciales: el principal en grande y lo demás (pociones...) al lado, con su cantidad.
  const icon = next.starting && next.starting.length > 1
    ? el("span", { class: "starting-icons" },
      next.starting.map((s, i) => itemIcon(s, { big: i === 0, count: s.count })))
    : itemIcon(next, { big: true });
  const name = el("div", { class: "name", text: next.name });
  const verdict = next.canBuy
    ? el("div", { class: "verdict ok", text: "Te llega el oro: ¡cómpralo!" })
    : el("div", { class: "verdict warn", text: `Te faltan ${next.remaining} de oro` });
  const fill = el("span", { class: "fill" });
  fill.style.setProperty("--p", progress.toFixed(3));
  const halo = el("span", { class: "halo", "aria-hidden": "true" });
  const components = next.components.length
    ? el("div", { class: "components" }, [el("span", { class: "small muted", text: "Ya puedes comprar:" }),
      ...next.components.map((c) => itemIcon(c, { label: true }))])
    : null;

  // El oro líquido sube desde donde estaba (o desde vacío si el objeto es nuevo).
  const from = seen.entering || !sameItem ? 0 : memory.progress;
  if (from !== progress) {
    const level = (p) => `translateX(${(Math.max(p, 0.03) - 1) * 100}%)`;
    motion(() => move(fill, [{ transform: level(from) }, { transform: level(progress) }],
      { duration: seen.entering ? 900 : 650, delay: seen.entering ? 320 : 0, easing: EASE_OUT, fill: "backwards" }));
  }
  if (newItem) {
    motion(() => {
      move(icon, [{ opacity: 0, transform: "scale(.6) rotate(-8deg)" }, { opacity: 1, transform: "none" }], { duration: 560, easing: EASE_POP });
      move(name, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: 80, easing: EASE_OUT, fill: "backwards" });
    });
  }
  if (next.canBuy && (newItem || becameReady)) {
    motion(() => {
      move(verdict, [{ opacity: 0.4, transform: "scale(.9)" }, { opacity: 1, transform: "scale(1.05)" }, { opacity: 1, transform: "none" }],
        { duration: 520, delay: 120, easing: EASE_OUT, fill: "backwards" });
      // Dos latidos en 1,7 s (lejos de los 3 destellos/s de WCAG); con movimiento reducido, uno solo.
      if (reducedMotion.matches) animate(halo, [{ opacity: 0 }, { opacity: 0.9 }, { opacity: 0 }], { duration: 700, easing: "ease-in-out" });
      else animate(halo, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0.15 }, { opacity: 0.85 }, { opacity: 0 }], { duration: 1700, easing: "ease-in-out" });
    });
  }

  const section = card("Compra ahora", [
    el("div", { class: "buy" }, [
      icon,
      el("div", { class: "buy-body" }, [
        name,
        verdict,
        el("div", { class: "meter", "aria-hidden": "true" }, [fill]),
        el("div", { class: "reason", text: next.reason }),
      ]),
    ]),
    components,
  ], { className: classes("lens", "wide", next.canBuy && "ready", (newItem || becameReady) && "fresh"), extra: coins });
  section.append(halo);
  return section;
}

function renderProgress(game) {
  const nextId = game.next ? game.next.id : null;
  const owned = game.buildProgress.filter((item) => item.owned).length;
  const icons = game.buildProgress.map((item) => {
    const tile = itemIcon(item, { owned: item.owned, next: item.id === nextId, label: true });
    const icon = tile.icon;
    if (!item.owned) return tile;
    seen.owned.add(item.id);
    if (!seen.entering && memory.view === "game" && !memory.owned.has(item.id)) {
      // Recién comprado: el icono se apaga con suavidad y le salta el ✓.
      motion(() => {
        move(icon.firstChild, [{ opacity: 1, filter: "saturate(1)", transform: "scale(1.18)" }, { opacity: 0.42, filter: "saturate(.35)", transform: "none" }],
          { duration: 700, easing: EASE_OUT });
        move(icon, [{ transform: "scale(0)" }, { transform: "scale(1)" }], { duration: 480, delay: 160, easing: EASE_POP, fill: "backwards", pseudoElement: "::after" });
      });
    }
    return tile;
  });
  return card("Tu build", [el("div", { class: "icons" }, icons)], {
    className: "wide",
    extra: el("span", { class: "extra", text: `${owned} de ${game.buildProgress.length} comprados` }),
  });
}

function renderPlayers(players, me, side) {
  return el("ul", { class: "players" }, players.map((p) => playerRow(p, me, side)));
}

// `mirror`: el rival, de derecha a izquierda (su icono pegado al borde de fuera).
// `showGold`: la diferencia de oro en la fila (en el enfrentamiento por líneas va en medio).
function playerRow(p, me, side, { mirror = false, showGold = true, tag = "li" } = {}) {
  const tags = [
    p.me || p === me ? el("span", { class: "tag", text: "Tú" }) : null,
    p.lane ? el("span", { class: "tag lane", text: "Tu rival" }) : null,
    p.damage === "AP" ? el("span", { class: "tag dmg-ap", text: "AP" }) : null,
    p.damage === "AD" ? el("span", { class: "tag dmg-ad", text: "AD" }) : null,
  ];
  const stats = el("div", { class: "stats" }, [
    el("span", { class: "kda", text: p.kda }),
    el("span", { text: `${p.cs} CS` }),
    el("span", { text: `Nv ${p.level}` }),
    p.dead && p.respawn ? el("span", { class: "respawn", text: `reaparece en ${p.respawn} s` }) : null,
  ]);
  // Frente a su rival de posición; si no se sabe quién es (otro modo), frente a la media.
  const vsLane = p.laneGoldDiff !== null && p.laneGoldDiff !== undefined;
  const diff = vsLane ? p.laneGoldDiff : p.goldDiff;
  const goldClass = diff > 400 ? "gold up" : diff < -400 ? "gold down" : "gold";
  const goldTitle = vsLane
    ? `Oro total frente a ${p.laneRival}, su rival de posición`
    : "Oro total frente a la media de la partida";
  const badge = el("span", { class: `badge ${p.strength}`, text: p.strengthLabel });
  const parts = [
    championIcon(p.championId, p.name),
    el("div", { class: "who" }, [el("div", { class: "title" }, [p.name, ...tags]), stats]),
    el("div", { class: "right" }, [
      badge,
      showGold ? el("span", { class: goldClass, title: goldTitle }, [
        `${goldText(diff)} oro`,
        vsLane ? el("small", { class: "versus", text: ` vs ${p.laneRival}` }) : null,
      ]) : null,
    ]),
  ];
  const row = el(tag, { class: classes("player", p.strength, p.dead && "dead", mirror && "mirror") },
    mirror ? parts.reverse() : parts);

  const key = `${side}:${p.championId || p.name}`;
  const before = memory.players.get(key);
  seen.players.set(key, { strength: p.strength, dead: Boolean(p.dead) });
  if (before && !seen.entering) {
    if (before.strength !== p.strength) {
      // Cambia de estado: la fila se ilumina con su color y la etiqueta salta.
      motion(() => {
        animate(row, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }],
          { duration: reducedMotion.matches ? 600 : 1300, easing: "ease-out", pseudoElement: "::after" });
        move(badge, [{ transform: "scale(.6)" }, { transform: "none" }], { duration: 480, easing: EASE_POP });
      });
    }
    if (before.dead !== Boolean(p.dead)) {
      motion(() => animate(row, [{ opacity: before.dead ? 0.55 : 1 }, { opacity: p.dead ? 0.55 : 1 }],
        { duration: reducedMotion.matches ? 150 : 450, easing: "ease-out" }));
    }
  }
  return row;
}

// Enfrentamientos: cada línea con la diferencia de oro en medio, vista desde tu equipo.
// La flecha apunta a quien lleva más oro en objetos.
// Cabecera de «Líneas»: el oro total de cada equipo y la diferencia, como en la retransmisión.
function renderTeamGold(teamGold) {
  if (!teamGold) {
    return el("div", { class: "matchup-head", "aria-hidden": "true" }, [
      el("span", { text: "Tu equipo" }), el("span", { text: "Oro" }), el("span", { text: "Rivales" }),
    ]);
  }
  const diff = teamGold.mine - teamGold.theirs;
  const even = Math.abs(diff) < 150;
  const state = even ? "even" : diff > 0 ? "ahead" : "behind";
  const says = even ? "Los dos equipos van igualados en oro"
    : diff > 0 ? `Tu equipo lleva ${Math.abs(diff)} de oro más`
      : `Los rivales llevan ${Math.abs(diff)} de oro más`;
  const total = (teamGold.mine + teamGold.theirs) || 1;
  const allyShare = Math.min(0.80, Math.max(0.20, teamGold.mine / total));
  const meter = el("div", { class: "team-gold-meter", "aria-hidden": "true" }, [
    el("div", { class: classes("meter-bar ally", state) }),
    el("div", { class: "meter-divider" }),
    el("div", { class: classes("meter-bar enemy", state) }),
  ]);
  meter.style.setProperty("--ally-pct", `${(allyShare * 100).toFixed(1)}%`);

  return el("div", { class: "matchup-head team-gold", role: "group", "aria-label": says, title: says }, [
    el("span", { "aria-hidden": "true" }, ["Tu equipo ", el("b", { text: goldAmount(teamGold.mine) })]),
    el("span", { class: classes("gap-value", state), "aria-hidden": "true" }, [
      diff > 0 && !even ? el("span", { class: "arrow", text: "◀" }) : null,
      el("span", { text: even ? "=" : goldAmount(Math.abs(diff)) }),
      diff < 0 && !even ? el("span", { class: "arrow", text: "▶" }) : null,
    ]),
    el("span", { "aria-hidden": "true" }, [el("b", { text: goldAmount(teamGold.theirs) }), " Rivales"]),
    meter,
  ]);
}

function setupBrandCheer() {
  const brand = document.querySelector(".brand");
  if (!brand || brand.dataset.cheerBound) return;
  brand.dataset.cheerBound = "true";
  brand.setAttribute("role", "button");
  brand.setAttribute("tabindex", "0");
  brand.title = "¡Haz clic en el erizo!";
  const cheers = [
    "¡A pinchar rivales! 🦔✨",
    "¡Erizo Coach a tu lado!",
    "¡Hoy se gana!",
    "¡Buena suerte en la Grieta!",
    "¡Build optimizada!",
  ];
  let cheerIndex = 0;
  let toastTimer = null;
  const triggerCheer = () => {
    brand.classList.remove("cheer");
    void brand.offsetWidth;
    brand.classList.add("cheer");
    setTimeout(() => brand.classList.remove("cheer"), 750);

    const msg = cheers[cheerIndex % cheers.length];
    cheerIndex++;
    let toast = document.getElementById("erizo-toast");
    if (!toast) {
      toast = el("div", { id: "erizo-toast", class: "erizo-toast", "aria-live": "polite" });
      document.body.append(toast);
    }
    toast.textContent = msg;
    toast.classList.remove("show");
    void toast.offsetWidth;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  };
  brand.addEventListener("click", triggerCheer);
  brand.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      triggerCheer();
    }
  });
}

function renderMatchups(matchups, teamGold) {
  const rows = matchups.map((m) => {
    const ally = m.ally ? playerRow(m.ally, null, "ally", { showGold: false, tag: "div" }) : el("div", { class: "player empty-seat" });
    const enemy = m.enemy ? playerRow(m.enemy, null, "enemy", { mirror: true, showGold: false, tag: "div" }) : el("div", { class: "player empty-seat" });
    const diff = m.goldDiff;
    let middle;
    if (diff === null || diff === undefined) {
      middle = el("div", { class: "gap" }, [el("span", { class: "lane-name", text: m.position || "" })]);
    } else {
      const even = Math.abs(diff) < 150;
      const state = even ? "even" : diff > 0 ? "ahead" : "behind";
      const amount = even ? "=" : goldText(Math.abs(diff)).replace("+", "");
      const allyName = m.ally.name;
      const enemyName = m.enemy.name;
      const says = even ? `${allyName} y ${enemyName} van igualados en oro`
        : diff > 0 ? `${allyName} lleva ${Math.abs(diff)} de oro más que ${enemyName}`
          : `${enemyName} lleva ${Math.abs(diff)} de oro más que ${allyName}`;
      middle = el("div", { class: classes("gap", state), title: says, "aria-label": says }, [
        el("span", { class: "lane-name", "aria-hidden": "true", text: m.position || "" }),
        el("span", { class: "gap-value", "aria-hidden": "true" }, [
          diff > 0 && !even ? el("span", { class: "arrow", text: "◀" }) : null,
          el("span", { text: amount }),
          diff < 0 && !even ? el("span", { class: "arrow", text: "▶" }) : null,
        ]),
      ]);
    }
    return el("li", { class: "matchup" }, [ally, middle, enemy]);
  });
  return card("Líneas", [
    renderTeamGold(teamGold),
    el("ul", { class: "matchups" }, rows),
  ], { className: "wide lanes" });
}

// Las animaciones en bucle (rueda, erizo, brillos) solo se mueven con la ventana delante
// o con el ratón encima: cada una obliga a repintar el vidrio a la tasa de refresco
// (~30 % de un núcleo). En segundo plano, mientras juegas, se quedan quietas.
function setupStillWhenAway() {
  const root = document.documentElement;
  let hovered = false;
  const update = () => root.classList.toggle("still", document.hidden || !(document.hasFocus() || hovered));
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  root.addEventListener("pointerenter", () => { hovered = true; update(); });
  root.addEventListener("pointerleave", () => { hovered = false; update(); });
  update();
}

// --- Ficha de un objeto ----------------------------------------------------------------
// Tocar un objeto abre su composición (árbol de componentes, que se dibuja animado, y en qué
// orden comprarlos). Dejarlo pulsado (o clic derecho) abre todo lo que da: estadísticas,
// pasivas y activas. Las dos cosas están en la misma ficha, en dos pestañas.
// La ficha vive fuera de #app: los repintados de cada segundo no la tocan.

const LONG_PRESS = 450; // ms
let press = null; // { id, timer, tile } mientras se mantiene pulsado un objeto
let pressDeferred = false; // llegó un estado mientras pulsabas: se pinta al soltar
let suppressClickUntil = 0; // tras una pulsación larga, el clic de soltar no cuenta
const itemInfoCache = new Map(); // id -> ficha (o promesa)
const sheet = { node: null, id: 0, tab: "recipe", back: [], trigger: "" };

function pressable(tile, item) {
  tile.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    endPress();
    press = { id: item.id, tile, timer: 0 };
    tile.classList.add("pressing");
    press.timer = setTimeout(() => {
      if (!press || press.id !== item.id) return;
      suppressClickUntil = performance.now() + 900;
      endPress();
      openItem(item, "details", tile);
    }, LONG_PRESS);
  });
  const cancel = () => { if (press && press.tile === tile) endPress(); };
  tile.addEventListener("pointerleave", cancel);
  tile.addEventListener("pointercancel", cancel);
  // Al soltar, se repinta después del clic: si se repintara antes, el clic se perdería.
  tile.addEventListener("pointerup", () => setTimeout(cancel, 0));
  tile.addEventListener("click", (event) => {
    event.preventDefault();
    if (performance.now() < suppressClickUntil) return;
    openItem(item, "recipe", tile);
  });
  tile.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    endPress();
    if (performance.now() < suppressClickUntil) return;
    openItem(item, "details", tile);
  });
  tile.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openItem(item, event.shiftKey ? "details" : "recipe", tile);
  });
}

function endPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press.tile.classList.remove("pressing");
  press = null;
  if (pressDeferred && lastState) {
    pressDeferred = false;
    render(lastState); // lo que llegó mientras pulsabas
  }
}

function fetchItemInfo(id) {
  const cached = itemInfoCache.get(id);
  if (cached) return Promise.resolve(cached);
  let request;
  if (DESKTOP) {
    const api = window.pywebview && window.pywebview.api;
    request = api && api.item_info ? api.item_info(id) : Promise.resolve(null);
  } else {
    request = fetch(`/item/${id}.json?t=${encodeURIComponent(token)}`)
      .then((response) => (response.ok ? response.json() : null));
  }
  const pending = Promise.resolve(request)
    .then((info) => { if (info) itemInfoCache.set(id, info); else itemInfoCache.delete(id); return info; })
    .catch(() => { itemInfoCache.delete(id); return null; });
  itemInfoCache.set(id, pending);
  return pending;
}

function sheetNode() {
  if (sheet.node) return sheet.node;
  const dialog = el("dialog", { class: "sheet", "aria-labelledby": "sheet-title" });
  dialog.addEventListener("close", () => {
    sheet.id = 0;
    sheet.back = [];
    const again = sheet.trigger && app.querySelector(`[data-focus-key="${CSS.escape(sheet.trigger)}"]`);
    if (again) again.focus({ preventScroll: true });
  });
  // Clic fuera de la ficha (en el fondo oscurecido): se cierra.
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeSheet(); });
  document.body.append(dialog);
  sheet.node = dialog;
  return dialog;
}

function closeSheet() {
  const dialog = sheet.node;
  if (!dialog || !dialog.open) return;
  const out = move(dialog, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(10px) scale(.97)" }],
    { duration: 180, easing: "ease-in", fill: "forwards" });
  if (out) out.finished.then(() => { out.cancel(); dialog.close(); }).catch(() => dialog.close());
  else dialog.close();
}

async function openItem(item, tab, trigger, { fromBack = false, push = false } = {}) {
  const dialog = sheetNode();
  if (push && sheet.id) sheet.back.push(sheet.id);
  if (!fromBack && !push) sheet.back = [];
  if (trigger && trigger.dataset) sheet.trigger = trigger.dataset.focusKey || "";
  sheet.id = item.id;
  sheet.tab = tab;
  const wasOpen = dialog.open;
  paintSheet({ id: item.id, name: item.name, price: item.price }, null);
  if (!wasOpen) {
    dialog.showModal();
    move(dialog, [{ opacity: 0, transform: "translateY(14px) scale(.96)" }, { opacity: 1, transform: "none" }],
      { duration: 320, easing: EASE_OUT });
  }
  const info = await fetchItemInfo(item.id);
  if (sheet.id !== item.id || !dialog.open) return; // ya miras otro
  paintSheet(info || { id: item.id, name: item.name, price: item.price }, info ? "ok" : "missing", { popIcon: true });
}

// Lo que ya llevas en partida (con repeticiones: dos Varas cuentan dos).
function ownedCounts() {
  const counts = new Map();
  const me = lastState && lastState.game && lastState.game.me;
  for (const id of (me && me.items) || []) counts.set(id, (counts.get(id) || 0) + 1);
  return counts;
}

function paintSheet(info, status, { popIcon = false } = {}) {
  const dialog = sheet.node;
  const icon = el("span", { class: "sheet-icon" }, [el("img", { alt: "" })]);
  setIcon(icon.firstChild, "item", info.id);
  const back = sheet.back.length ? el("button", { class: "ghost sheet-back", type: "button", "aria-label": "Volver al objeto anterior", text: "‹" }) : null;
  if (back) back.addEventListener("click", () => {
    const previous = sheet.back.pop();
    const cached = itemInfoCache.get(previous);
    openItem(cached && cached.name ? cached : { id: previous, name: "", price: 0 }, sheet.tab, null, { fromBack: true });
  });
  const close = el("button", { class: "ghost sheet-close", type: "button", "aria-label": "Cerrar la ficha", text: "×" });
  close.addEventListener("click", closeSheet);
  const tabs = [["recipe", "Composición"], ["details", "Qué da"]].map(([key, label]) => {
    const button = el("button", {
      class: classes("sheet-tab", sheet.tab === key && "on"), type: "button", role: "tab",
      "aria-selected": sheet.tab === key ? "true" : "false", "data-tab": key, text: label,
    });
    button.addEventListener("click", () => {
      if (sheet.tab === key) return;
      sheet.tab = key;
      const cached = itemInfoCache.get(sheet.id);
      paintSheet(cached && cached.name ? cached : info, cached && cached.name ? "ok" : status);
      const again = dialog.querySelector(`[data-tab="${key}"]`);
      if (again) again.focus({ preventScroll: true });
    });
    return button;
  });
  let body;
  if (status === null) body = el("div", { class: "sheet-loading muted small", text: "Cargando…" });
  else if (status === "missing") body = el("div", { class: "muted", text: "No tengo los datos de este objeto (¿está abierto el cliente de LoL?)." });
  else body = sheet.tab === "details" ? renderDetails(info) : renderRecipe(info);
  const header = el("div", { class: "sheet-head" }, [
    back, icon,
    el("div", { class: "sheet-title" }, [
      el("h2", { id: "sheet-title", class: "sheet-name", text: info.name || "Objeto" }),
      info.price ? el("span", { class: "gold-chip", text: `${info.price} de oro` }) : null,
    ]),
    close,
  ]);
  dialog.replaceChildren(
    el("div", { class: "sheet-glow", "aria-hidden": "true" }),
    header,
    el("div", { class: "sheet-tabs", role: "tablist", "aria-label": "Qué ver del objeto" }, tabs),
    el("div", { class: "sheet-body", role: "tabpanel" }, [body]),
  );
  // Al repintar la ficha se pierde el foco: va a la pestaña activa (teclado y lectores).
  if (dialog.open && !dialog.contains(document.activeElement)) {
    const target = dialog.querySelector(".sheet-tab.on") || close;
    target.focus({ preventScroll: true });
  }
  if (popIcon) {
    move(icon, [{ opacity: 0, transform: "scale(.5) rotate(-12deg)" }, { opacity: 1, transform: "none" }],
      { duration: 520, easing: EASE_POP, fill: "backwards" });
  }
}

// Árbol de componentes: se dibuja de arriba abajo (las líneas crecen y los iconos saltan).
function renderRecipe(info) {
  const owned = ownedCounts();
  const left = new Map(owned);
  const take = (id) => { const n = left.get(id) || 0; if (n > 0) { left.set(id, n - 1); return true; } return false; };
  const children = info.tree.children;
  const ownedChild = children.map((child) => take(child.id));
  const order = info.order || [];
  const firstToBuy = order.find((step) => !ownedChild[step.index]);
  const rank = new Map(order.map((step, i) => [step.index, i + 1]));

  // Nivel a nivel: el objeto, luego sus componentes y luego los de estos.
  const perLevel = [];
  let lastDelay = 0;
  const delayFor = (depth) => {
    const n = perLevel[depth] = (perLevel[depth] || 0) + 1;
    const value = depth === 0 ? 0 : 200 + (depth - 1) * 280 + (n - 1) * 70;
    lastDelay = Math.max(lastDelay, value);
    return value;
  };
  const node = (data, depth, index, parentOwned) => {
    const mine = depth === 1 ? ownedChild[index] : parentOwned;
    const first = depth === 1 && firstToBuy && firstToBuy.index === index;
    const img = el("img", { alt: "" });
    setIcon(img, "item", data.id);
    const button = el("button", {
      type: "button", class: classes("tree-item", `d${depth}`, mine && "mine", first && "first"),
      "aria-label": `${data.name}, ${data.price} de oro${mine ? ", ya lo tienes" : ""}${first ? ", cómpralo primero" : ""}`,
      title: `${data.name} (${data.price} de oro)`,
    }, [
      el("span", { class: "tree-icon" }, [img]),
      depth === 1 && rank.has(index) ? el("span", { class: "tree-rank", "aria-hidden": "true", text: String(rank.get(index)) }) : null,
      el("span", { class: "tree-name", "aria-hidden": "true", text: data.name }),
      el("span", { class: "tree-price", "aria-hidden": "true", text: String(data.price) }),
    ]);
    if (depth > 0) button.addEventListener("click", () => openItem(data, "recipe", null, { push: true }));
    else button.disabled = true;
    const wrap = el("div", { class: classes("tree-node", depth === 0 && "root") }, [button]);
    wrap.style.setProperty("--d", `${delayFor(depth)}ms`);
    if (data.children.length) {
      const kids = el("div", { class: "tree-kids" }, data.children.map((child, i) => node(child, depth + 1, i, mine)));
      wrap.append(kids);
    }
    return wrap;
  };
  const tree = el("div", { class: "recipe-tree" }, [node(info.tree, 0, 0, false)]);

  if (!children.length) {
    return el("div", { class: "recipe" }, [tree, el("div", { class: "muted small recipe-note", text: "Se compra tal cual: no tiene componentes." }), intoList(info)]);
  }
  const stepsDelay = lastDelay + 260;
  const steps = order.map((step, i) => {
    const part = children[step.index];
    const mine = ownedChild[step.index];
    const first = firstToBuy === step;
    const img = el("img", { alt: "" });
    setIcon(img, "item", part.id);
    const row = el("li", { class: classes("step", mine && "mine", first && "first") }, [
      el("span", { class: "step-num", "aria-hidden": "true", text: mine ? "✓" : String(i + 1) }),
      el("span", { class: "step-icon" }, [img]),
      el("div", { class: "step-text" }, [
        el("span", { class: "step-name" }, [part.name, first ? el("span", { class: "first-tag", text: owned.size ? "Ahora" : "Primero" }) : null]),
        el("small", { class: "muted", text: mine ? "Ya lo tienes" : step.reason }),
      ]),
      el("span", { class: "step-price", text: String(part.price) }),
    ]);
    row.style.setProperty("--d", `${stepsDelay + i * 90}ms`);
    return row;
  });
  const combine = el("li", { class: "step combine" }, [
    el("span", { class: "step-num", "aria-hidden": "true", text: "=" }),
    el("span", { class: "step-icon" }, [(() => { const img = el("img", { alt: "" }); setIcon(img, "item", info.id); return img; })()]),
    el("div", { class: "step-text" }, [
      el("span", { class: "step-name", text: `Juntarlo: ${info.name}` }),
      el("small", { class: "muted", text: "Con todos los componentes, en la tienda" }),
    ]),
    el("span", { class: "step-price", text: `+${info.combine}` }),
  ]);
  combine.style.setProperty("--d", `${stepsDelay + steps.length * 90}ms`);
  return el("div", { class: "recipe" }, [
    tree,
    el("div", { class: "section-label", text: "Qué comprar primero" }),
    el("ol", { class: "steps" }, [...steps, combine]),
    intoList(info),
  ]);
}

function intoList(info) {
  if (!info.into || !info.into.length) return null;
  return el("div", { class: "into" }, [
    el("div", { class: "section-label", text: "Se usa para" }),
    el("div", { class: "into-row" }, info.into.map((target) => {
      const img = el("img", { alt: "" });
      setIcon(img, "item", target.id);
      const button = el("button", { type: "button", class: "into-item", title: `${target.name} (${target.price} de oro)` }, [
        el("span", { class: "tree-icon" }, [img]),
        el("span", { class: "tree-name", text: target.name }),
      ]);
      button.addEventListener("click", () => openItem(target, "recipe", null, { push: true }));
      return button;
    })),
  ]);
}

// Todo lo que da: estadísticas (las cifras suben) y sus pasivas y activas.
function renderDetails(info) {
  const stats = info.stats.map((stat, i) => {
    const value = el("span", { class: "stat-value", text: stat.value });
    const row = el("li", { class: "stat" }, [value, el("span", { class: "stat-text", text: stat.text })]);
    row.style.setProperty("--d", `${120 + i * 70}ms`);
    const match = /^(\d+)(.*)$/.exec(stat.value);
    if (match) setTimeout(() => { if (value.isConnected) countUpSuffix(value, Number(match[1]), match[2]); }, 120 + i * 70);
    return row;
  });
  const blocks = info.blocks.map((block, i) => {
    const text = el("p", { class: "power-text" }, block.runs.map((run) => (run.tone ? el("span", { class: `tone-${run.tone}`, text: run.text }) : run.text)));
    const kind = block.kind === "passive" ? "Pasiva" : block.kind === "active" ? "Activa" : "";
    const box = el("div", { class: classes("power", block.kind) }, [
      block.name || kind ? el("div", { class: "power-head" }, [
        kind ? el("span", { class: "power-kind", text: kind }) : null,
        block.name ? el("span", { class: "power-name", text: block.name }) : null,
        block.meta ? el("span", { class: "power-meta", text: block.meta }) : null,
      ]) : null,
      block.runs.length ? text : null,
    ]);
    box.style.setProperty("--d", `${160 + stats.length * 70 + i * 110}ms`);
    return box;
  });
  if (!stats.length && !blocks.length) return el("div", { class: "muted", text: "El cliente no da más detalles de este objeto." });
  return el("div", { class: "details" }, [
    stats.length ? el("ul", { class: "stat-list" }, stats) : null,
    ...blocks,
  ]);
}

function countUpSuffix(node, to, suffix, duration = 600) {
  if (reducedMotion.matches) return;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    node.textContent = `${Math.round(to * (1 - (1 - t) ** 3))}${suffix}`;
    if (t < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

setupBrandCheer();
setupStillWhenAway();
render({ phaseLabel: "Conectando…", connected: false }, true);
if (DESKTOP) startDesktop();
else connect();
