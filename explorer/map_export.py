"""
Downloads of the layer shown in the Spatial Environmental Mapping panel.

For the current selection of any of the three datasets this builds

* a **GeoTIFF**: the cell values (EDGAR, inverse model) as one float32 band in
  WGS 84, written by a small TIFF writer below so no GDAL is needed on Vercel.
  MapEIre is written on its own 1 km TM65 / Irish Grid (EPSG:29902), the native
  grid of the source rasters (values decoded with each band's scale and offset).
* a **JPEG** map: the layer in the same colours as the web map, Ireland's
  coastline (``data/boundaries/ireland_outline.json``, Natural Earth), lat/lon
  ticks, a title, a colour-bar legend, key figures and the data source.

Selections are validated by the dataset modules (``edgar.layer``,
``inverse.layer``, ``mapeire.layer``); user input never builds a path.
"""
from __future__ import annotations

import colorsys
import contextvars
import io
import json
import math
import struct
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import List, Optional, Sequence, Tuple
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

from . import edgar, inverse, mapeire, timeseries

BASE_DIR = Path(__file__).resolve().parent.parent
OUTLINE_PATH = BASE_DIR / "data" / "boundaries" / "ireland_outline.json"
FONT_DIR = BASE_DIR / "data" / "fonts"
NODATA = -9999.0
R_EARTH = 6378137.0
VIEW = (-11.0, 51.25, -5.3, 55.55)   # west, south, east, north of the JPEG map frame

RGB = Tuple[int, int, int]
ZERO_RGB = (235, 238, 241)          # EDGAR cells with no emission assigned
FADE = 0.45                         # inverse model cells outside the Ireland attribution area
DISCRETE_MAX = 10                   # a region with fewer cells gets one colour per value


# ---------------------------------------------------------------------------
# Colours: the palettes of the map's step 3 "Map style" (``GRID_UI.palette`` on the page)
# ---------------------------------------------------------------------------
def _hex(c: str) -> RGB:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


# explorer/palettes.json is the one list, shared with the web map (spliced into the page).
PALETTES_PATH = Path(__file__).resolve().parent / "palettes.json"
_PAL_DATA = json.loads(PALETTES_PATH.read_text(encoding="utf-8"))
# Sequential ramps (low -> high) as RGB stops; None = the HSV hue 240 -> 0 rainbow
SEQ_PALETTES = {p["id"]: (None if p.get("hsv") else [_hex(s) for s in p["stops"]]) for p in _PAL_DATA["seq"]}
# Diverging ramps: RGB stops from most negative to most positive, zero in the middle
DIV_PALETTES = {p["id"]: [_hex(s) for s in p["stops"]] for p in _PAL_DATA["div"]}
DEFAULT_SEQ, DEFAULT_DIV = _PAL_DATA["default"]["seq"], _PAL_DATA["default"]["div"]


def _ramp(rgb: Sequence[RGB], t: float) -> RGB:
    """Linear interpolation between evenly spaced stops, t in [0, 1]."""
    x = min(max(t, 0.0), 1.0) * (len(rgb) - 1)
    i = min(int(x), len(rgb) - 2)
    k = x - i
    return tuple(round(rgb[i][j] + (rgb[i + 1][j] - rgb[i][j]) * k) for j in range(3))  # type: ignore[return-value]


@dataclass(frozen=True)
class Palette:
    """The map's step 3 "Map style": colours, the value range slider and the background value."""
    seq: str = DEFAULT_SEQ
    div: str = DEFAULT_DIV
    reverse: bool = False
    rlo: Optional[float] = None     # value range filter of the slider: cells below rlo / above rhi
    rhi: Optional[float] = None     # are not drawn (None: no limit on that side)
    bg: Optional[float] = None      # cells equal to this value are not coloured
    rinv: bool = False              # reverse filter (compare map): the ``conf`` % of cells closest to
    conf: float = 0.0               # zero are not drawn (the value range is not applied then)

    @classmethod
    def from_query(cls, q: dict) -> "Palette":
        """Unknown or malformed values fall back to the defaults."""
        def num(key):
            try:
                v = float(q.get(key, ""))
            except ValueError:
                return None
            return v if math.isfinite(v) else None
        seq, div = q.get("palette", ""), q.get("div_palette", "")
        rlo, rhi = num("rlo"), num("rhi")
        if rlo is not None and rhi is not None and not rlo < rhi:
            rlo = rhi = None
        conf = min(max(num("conf") or 0.0, 0.0), 99.0)
        rinv = q.get("rinv") == "1" and conf > 0
        if rinv:
            rlo = rhi = None
        return cls(seq if seq in SEQ_PALETTES else DEFAULT_SEQ, div if div in DIV_PALETTES else DEFAULT_DIV,
                   q.get("reverse") == "1", rlo, rhi, num("bg"), rinv, conf if rinv else 0.0)


# The palette of the download being built (set per request by ``use_palette``)
_PALETTE: contextvars.ContextVar[Palette] = contextvars.ContextVar("map_palette", default=Palette())


@contextmanager
def use_palette(palette: Palette):
    token = _PALETTE.set(palette)
    try:
        yield
    finally:
        _PALETTE.reset(token)


def rainbow(t: float) -> RGB:
    """Sequential colour at t in [0, 1], low -> high, in the chosen palette (default HSV rainbow)."""
    p = _PALETTE.get()
    t = min(max(t, 0.0), 1.0)
    if p.reverse:
        t = 1 - t
    stops = SEQ_PALETTES[p.seq]
    if stops is None:
        r, g, b = colorsys.hls_to_rgb((1 - t) * 240 / 360, 0.5, 1.0)
        return round(r * 255), round(g * 255), round(b * 255)
    return _ramp(stops, t)


def diverging(t: float) -> RGB:
    """Diverging colour at t in [-1, 1] in the chosen palette (default blue -> white -> red)."""
    p = _PALETTE.get()
    if p.reverse:
        t = -t
    return _ramp(DIV_PALETTES[p.div], (min(max(t, -1.0), 1.0) + 1) / 2)


# Value range slider and background value: the same rules as ``GRID_UI.range`` on the page.
# A display filter: the colours keep the layer's own scale; cells outside are not drawn.
def outside(v: float) -> bool:
    """Is v filtered out by the slider (below its min or above its max handle)?"""
    p = _PALETTE.get()
    if not math.isfinite(v):
        return False
    return (p.rlo is not None and v < p.rlo) or (p.rhi is not None and v > p.rhi)


def is_bg(v: float) -> bool:
    b = _PALETTE.get().bg
    return b is not None and math.isfinite(v) and abs(v - b) <= 1e-12 * max(1.0, abs(b))


def hidden(v: float) -> bool:
    """Not drawn: the background value, or outside the slider's range."""
    return is_bg(v) or outside(v)


def _signed(v: float) -> str:
    return ("+" if v > 0 else "−" if v < 0 else "") + fmt(abs(v))


def _filter_note(signed: bool = False) -> str:
    """' · Showing values 20 – 9,757', as on the map."""
    p, f, out = _PALETTE.get(), (_signed if signed else fmt), ""
    if p.rlo is not None and p.rhi is not None:
        out += f" · Showing values {f(p.rlo)} – {f(p.rhi)}"
    elif p.rlo is not None:
        out += f" · Showing values ≥ {f(p.rlo)}"
    elif p.rhi is not None:
        out += f" · Showing values ≤ {f(p.rhi)}"
    return out


def _fade(c: RGB, alpha: float) -> RGB:
    """Blend ``c`` over white (the faded cells of the web map)."""
    return tuple(round(255 + (v - 255) * alpha) for v in c)  # type: ignore[return-value]


_SUP = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


def fmt(v: float) -> str:
    """Number formatting of the page's ``fmtVal`` (2.6 × 10⁻⁵, 1,234, 0.559)."""
    if v == 0:
        return "0"
    a = abs(v)
    if a < 1e-3 or a >= 1e7:
        m, e = f"{v:.1e}".split("e")
        return f"{m} × 10{str(int(e)).translate(_SUP)}"
    if a >= 1000:
        return f"{round(v):,}"
    return f"{float(f'{v:.3g}'):g}"


# ---------------------------------------------------------------------------
# What one download describes
# ---------------------------------------------------------------------------
@dataclass
class Legend:
    title: str
    unit: str
    kind: str                       # "log" | "diverging" | "stops"
    lo: float = 0.0
    hi: float = 1.0
    stops: Sequence[RGB] = ()       # kind == "stops": colour ramp bottom -> top
    ticks: Sequence[Tuple[float, str]] = ()   # (position 0..1, label)
    swatches: Sequence[Tuple[RGB, str]] = ()  # extra boxes under the bar
    note: str = ""


@dataclass
class Layer:
    stem: str                        # file name without extension
    title: str
    subtitle: str
    legend: Legend
    source: str
    facts: List[Tuple[str, str]] = field(default_factory=list)
    # Cells: (west, south, east, north, RGB) in degrees, drawn as rectangles
    cells: List[Tuple[float, float, float, float, RGB]] = field(default_factory=list)
    # Or a pre-rendered RGBA overlay in Web Mercator with its WGS 84 bounds
    overlay: Optional[Image.Image] = None
    overlay_bounds: Optional[Tuple[float, float, float, float]] = None  # w, s, e, n
    # GeoTIFF content
    tif_values: Optional[np.ndarray] = None            # float32 2-D, NODATA outside
    tif_geo: Optional[Tuple[float, float, float, float]] = None   # west, north, dx, dy (deg)
    tif_bytes: Optional[bytes] = None                   # an original file to pass through
    tif_meta: dict = field(default_factory=dict)
    # A projected grid (MapEIre: TM65 / Irish Grid, metres) instead of degrees, with the WGS 84
    # centre of every pixel (rows × cols each) for clipping to a time series region
    tif_epsg: int = 4326
    tif_centres: Optional[Tuple[np.ndarray, np.ndarray]] = None
    # Value behind each drawn cell (parallel to ``cells``) and whether it is faded (outside the Ireland
    # attribution area), so a region export can recolour its own cells; ``cell_kind`` "log" | "diverging"
    cell_vals: List[Tuple[float, bool]] = field(default_factory=list)
    cell_kind: str = ""
    # Clipped to a time series region (box, polygon or county): its rings as (lon, lat) and the credit
    clip_rings: List[List[Tuple[float, float]]] = field(default_factory=list)
    clip_credit: str = ""


class SelectionError(ValueError):
    """The query does not describe a valid layer."""


def _slug(*parts: str) -> str:
    out = "_".join(p for p in parts if p)
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in out)


def _log_ticks(lo: float, hi: float, n: int = 5) -> List[Tuple[float, str]]:
    ticks = []
    for i in range(n):
        t = i / (n - 1)
        v = 10 ** (math.log10(lo) + t * (math.log10(hi) - math.log10(lo)))
        label = fmt(v)
        if i == 0:
            label = "≤ " + label
        elif i == n - 1:
            label = "≥ " + label
        ticks.append((t, label))
    return ticks


# ---------------------------------------------------------------------------
# Dataset -> Layer
# ---------------------------------------------------------------------------
def _edgar_layer(q: dict) -> Layer:
    data = edgar.layer(q.get("gas", ""), q.get("sector", ""), q.get("year", ""), q.get("month", ""))
    if data is None:
        raise SelectionError("Unknown EDGAR selection.")
    meta = edgar.load_metadata()
    gas, sector = meta["gases"][q["gas"]], meta["sectors"][q["sector"]]
    grid = meta["grid"]
    west, north, res, rows, cols = grid["west"], grid["north"], grid["res"], grid["rows"], grid["cols"]
    lo, hi = data["scale"]["lo"], data["scale"]["hi"]
    annual = data["period"] == "annual"
    period = f"{q['year']} annual total" if annual else data["month_label"]

    arr = np.full(rows * cols, NODATA, dtype=np.float32)
    arr[np.asarray(grid["cells"])] = np.asarray(data["values"], dtype=np.float32)
    zero = ZERO_RGB
    cells, cell_vals = [], []
    for idx, v in zip(grid["cells"], data["values"]):
        if hidden(v):
            continue                        # background value, or outside the slider: not drawn
        r, c = divmod(idx, cols)
        w, n = west + c * res, north - r * res
        if v > 0:
            t = (math.log10(min(max(v, lo), hi)) - math.log10(lo)) / (math.log10(hi) - math.log10(lo))
            colour = rainbow(t)
        else:
            colour = zero
        cells.append((w, n - res, w + res, n, colour))
        cell_vals.append((float(v), False))

    src = meta["source"]
    years = meta["years"]
    legend = Legend(
        title=f"{gas['formula']} · {period}", unit=data["unit"], kind="log", lo=lo, hi=hi,
        ticks=_log_ticks(lo, hi), swatches=[] if hidden(0.0) else [(zero, "0 (no emission assigned)")],
        note=f"Log scale, fixed over {years[0]}–{years[-1]} · mass of gas, not CO₂-eq" + _filter_note(),
    )
    return Layer(
        stem=_slug("EDGAR", q["gas"], q["sector"], q["year"], "annual" if annual else f"m{int(q['month']):02d}"),
        title=f"EDGAR · {gas['formula']} emissions from {sector['name'].lower()}",
        subtitle=f"{period}   [{data['unit']}]",
        legend=legend,
        source=f"{src['dataset']} · {src['credit']} · {src['url']}",
        facts=[
            ("Ireland total", f"{fmt(data['total'])} t {gas['formula']}"),
            ("Sector", f"{sector['name']} (IPCC {sector['ipcc']})"),
            ("Cells with emission", f"{data['nonzero_cells']} of {len(grid['cells'])}"),
            ("Resolution", src["resolution"]),
        ],
        cells=cells, cell_vals=cell_vals, cell_kind="log",
        tif_values=arr.reshape(rows, cols), tif_geo=(west, north, res, res),
        tif_meta={"DATASET": src["dataset"], "GAS": gas["formula"], "SECTOR": sector["name"],
                  "PERIOD": period, "UNITS": data["unit"], "SOURCE": src["url"]},
    )


_ESTIMATES = {"posterior": "Posterior", "prior": "Prior", "difference": "Difference (posterior − prior)"}


def _inverse_layer(q: dict) -> Layer:
    data = inverse.layer(q.get("model", ""), q.get("transport", ""), q.get("gas", ""), q.get("year", ""))
    est = q.get("estimate", "")
    if data is None or est not in _ESTIMATES:
        raise SelectionError("Unknown inverse model selection.")
    meta = inverse.load_metadata()
    gas = meta["gases"][q["gas"]]
    grid = meta["grid"]
    west, north, dlon, dlat = grid["west"], grid["north"], grid["dlon"], grid["dlat"]
    rows, cols = grid["rows"], grid["cols"]
    prior = np.array([np.nan if v is None else v for v in data["prior"]], dtype=np.float64)
    post = np.array([np.nan if v is None else v for v in data["posterior"]], dtype=np.float64)
    values = post - prior if est == "difference" else (post if est == "posterior" else prior)
    frac = data["country_fraction"]
    s = data["scale"]
    cells, cell_vals = [], []
    for i, v in enumerate(values):
        if not np.isfinite(v) or hidden(v):
            continue                        # no value, background value, or outside the slider: not drawn
        if est == "difference":
            colour = diverging(v / s["difference"]["limit"])
        else:
            flo, fhi = s["flux"]["lo"], s["flux"]["hi"]
            colour = rainbow((math.log10(min(max(v, flo), fhi)) - math.log10(flo)) / (math.log10(fhi) - math.log10(flo)))
        if not frac[i] > 0:
            colour = _fade(colour, FADE)
        r, c = divmod(i, cols)
        w, n = west + c * dlon, north - r * dlat
        cells.append((w, n - dlat, w + dlon, n, colour))
        cell_vals.append((float(v), not frac[i] > 0))

    arr = np.where(np.isfinite(values), values, NODATA).astype(np.float32).reshape(rows, cols)
    if est == "difference":
        lim = s["difference"]["limit"]
        legend = Legend(
            title=f"{gas['formula']} — {q['year']} — Difference", unit=data["unit"], kind="diverging",
            lo=-lim, hi=lim,
            ticks=[(0, f"≤ −{fmt(lim)}"), (0.25, f"−{fmt(lim / 2)}"), (0.5, "0"),
                   (0.75, f"+{fmt(lim / 2)}"), (1, f"≥ +{fmt(lim)}")],
            swatches=[(_fade(diverging(0.5), 0.45), "Outside the Ireland attribution area")],
            note="Linear, symmetric · fixed for all models and years" + _filter_note(signed=True),
        )
    else:
        legend = Legend(
            title=f"{gas['formula']} — {q['year']} — {_ESTIMATES[est]}", unit=data["unit"], kind="log",
            lo=s["flux"]["lo"], hi=s["flux"]["hi"], ticks=_log_ticks(s["flux"]["lo"], s["flux"]["hi"]),
            swatches=[(_fade(rainbow(0.6), 0.45), "Outside the Ireland attribution area")],
            note="Log scale · fixed for all models and years" + _filter_note(),
        )
    src = meta["source"]
    diff = data["total_posterior"] - data["total_prior"]
    what = "total flux difference" if est == "difference" else f"total flux — {_ESTIMATES[est]}"
    return Layer(
        stem=_slug("PARIS", q["model"], q["transport"], q["gas"], q["year"], est),
        title=f"{q['model']} {q['transport']} · Ireland · PARIS inverse model",
        subtitle=f"{gas['formula']} {what} — {q['year']}   [{data['unit']}]",
        legend=legend,
        source=f"{src['dataset']} · {src['credit']} · doi:{src['doi']}",
        facts=[
            ("Ireland posterior", f"{data['total_posterior']:,.2f} Gg {gas['formula']} yr⁻¹"),
            ("Ireland prior", f"{data['total_prior']:,.2f} Gg ({gas['prior']})"),
            ("Difference", f"{diff:+,.2f} Gg ({diff / data['total_prior'] * 100:+.1f}%)"),
            ("Constraint", f"{data['urr']:.2f} (σ posterior / σ prior)"),
            ("Resolution", src["resolution"]),
        ],
        cells=cells, cell_vals=cell_vals, cell_kind="diverging" if est == "difference" else "log",
        tif_values=arr, tif_geo=(west, north, dlon, dlat),
        tif_meta={"DATASET": src["dataset"], "MODEL": q["model"], "TRANSPORT": q["transport"],
                  "GAS": gas["formula"], "YEAR": q["year"], "ESTIMATE": _ESTIMATES[est],
                  "UNITS": data["unit"], "SOURCE": src["url"]},
    )


def _mapeire_cell_boxes(cells: np.ndarray) -> np.ndarray:
    """(k, 4) west, south, east, north of the 1 km cells ``cells`` (flat grid indices), drawn in degrees
    around their WGS 84 centres (the grid's ~1° rotation against north is below a pixel of the JPEG)."""
    c = mapeire.centres()
    lat, lng = c["lat"].ravel()[cells], c["lng"].ravel()[cells]
    hl, hg = 0.5 / 111.32, 0.5 / (111.32 * np.cos(np.radians(lat)))
    return np.stack([lng - hg, lat - hl, lng + hg, lat + hl], axis=1)


def _mapeire_label(meta: dict, sel: dict) -> str:
    return f"{meta['sectors'][sel['sector']]['name']}, {sel['year']}"


def _mapeire_layer(q: dict) -> Layer:
    year, sector, code = q.get("year", ""), q.get("sector", ""), q.get("parameter", "")
    data = mapeire.layer(year, sector, code)
    if data is None:
        raise SelectionError("Unknown MapEIre selection.")
    meta = mapeire.load_metadata()
    p, s, g, src = meta["pollutants"][code], meta["sectors"][sector], meta["grid"], meta["source"]
    vals = mapeire.values(year, sector, code)
    flat = vals.ravel()
    scale = data["colour"]
    unit = p["unit_long"] or "unit not stated in the MapEIre report"

    shown = np.flatnonzero(np.isfinite(flat))
    shown = np.array([i for i in shown if not hidden(float(flat[i]))], dtype=np.int64)
    boxes = _mapeire_cell_boxes(shown) if shown.size else np.zeros((0, 4))
    cells, cell_vals = [], []
    kind = (scale or {}).get("kind", "log")
    for (w, so, e, n), i in zip(boxes.tolist(), shown.tolist()):
        v = float(flat[i])
        if kind == "div":
            colour = diverging(v / scale["hi"])
        elif v > 0:
            lo, hi = scale["lo"], scale["hi"]
            colour = rainbow((math.log10(min(max(v, lo), hi)) - math.log10(lo)) / (math.log10(hi) - math.log10(lo)))
        else:
            colour = ZERO_RGB
        cells.append((w, so, e, n, colour))
        cell_vals.append((v, False))

    years = meta["years"]
    years_txt = ", ".join(str(y) for y in years[:-1]) + f" and {years[-1]}" if len(years) > 1 else str(years[0])
    if scale and kind == "div":
        lim = scale["hi"]
        legend = Legend(
            title=f"{p['formula']} · {year}", unit=unit, kind="diverging", lo=-lim, hi=lim,
            ticks=[(0, f"≤ −{fmt(lim)}"), (0.25, f"−{fmt(lim / 2)}"), (0.5, "0"),
                   (0.75, f"+{fmt(lim / 2)}"), (1, f"≥ +{fmt(lim)}")],
            note=f"Linear, symmetric · negative values are removals · fixed over {years_txt}"
                 + _filter_note(signed=True))
    elif scale:
        legend = Legend(
            title=f"{p['formula']} · {year}", unit=unit, kind="log", lo=scale["lo"], hi=scale["hi"],
            ticks=_log_ticks(scale["lo"], scale["hi"]),
            note=f"Log scale, fixed over {years_txt} · cells with zero emission "
                 "not shown" + _filter_note())
    else:
        legend = Legend(title=f"{p['formula']} · {year}", unit=unit, kind="stops", stops=[ZERO_RGB, ZERO_RGB],
                        note="No emission in this layer")
    total_txt = f"{fmt(data['total'])} {p['unit_code'] + ' ' if p['unit_code'] else ''}{p['formula']}"
    arr = np.where(np.isfinite(vals), vals, NODATA).astype(np.float32)
    c = mapeire.centres()
    return Layer(
        stem=_slug("MapEIre", year, sector, code),
        title=f"MapEIre · {p['label']}",
        subtitle=f"{s['name']} — {year}   [{unit}]",
        legend=legend,
        source=f"{src.get('dataset', 'MapEIre')} · {src.get('credit', '')} · EPA Research Report 317",
        facts=[("Ireland total", total_txt + ("" if p["unit_code"] else " (unit not stated)")),
               ("Sector", f"{s['code']} · {s['name']}" if s["code"] else s["name"]),
               ("Cells with emission", f"{data['nonzero_cells']:,} of {data['cells']:,}"),
               ("Resolution", src.get("resolution", "")), ("Projection", src.get("projection", ""))],
        cells=cells, cell_vals=cell_vals, cell_kind="diverging" if kind == "div" else "log",
        tif_values=arr, tif_geo=(g["west"], g["north"], g["res"], g["res"]), tif_epsg=29902,
        tif_centres=(c["lat"], c["lng"]),
        tif_meta={"DATASET": src.get("dataset", "MapEIre"), "POLLUTANT": p["label"], "SECTOR": s["name"],
                  "YEAR": year, "UNITS": unit, "CRS": "TM65 / Irish Grid (EPSG:29902)", "SOURCE": src.get("url", "")},
    )


# ---------------------------------------------------------------------------
# Comparison: layer B − layer A of the same dataset (EDGAR or inverse model)
# ---------------------------------------------------------------------------
_EDGAR_KEYS = ("gas", "sector", "year", "month")
_INVERSE_KEYS = ("model", "transport", "gas", "year", "estimate")
_MAPEIRE_KEYS = ("year", "sector", "parameter")
_COMPARE_NAMES = {"edgar": "EDGAR", "inverse": "PARIS inverse model", "mapeire": "MapEIre"}


def _edgar_label(meta: dict, sel: dict) -> str:
    period = sel["year"] if sel["month"] == "annual" else f"{edgar.MONTHS[int(sel['month']) - 1]} {sel['year']}"
    return f"{meta['sectors'][sel['sector']]['name']}, {period}"


def _inverse_label(sel: dict) -> str:
    return f"{sel['model']} {sel['transport']} {sel['estimate']} {sel['year']}"


def _quantile(sorted_vals: np.ndarray, p: float) -> float:
    return float(np.quantile(sorted_vals, p)) if sorted_vals.size else float("nan")


def _compare_layer(q: dict) -> Layer:
    """
    Difference map B − A (``mode`` "abs") or (B − A) / A in % (``mode`` "pct").
    Both layers come from the same dataset and gas; EDGAR layers must both be
    annual or both monthly. The page computes the same numbers for its panel.
    """
    ds, mode = q.get("dataset", ""), q.get("mode", "abs")
    keys = {"edgar": _EDGAR_KEYS, "inverse": _INVERSE_KEYS, "mapeire": _MAPEIRE_KEYS}.get(ds)
    if keys is None:
        raise SelectionError("Unknown dataset to compare.")
    if mode not in ("abs", "pct"):
        raise SelectionError("Unknown difference mode.")
    sel_a = {k: q.get(k, "") for k in keys}
    sel_b = {k: q.get(f"b_{k}", "") for k in keys}
    gas_key = "parameter" if ds == "mapeire" else "gas"
    if sel_a[gas_key] != sel_b[gas_key]:
        raise SelectionError("Both layers must be the same gas or pollutant.")
    sel_a["gas"] = sel_a.get("gas", sel_a.get("parameter", ""))     # (file name part below)
    tif_epsg, tif_centres = 4326, None

    if ds == "mapeire":
        meta = mapeire.load_metadata()
        va = mapeire.values(sel_a["year"], sel_a["sector"], sel_a["parameter"])
        vb = mapeire.values(sel_b["year"], sel_b["sector"], sel_b["parameter"])
        if va is None or vb is None:
            raise SelectionError("Unknown MapEIre selection.")
        g, p = meta["grid"], meta["pollutants"][sel_a["parameter"]]
        a, b = va.ravel(), vb.ravel()
        include = np.isfinite(a) & np.isfinite(b)
        boxes = np.zeros((a.size, 4))
        boxes[include] = _mapeire_cell_boxes(np.flatnonzero(include))
        geo = [(w, n, e - w, n - so) for w, so, e, n in boxes.tolist()]       # (west, north, dx, dy)
        tot_a = mapeire.band_info(sel_a["year"], sel_a["sector"], sel_a["parameter"])["total"]
        tot_b = mapeire.band_info(sel_b["year"], sel_b["sector"], sel_b["parameter"])["total"]
        formula = p["formula"]
        unit = p["unit_long"] or "unit not stated in the MapEIre report"
        tot_unit = f"{p['unit_code']} {formula}" if p["unit_code"] else formula
        label_a, label_b = _mapeire_label(meta, sel_a), _mapeire_label(meta, sel_b)
        src = meta["source"]
        source = f"{src.get('dataset', 'MapEIre')} · {src.get('credit', '')} · EPA Research Report 317"
        stem_a, stem_b = f"{sel_a['sector']}-{sel_a['year']}", f"{sel_b['sector']}-{sel_b['year']}"
        tif_rows, tif_cols, tif_geo = g["rows"], g["cols"], (g["west"], g["north"], g["res"], g["res"])
        flat_index = np.arange(a.size)
        c = mapeire.centres()
        tif_epsg, tif_centres = 29902, (c["lat"], c["lng"])
    elif ds == "edgar":
        if (sel_a["month"] == "annual") != (sel_b["month"] == "annual"):
            raise SelectionError("Compare annual with annual, or month with month.")
        la, lb = edgar.layer(**sel_a), edgar.layer(**sel_b)
        if la is None or lb is None:
            raise SelectionError("Unknown EDGAR selection.")
        meta = edgar.load_metadata()
        grid = meta["grid"]
        a, b = np.asarray(la["values"], float), np.asarray(lb["values"], float)
        include = np.ones(a.size, bool)
        geo = [(grid["west"] + (i % grid["cols"]) * grid["res"], grid["north"] - (i // grid["cols"]) * grid["res"],
                grid["res"], grid["res"]) for i in grid["cells"]]
        tot_a, tot_b, tot_unit = la["total"], lb["total"], f"t {meta['gases'][sel_a['gas']]['formula']}"
        unit, formula = la["unit"], meta["gases"][sel_a["gas"]]["formula"]
        label_a, label_b = _edgar_label(meta, sel_a), _edgar_label(meta, sel_b)
        src = meta["source"]
        source = f"{src['dataset']} · {src['credit']} · {src['url']}"
        stem_a = f"{sel_a['sector']}-{sel_a['year']}" + ("" if sel_a["month"] == "annual" else f"m{int(sel_a['month']):02d}")
        stem_b = f"{sel_b['sector']}-{sel_b['year']}" + ("" if sel_b["month"] == "annual" else f"m{int(sel_b['month']):02d}")
        tif_rows, tif_cols, tif_geo = grid["rows"], grid["cols"], (grid["west"], grid["north"], grid["res"], grid["res"])
        flat_index = np.asarray(grid["cells"])
    elif ds == "inverse":
        if sel_a["estimate"] not in ("prior", "posterior") or sel_b["estimate"] not in ("prior", "posterior"):
            raise SelectionError("Compare prior or posterior estimates.")
        la = inverse.layer(*(sel_a[k] for k in _INVERSE_KEYS[:4]))
        lb = inverse.layer(*(sel_b[k] for k in _INVERSE_KEYS[:4]))
        if la is None or lb is None:
            raise SelectionError("Unknown inverse model selection.")
        meta = inverse.load_metadata()
        grid = meta["grid"]
        num = lambda v: np.array([np.nan if x is None else x for x in v], float)  # noqa: E731
        a, b = num(la[sel_a["estimate"]]), num(lb[sel_b["estimate"]])
        fa, fb = np.asarray(la["country_fraction"], float), np.asarray(lb["country_fraction"], float)
        include = np.isfinite(a) & np.isfinite(b) & (fa > 0) & (fb > 0)
        geo = [(grid["west"] + (i % grid["cols"]) * grid["dlon"], grid["north"] - (i // grid["cols"]) * grid["dlat"],
                grid["dlon"], grid["dlat"]) for i in range(a.size)]
        tot_a, tot_b = la[f"total_{sel_a['estimate']}"], lb[f"total_{sel_b['estimate']}"]
        formula = meta["gases"][sel_a["gas"]]["formula"]
        tot_unit, unit = f"Gg {formula} yr⁻¹", la["unit"]
        label_a, label_b = _inverse_label(sel_a), _inverse_label(sel_b)
        src = meta["source"]
        source = f"{src['dataset']} · {src['credit']} · doi:{src['doi']}"
        stem_a = f"{sel_a['model']}-{sel_a['transport']}-{sel_a['estimate']}-{sel_a['year']}"
        stem_b = f"{sel_b['model']}-{sel_b['transport']}-{sel_b['estimate']}-{sel_b['year']}"
        tif_rows, tif_cols, tif_geo = grid["rows"], grid["cols"], (grid["west"], grid["north"], grid["dlon"], grid["dlat"])
        flat_index = np.arange(a.size)

    d = b - a
    if mode == "pct":
        pos = a[include & (a > 0)]
        thr = 0.01 * pos.mean() if pos.size else np.inf
        with np.errstate(divide="ignore", invalid="ignore"):
            v = np.where(include & (a > thr), d / a * 100, np.nan)
    else:
        v = np.where(include, d, np.nan)
    finite = np.isfinite(v)
    vals = np.sort(v[finite])
    lim = _quantile(np.abs(vals), 0.98) if vals.size else 1.0
    lim = lim if lim > 0 else (float(np.abs(vals).max()) if vals.size and np.abs(vals).max() > 0 else 1.0)

    # Reverse filter (as on the page): hide the ``conf`` % of cells whose |B − A| is closest to zero
    pal, cut, near_note = _PALETTE.get(), -np.inf, ""
    if pal.rinv and vals.size:
        k = int(math.floor(vals.size * pal.conf / 100 + 0.5))   # as Math.round on the page
        if k > 0:
            cut = float(np.sort(np.abs(vals))[k - 1])
            n_hid = int((np.abs(vals) <= cut).sum())
            near_note = (f" · Hiding the {fmt(pal.conf)}% of cells closest to zero "
                         f"(|B − A| ≤ {fmt(cut)}{'%' if mode == 'pct' else ''}, {n_hid} cells)")

    cells, cell_vals = [], []
    for (w, n, dx, dy), val in zip(geo, v):
        if np.isfinite(val) and not hidden(val) and not abs(val) <= cut:   # background / filtered: not drawn
            cells.append((w, n - dy, w + dx, n, diverging(val / lim)))
            cell_vals.append((float(val), False))

    arr = np.full(tif_rows * tif_cols, NODATA, dtype=np.float32)
    arr[flat_index] = np.where(finite, v, NODATA).astype(np.float32)

    diff_tot = tot_b - tot_a
    value_unit = "%" if mode == "pct" else unit
    r = float(np.corrcoef(a[include], b[include])[0, 1]) if include.sum() > 2 and np.std(a[include]) > 0 and np.std(b[include]) > 0 else float("nan")
    facts = [
        ("Total A", f"{fmt(tot_a)} {tot_unit}"),
        ("Total B", f"{fmt(tot_b)} {tot_unit}"),
        ("B − A", f"{'+' if diff_tot >= 0 else '−'}{fmt(abs(diff_tot))} {tot_unit}"
                  + (f" ({diff_tot / tot_a * 100:+.1f}%)" if tot_a else "")),
        ("Cell mean", f"{fmt(float(vals.mean())) if vals.size else '–'} {value_unit}"),
        ("Cell median", f"{fmt(_quantile(vals, 0.5)) if vals.size else '–'} {value_unit}"),
        ("Pearson r (A, B)", f"{r:.3f}" if np.isfinite(r) else "–"),
        ("Cells", f"{int(finite.sum())}" + (" (A below 1% of its mean excluded)" if mode == "pct" else "")),
    ]
    what = "% change" if mode == "pct" else "difference"
    legend = Legend(
        title=f"{formula} · B − A" + (" (%)" if mode == "pct" else ""), unit=value_unit, kind="diverging",
        lo=-lim, hi=lim,
        ticks=[(0, f"≤ −{fmt(lim)}"), (0.25, f"−{fmt(lim / 2)}"), (0.5, "0"), (0.75, f"+{fmt(lim / 2)}"), (1, f"≥ +{fmt(lim)}")],
        note=f"A: {label_a} · B: {label_b} · scale ±98th percentile of |B − A|" + _filter_note(signed=True) + near_note,
    )
    name = _COMPARE_NAMES[ds]
    return Layer(
        stem=_slug({"edgar": "EDGAR", "inverse": "PARIS", "mapeire": "MapEIre"}[ds], sel_a["gas"], "diff",
                   stem_b, "minus", stem_a, mode),
        tif_epsg=tif_epsg, tif_centres=tif_centres,
        title=f"{name} · {formula} {what}: B − A",
        subtitle=f"B: {label_b}  −  A: {label_a}   [{value_unit}]",
        legend=legend, source=source, facts=facts, cells=cells, cell_vals=cell_vals, cell_kind="diverging",
        tif_values=arr.reshape(tif_rows, tif_cols), tif_geo=tif_geo,
        tif_meta={"DATASET": name, "LAYER_A": label_a, "LAYER_B": label_b, "GAS": formula,
                  "VALUE": "B − A" if mode == "abs" else "(B − A) / A × 100", "UNITS": value_unit, "SOURCE": source},
    )


def build_layer(q: dict) -> Layer:
    dataset = q.get("dataset", "")
    if q.get("compare") == "1":
        return _compare_layer(q)
    if dataset == "edgar":
        return _edgar_layer(q)
    if dataset == "inverse":
        return _inverse_layer(q)
    if dataset == "mapeire":
        return _mapeire_layer(q)
    raise SelectionError("Unknown dataset.")


def _region(q: dict):
    """The time series region of ``q``: (label, file-name part, inside(lat, lng), centre (lat, lng),
    rings as (k, 2) lat/lng arrays to draw, boundary credit) -- the rules of ``timeseries._pick``."""
    try:
        if q.get("county"):
            name = q["county"]
            rings = timeseries.counties().get(name)
            if rings is None:
                raise SelectionError("Unknown county.")
            try:
                credit = json.loads(timeseries.COUNTIES_PATH.read_text(encoding="utf-8")).get("source", "")
            except (OSError, ValueError):
                credit = ""
            return (f"County {name}", f"county_{name}", lambda la, ln: timeseries._in_rings(la, ln, rings),
                    max(rings, key=len).mean(axis=0), rings, f"County boundary: {credit or 'OpenStreetMap'}")
        if q.get("poly"):
            pts = timeseries._polygon(q["poly"])
            return ("Drawn polygon", "polygon", lambda la, ln: timeseries._in_polygon(la, ln, pts),
                    pts.mean(axis=0), [pts], "")
        so, w, n, e = timeseries._bbox(q)
        box = np.array([[so, w], [so, e], [n, e], [n, w]], dtype="float64")
        lng_txt = lambda x: f"{abs(x):.2f}°{'W' if x < 0 else 'E'}"   # noqa: E731
        return (f"Rectangle {so:.2f}–{n:.2f}°N, {lng_txt(w)} to {lng_txt(e)}", "rectangle",
                lambda la, ln: (la >= so) & (la <= n) & (ln >= w) & (ln <= e),
                np.array([(so + n) / 2, (w + e) / 2]), [box], "")
    except timeseries.SelectionError as exc:
        raise SelectionError(str(exc))


def _region_mask(lat: np.ndarray, lng: np.ndarray, inside, centre, contains) -> Tuple[np.ndarray, bool]:
    """Cells whose centre lies inside the region (the time series rule) and whether it fell back to
    the one cell at the region's centre (a region smaller than one cell of the grid)."""
    keep = inside(lat, lng)
    if keep.any():
        return keep, False
    return contains(float(centre[0]), float(centre[1])), True


def _plain_ticks(lo: float, hi: float, kind: str) -> List[Tuple[float, str]]:
    """Legend ticks from the region's own minimum to maximum (no ≤ / ≥: these are the real extremes)."""
    if kind == "diverging":
        return [(0, f"−{fmt(hi)}"), (0.25, f"−{fmt(hi / 2)}"), (0.5, "0"), (0.75, f"+{fmt(hi / 2)}"), (1, f"+{fmt(hi)}")]
    out = []
    for i in range(5):
        t = i / 4
        out.append((t, fmt(10 ** (math.log10(lo) + t * (math.log10(hi) - math.log10(lo))))))
    return out


def _fit_colours(layer: Layer, label: str) -> None:
    """Recolour the region's cells: the colour range spans only their values; fewer than
    ``DISCRETE_MAX`` cells get one distinct colour per value and a discrete legend."""
    if not layer.cells or len(layer.cell_vals) != len(layer.cells) or layer.cell_kind not in ("log", "diverging"):
        return
    lg, kind = layer.legend, layer.cell_kind
    vals = [v for v, _ in layer.cell_vals]
    faded_any = any(f for _, f in layer.cell_vals)
    shade = lambda c, f: _fade(c, FADE) if f else c                          # noqa: E731
    n = len(vals)
    if n < DISCRETE_MAX:
        # One colour per distinct (displayed) value, spread evenly over the palette by rank;
        # for differences negatives stay on the negative side and positives on the positive side
        uniq = sorted({fmt(v): v for v in vals}.items(), key=lambda kv: kv[1])
        neg = [k for k, v in uniq if v < 0]
        pos = [k for k, v in uniq if v > 0]
        colours = {}
        for k, v in uniq:
            if kind == "diverging":
                if v == 0:
                    colours[k] = diverging(0.0)
                else:
                    side = neg if v < 0 else pos
                    i = side.index(k) if v > 0 else len(side) - 1 - side.index(k)   # 0 = nearest zero
                    t = 0.3 + 0.7 * (i / (len(side) - 1) if len(side) > 1 else 1.0)
                    colours[k] = diverging(t if v > 0 else -t)
            else:
                colours[k] = rainbow(uniq.index((k, v)) / (len(uniq) - 1) if len(uniq) > 1 else 0.5)
        layer.cells = [c[:4] + (shade(colours[fmt(v)], f),) for c, (v, f) in zip(layer.cells, layer.cell_vals)]
        counts = {k: sum(1 for v in vals if fmt(v) == k) for k, _ in uniq}
        sw = [(colours[k], f"{_signed(v) if kind == 'diverging' else fmt(v)}"
               + f"   ({counts[k]} cell{'s' if counts[k] > 1 else ''})") for k, v in reversed(uniq)]
        if faded_any:
            sw.append((_fade((150, 150, 150), FADE), "Faded: outside the Ireland attribution area"))
        layer.legend = Legend(
            title=lg.title, unit=lg.unit, kind="discrete", swatches=sw,
            note=f"{label}: {n} cell{'s' if n > 1 else ''}, one colour per value (fewer than {DISCRETE_MAX} cells)"
                 + _filter_note(signed=kind == "diverging"))
        return
    if kind == "diverging":
        lim = max(abs(v) for v in vals) or 1.0
        layer.cells = [c[:4] + (shade(diverging(v / lim), f),) for c, (v, f) in zip(layer.cells, layer.cell_vals)]
        layer.legend = Legend(
            title=lg.title, unit=lg.unit, kind="diverging", lo=-lim, hi=lim, ticks=_plain_ticks(-lim, lim, kind),
            swatches=[(_fade(diverging(0.5), FADE), "Outside the Ireland attribution area")] if faded_any else [],
            note=f"Linear, symmetric · range fitted to the {n} cells of the region (largest |value|)"
                 + _filter_note(signed=True))
        return
    pos = [v for v in vals if v > 0]
    if not pos:
        return
    lo, hi = min(pos), max(pos)
    if hi <= lo:
        lo, hi = lo / 1.01, hi * 1.01
    span = math.log10(hi) - math.log10(lo)
    colour = lambda v: rainbow((math.log10(v) - math.log10(lo)) / span) if v > 0 else ZERO_RGB   # noqa: E731
    layer.cells = [c[:4] + (shade(colour(v), f),) for c, (v, f) in zip(layer.cells, layer.cell_vals)]
    sw = []
    if any(v == 0 for v in vals):
        sw.append((ZERO_RGB, "0 (no emission assigned)"))
    if faded_any:
        sw.append((_fade(rainbow(0.6), FADE), "Outside the Ireland attribution area"))
    layer.legend = Legend(
        title=lg.title, unit=lg.unit, kind="log", lo=lo, hi=hi, ticks=_plain_ticks(lo, hi, kind), swatches=sw,
        note=f"Log scale · range fitted to the {n} cells of the region (min – max)" + _filter_note())


def clip_to_region(layer: Layer, q: dict) -> Layer:
    """Keep only the cells of the time series region (box, polygon or county: the cells whose centre lies
    inside, as the time series uses), fit the colours and legend to them, and outline the region.
    Cells: the drawn rectangles (JPEG) and the GeoTIFF band; overlays are masked when drawn."""
    label, part, inside, centre, rings, credit = _region(q)
    fallback = False
    if layer.cells:
        b = np.asarray([c[:4] for c in layer.cells], dtype="float64")   # west, south, east, north
        keep, fallback = _region_mask(
            (b[:, 1] + b[:, 3]) / 2, (b[:, 0] + b[:, 2]) / 2, inside, centre,
            lambda la, ln: (b[:, 0] <= ln) & (ln < b[:, 2]) & (b[:, 1] <= la) & (la < b[:, 3]))
        layer.cells = [c for c, k in zip(layer.cells, keep) if k]
        if len(layer.cell_vals) == len(keep):
            layer.cell_vals = [v for v, k in zip(layer.cell_vals, keep) if k]
    if layer.tif_values is not None and layer.tif_geo is not None:
        west, north, dx, dy = layer.tif_geo
        rows, cols = layer.tif_values.shape
        if layer.tif_centres is not None:          # projected grid (MapEIre): its cells' own WGS 84 centres
            glat, glng = (a.ravel() for a in layer.tif_centres)

            def contains(la, ln):
                hit = np.zeros(glat.size, bool)
                i = mapeire.cell_at(la, ln)
                if i is not None:
                    hit[i] = True
                return hit
        else:
            glat, glng = np.meshgrid(north - (np.arange(rows) + 0.5) * dy, west + (np.arange(cols) + 0.5) * dx,
                                     indexing="ij")
            glat, glng = glat.ravel(), glng.ravel()

            def contains(la, ln):
                return (np.abs(glat - la) <= dy / 2) & (np.abs(glng - ln) <= dx / 2)
        keep, fb = _region_mask(glat, glng, inside, centre, contains)
        fallback = fallback or fb
        vals = layer.tif_values.copy().ravel()
        vals[~keep] = NODATA
        layer.tif_values = vals.reshape(rows, cols)
        layer.tif_meta = {**layer.tif_meta, "AREA": label}
    _fit_colours(layer, label)
    layer.clip_rings = [[(float(p[1]), float(p[0])) for p in r] for r in rings]
    layer.clip_credit = credit
    layer.subtitle = f"{layer.subtitle}   ·   {label}"
    layer.stem = _slug(layer.stem, part)
    layer.facts.insert(0, ("Area shown", f"{label}: the cell at its centre (the region is smaller than one cell)"
                           if fallback else f"{label}: only cells whose centre lies inside the region, "
                                            "as used for the time series"))
    return layer


# ---------------------------------------------------------------------------
# GeoTIFF (baseline TIFF + GeoKeys, uncompressed, one strip)
# ---------------------------------------------------------------------------
def _merc(lon: float, lat: float) -> Tuple[float, float]:
    return (R_EARTH * math.radians(lon),
            R_EARTH * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def _tiff(pixels: np.ndarray, pixel_scale: Tuple[float, float], tiepoint: Tuple[float, float],
          epsg: int, metadata: dict, nodata: Optional[float]) -> bytes:
    """Write a GeoTIFF: float32 single band, or uint8 RGBA (shape rows × cols × 4)."""
    rgba = pixels.ndim == 3
    rows, cols = pixels.shape[:2]
    data = np.ascontiguousarray(pixels.astype("<f4" if not rgba else "u1")).tobytes()
    spp = 4 if rgba else 1

    if epsg == 4326:
        keys = [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102]
    else:
        keys = [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg, 3076, 0, 1, 9001]
    gdal_md = "<GDALMetadata>" + "".join(
        f'<Item name="{escape(k)}">{escape(str(v))}</Item>' for k, v in metadata.items()) + "</GDALMetadata>"

    # (tag, type, values); types: 2 ASCII, 3 SHORT, 4 LONG, 12 DOUBLE
    entries = [
        (256, 4, [cols]), (257, 4, [rows]),
        (258, 3, [8] * 4 if rgba else [32]), (259, 3, [1]), (262, 3, [2 if rgba else 1]),
        (273, 4, [0]),                     # StripOffsets, patched below
        (277, 3, [spp]), (278, 4, [rows]), (279, 4, [len(data)]), (284, 3, [1]),
    ]
    if rgba:
        entries.append((338, 3, [2]))      # ExtraSamples: unassociated alpha
    entries += [
        (339, 3, [1] * 4 if rgba else [3]),
        (33550, 12, [pixel_scale[0], pixel_scale[1], 0.0]),
        (33922, 12, [0.0, 0.0, 0.0, tiepoint[0], tiepoint[1], 0.0]),
        (34735, 3, keys),
        (42112, 2, gdal_md),
    ]
    if nodata is not None:
        entries.append((42113, 2, f"{nodata:g}"))
    entries.sort(key=lambda e: e[0])

    size = {2: 1, 3: 2, 4: 4, 12: 8}
    fmt_char = {3: "H", 4: "I", 12: "d"}
    ifd_offset = 8
    ifd_len = 2 + 12 * len(entries) + 4
    extra = bytearray()
    extra_base = ifd_offset + ifd_len
    packed = []
    for tag, typ, vals in entries:
        if typ == 2:
            raw = vals.encode("utf-8") + b"\0"
            count = len(raw)
        else:
            raw = struct.pack("<" + fmt_char[typ] * len(vals), *vals)
            count = len(vals)
        if len(raw) <= 4:
            packed.append([tag, typ, count, raw.ljust(4, b"\0"), None])
        else:
            if len(extra) % 2:
                extra += b"\0"
            packed.append([tag, typ, count, None, extra_base + len(extra)])
            extra += raw
    data_offset = extra_base + len(extra)
    if data_offset % 2:
        extra += b"\0"
        data_offset += 1

    out = bytearray(b"II*\0" + struct.pack("<I", ifd_offset))
    out += struct.pack("<H", len(packed))
    for tag, typ, count, inline, offset in packed:
        if tag == 273:
            inline = struct.pack("<I", data_offset)
        out += struct.pack("<HHI", tag, typ, count) + (inline if inline is not None else struct.pack("<I", offset))
    out += struct.pack("<I", 0)
    out += extra
    out += data
    return bytes(out)


def geotiff(layer: Layer) -> Tuple[bytes, str]:
    """GeoTIFF bytes and file name for ``layer``."""
    if layer.tif_bytes is not None:
        return layer.tif_bytes, f"{layer.stem}.tif"
    if layer.tif_values is not None:
        west, north, dx, dy = layer.tif_geo  # type: ignore[misc]
        return (_tiff(layer.tif_values, (dx, dy), (west, north), layer.tif_epsg, layer.tif_meta, NODATA),
                f"{layer.stem}.tif")
    # MapEIre fallback: the overlay's RGBA pixels, already in Web Mercator
    w, s, e, n = layer.overlay_bounds  # type: ignore[misc]
    (x0, y0), (x1, y1) = _merc(w, s), _merc(e, n)
    img = layer.overlay
    px = np.asarray(img, dtype=np.uint8)
    scale = ((x1 - x0) / img.width, (y1 - y0) / img.height)
    return _tiff(px, scale, (x0, y1), 3857, layer.tif_meta, None), f"{layer.stem}_rendered-colours.tif"


# ---------------------------------------------------------------------------
# JPEG map
# ---------------------------------------------------------------------------
SS = 2                    # supersampling factor (drawn at 2x, then reduced)
W, H = 2000, 1500
NAVY, TEXT, MUTED, GRID = (22, 50, 79), (28, 43, 58), (92, 107, 122), (214, 221, 228)


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    return ImageFont.truetype(str(FONT_DIR / name), size * SS)


def _outline() -> List[List[Tuple[float, float]]]:
    try:
        data = json.loads(OUTLINE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [[tuple(p) for p in r["ring"]] for r in data.get("rings", [])]


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, width: int) -> List[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def jpeg(layer: Layer) -> Tuple[bytes, str]:
    """A print-ready JPEG of ``layer``: map, coastline, axes, legend, figures and source."""
    s = SS
    img = Image.new("RGB", (W * s, H * s), "white")
    d = ImageDraw.Draw(img)

    # Title and subtitle
    for text, size, bold, colour, y in ((layer.title, 46, True, NAVY, 52), (layer.subtitle, 30, True, (44, 62, 80), 122)):
        f = _font(size, bold)
        while d.textlength(text, font=f) > (W - 120) * s and size > 18:
            size -= 2
            f = _font(size, bold)
        d.text((W * s / 2, y * s), text, font=f, fill=colour, anchor="mt")

    # Map frame in Web Mercator, fitted into the left box
    west, south, east, north = VIEW
    (mx0, my0), (mx1, my1) = _merc(west, south), _merc(east, north)
    box_l, box_t, box_w, box_h = 250, 200, 1000, 1150
    k = min(box_w / (mx1 - mx0), box_h / (my1 - my0))
    fw, fh = (mx1 - mx0) * k, (my1 - my0) * k
    fl, ft = box_l + (box_w - fw) / 2, box_t + (box_h - fh) / 2

    def xy(lon: float, lat: float) -> Tuple[float, float]:
        x, y = _merc(lon, lat)
        return (fl + (x - mx0) * k) * s, (ft + (my1 - y) * k) * s

    frame = [fl * s, ft * s, (fl + fw) * s, (ft + fh) * s]
    layer_img = Image.new("RGBA", img.size, (255, 255, 255, 0))
    ld = ImageDraw.Draw(layer_img)
    if layer.overlay is not None:
        w, so, e, n = layer.overlay_bounds  # type: ignore[misc]
        (x0, y0), (x1, y1) = xy(w, n), xy(e, so)
        ov = layer.overlay.resize((max(1, round(x1 - x0)), max(1, round(y1 - y0))), Image.NEAREST)
        layer_img.alpha_composite(ov, (round(x0), round(y0)))
    for w, so, e, n, colour in layer.cells:
        (x0, y0), (x1, y1) = xy(w, n), xy(e, so)
        ld.rectangle([x0, y0, x1, y1], fill=colour + (255,))
    # Keep the layer inside the frame (and, for a pre-rendered overlay clipped to a county, inside it;
    # cells were already reduced to the region's own in clip_to_region)
    clip = Image.new("L", img.size, 0)
    ImageDraw.Draw(clip).rectangle(frame, fill=255)
    if layer.clip_rings and layer.overlay is not None:
        area = Image.new("L", img.size, 0)
        for ring in layer.clip_rings:              # even-odd: islands add, holes take out
            one = Image.new("L", img.size, 0)
            ImageDraw.Draw(one).polygon([xy(lon, lat) for lon, lat in ring], fill=255)
            area = ImageChops.difference(area, one)
        clip = ImageChops.multiply(clip, area)
    layer_img.putalpha(Image.composite(layer_img.getchannel("A"), clip, clip))
    img.paste(layer_img, (0, 0), layer_img)

    # Graticule, coastline, frame and ticks
    tick_f = _font(26, True)
    for lon in range(math.ceil(west), math.floor(east) + 1):
        x, _ = xy(lon, south)
        for yy in range(int(frame[1]), int(frame[3]), 18 * s):
            d.line([x, yy, x, min(yy + 8 * s, frame[3])], fill=GRID, width=s)
        d.line([x, frame[3], x, frame[3] + 10 * s], fill=TEXT, width=2 * s)
        d.text((x, frame[3] + 18 * s), f"{abs(lon)}°W", font=tick_f, fill=TEXT, anchor="mt")
    for lat in range(math.ceil(south), math.floor(north) + 1):
        _, y = xy(west, lat)
        for xx in range(int(frame[0]), int(frame[2]), 18 * s):
            d.line([xx, y, min(xx + 8 * s, frame[2]), y], fill=GRID, width=s)
        d.line([frame[0] - 10 * s, y, frame[0], y], fill=TEXT, width=2 * s)
        d.text((frame[0] - 18 * s, y), f"{lat}°N", font=tick_f, fill=TEXT, anchor="rm")
    for ring in _outline():
        pts = [xy(lon, lat) for lon, lat in ring]
        d.line(pts + [pts[0]], fill=(128, 136, 146) if layer.clip_rings else (34, 40, 49), width=2 * s, joint="curve")
    # The time series region: a bold black line on a white casing, clearly apart from the grey coastline
    for width, colour in ((10, (255, 255, 255)), (5, (0, 0, 0))):
        for ring in layer.clip_rings:
            pts = [xy(lon, lat) for lon, lat in ring]
            d.line(pts + [pts[0]], fill=colour, width=width * s, joint="curve")
    d.rectangle(frame, outline=TEXT, width=2 * s)

    # Legend panel
    lg = layer.legend
    px0, py0, pw = 1330, 300, 600
    pad = 30
    title_f, unit_f, tick_f2, small_f = _font(30, True), _font(24), _font(22), _font(19)
    lines = _wrap(d, lg.title, title_f, (pw - 2 * pad) * s)
    unit_lines = _wrap(d, lg.unit, unit_f, (pw - 2 * pad) * s)
    discrete = lg.kind == "discrete"
    bar_h, bar_w = (0 if discrete else 360), 46
    y = py0 + pad
    title_h = len(lines) * 40 + len(unit_lines) * 32 + 18
    note_lines = _wrap(d, lg.note, small_f, (pw - 2 * pad) * s) if lg.note else []
    sw_step = 48 if discrete else 40
    panel_h = pad + title_h + bar_h + (0 if discrete else 20) + len(lg.swatches) * sw_step + len(note_lines) * 26 + pad + (0 if discrete else 10)
    d.rounded_rectangle([px0 * s, py0 * s, (px0 + pw) * s, (py0 + panel_h) * s], radius=10 * s,
                        fill=(248, 250, 252), outline=(85, 95, 108), width=2 * s)
    for ln in lines:
        d.text(((px0 + pad) * s, y * s), ln, font=title_f, fill=TEXT)
        y += 40
    for ln in unit_lines:
        d.text(((px0 + pad) * s, y * s), ln, font=unit_f, fill=MUTED)
        y += 32
    y += 18
    bx0, by0 = px0 + pad, y
    for i in range(bar_h * s if not discrete else 0):
        t = 1 - i / (bar_h * s - 1)                 # top = high
        if lg.kind == "diverging":
            c = diverging(2 * t - 1)
        elif lg.kind == "stops":
            pos = t * (len(lg.stops) - 1)
            a = int(min(pos, len(lg.stops) - 2))
            f_ = pos - a
            c = tuple(round(lg.stops[a][j] + (lg.stops[a + 1][j] - lg.stops[a][j]) * f_) for j in range(3))
        else:
            c = rainbow(t)
        d.line([bx0 * s, by0 * s + i, (bx0 + bar_w) * s, by0 * s + i], fill=c)
    if not discrete:
        d.rectangle([bx0 * s, by0 * s, (bx0 + bar_w) * s, (by0 + bar_h) * s], outline=(120, 128, 138), width=s)
    for t, label in ([] if discrete else lg.ticks):
        ty = by0 + (1 - t) * bar_h
        d.line([(bx0 + bar_w) * s, ty * s, (bx0 + bar_w + 10) * s, ty * s], fill=TEXT, width=s)
        d.text(((bx0 + bar_w + 18) * s, ty * s), label, font=tick_f2, fill=TEXT, anchor="lm")
    y = by0 + bar_h + (0 if discrete else 20)
    sw_h, sw_f = (32, tick_f2) if discrete else (24, small_f)
    for colour, label in lg.swatches:
        d.rectangle([bx0 * s, y * s, (bx0 + bar_w) * s, (y + sw_h) * s], fill=colour, outline=(120, 128, 138), width=s)
        d.text(((bx0 + bar_w + 18) * s, (y + sw_h / 2) * s), label, font=sw_f, fill=TEXT, anchor="lm")
        y += sw_step
    for ln in note_lines:
        d.text(((px0 + pad) * s, y * s), ln, font=small_f, fill=MUTED)
        y += 26

    # Key figures under the legend
    y = py0 + panel_h + 30
    key_f, val_f = _font(20, True), _font(20)
    key_w = max((d.textlength(k, font=key_f) / s for k, _ in layer.facts), default=0) + 22
    for key, val in layer.facts:
        if y > 1330:
            break
        d.text((px0 * s, y * s), key, font=key_f, fill=MUTED)
        for ln in _wrap(d, val, val_f, (pw - key_w) * s):
            d.text(((px0 + key_w) * s, y * s), ln, font=val_f, fill=TEXT)
            y += 28
        y += 6

    # Footer: source and provenance
    foot_f = _font(18)
    foot = [f"Source: {layer.source}",
            "Coastline: Natural Earth"
            + (f" · {layer.clip_credit}" if layer.clip_credit else "")
            + (" · Black line: the time series region" if layer.clip_rings else "")
            + f" · INPACT Ireland Greenhouse Gas Policy Impact Explorer · generated {date.today():%d %b %Y}"]
    yy = H - 92
    for text in foot:
        for ln in _wrap(d, text, foot_f, (W - 160) * s):
            d.text((80 * s, yy * s), ln, font=foot_f, fill=MUTED)
            yy += 25

    out = io.BytesIO()
    img.resize((W, H), Image.LANCZOS).save(out, format="JPEG", quality=92, dpi=(200, 200), optimize=True)
    return out.getvalue(), f"{layer.stem}.jpg"


# ---------------------------------------------------------------------------
# Time series grid: one map per time step of the map layer, one shared colour scale
# ---------------------------------------------------------------------------
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
GRID_W, GRID_H = 3000, 2250        # output pixels (4:3, like the single map JPEG)
_GU = 2.5                          # drawing pixels per design unit (design canvas 2000 x 1500)


def grid_steps(q: dict) -> Tuple[List[Tuple[dict, str]], dict]:
    """The map layer's time steps: (layer query, label) each, plus a description of the series.
    EDGAR annual: every year; EDGAR monthly: the 12 months of the map's year; inverse model: the run's years."""
    if q.get("compare") == "1":
        raise SelectionError("A difference (B − A) map has no time series grid; use Current Map.")
    ds = q.get("dataset", "")
    if ds == "edgar":
        meta = edgar.load_metadata()
        gas = meta.get("gases", {}).get(q.get("gas", ""))
        if gas is None or q.get("sector", "") not in meta.get("sectors", {}):
            raise SelectionError("Unknown EDGAR selection.")
        if q.get("month", "annual") in ("", "annual"):
            steps = [({**q, "year": str(y), "month": "annual"}, str(y)) for y in meta["years"]]
            return steps, {"what": "annual maps", "legend": f"{gas['formula']} · annual totals"}
        year = q.get("year", "")
        steps = [({**q, "month": str(m)}, f"{_MONTHS[m - 1]} {year}") for m in range(1, 13)]
        return steps, {"what": f"monthly maps of {year}", "legend": f"{gas['formula']} · monthly totals {year}"}
    if ds == "inverse":
        meta = inverse.load_metadata()
        run = meta.get("runs", {}).get(f"{q.get('model', '')}|{q.get('transport', '')}|{q.get('gas', '')}")
        gas = meta.get("gases", {}).get(q.get("gas", ""))
        if not run or gas is None or q.get("estimate") not in _ESTIMATES:
            raise SelectionError("Unknown inverse model selection.")
        steps = [({**q, "year": str(y)}, str(y)) for y in run["years"]]
        return steps, {"what": "annual maps", "legend": f"{gas['formula']} · {_ESTIMATES[q['estimate']]}"}
    if ds == "mapeire":
        meta = mapeire.load_metadata()
        code, sector = q.get("parameter", ""), q.get("sector", "")
        p = meta.get("pollutants", {}).get(code)
        if p is None or sector not in meta.get("sectors", {}):
            raise SelectionError("Unknown MapEIre selection.")
        steps = [({**q, "year": str(y)}, str(y)) for y in meta["years"]
                 if mapeire.band_info(str(y), sector, code) is not None]
        return steps, {"what": "maps of the MapEIre years",
                       "legend": f"{p['formula']} · {meta['sectors'][sector]['name']}"}
    raise SelectionError("Unknown dataset.")


def grid_layout_ok(rows: int, cols: int, n: int) -> bool:
    """Enough cells for every step, no single row or column (except for 2 steps), no empty row or column."""
    if n < 2 or rows < 1 or cols < 1:
        return False
    if n == 2:
        return sorted((rows, cols)) == [1, 2]
    return rows >= 2 and cols >= 2 and rows * cols >= n and (rows - 1) * cols < n and rows * (cols - 1) < n


def _shared_scale(layers: List[Layer]) -> Optional[Legend]:
    """One colour scale for every panel of a region grid: the region's minimum to maximum over all steps."""
    kind = layers[0].cell_kind
    pairs = [vf for L in layers for vf in L.cell_vals]
    if kind not in ("log", "diverging") or not pairs:
        return None
    vals = [v for v, _ in pairs]
    faded_any = any(f for _, f in pairs)
    shade = lambda c, f: _fade(c, FADE) if f else c          # noqa: E731
    n_cells = max(len(L.cells) for L in layers)
    if kind == "diverging":
        lim = max(abs(v) for v in vals) or 1.0
        for L in layers:
            L.cells = [c[:4] + (shade(diverging(v / lim), f),) for c, (v, f) in zip(L.cells, L.cell_vals)]
        return Legend(title="", unit="", kind="diverging", lo=-lim, hi=lim, ticks=_plain_ticks(-lim, lim, kind),
                      swatches=[(_fade(diverging(0.5), FADE), "Outside the Ireland attribution area")] if faded_any else [],
                      note=f"Linear, symmetric · one scale for all {len(layers)} maps, fitted to the region's "
                           f"{n_cells} cells over every step" + _filter_note(signed=True))
    pos = [v for v in vals if v > 0]
    if not pos:
        return None
    lo, hi = min(pos), max(pos)
    if hi <= lo:
        lo, hi = lo / 1.01, hi * 1.01
    span = math.log10(hi) - math.log10(lo)
    colour = lambda v: rainbow((math.log10(v) - math.log10(lo)) / span) if v > 0 else ZERO_RGB   # noqa: E731
    for L in layers:
        L.cells = [c[:4] + (shade(colour(v), f),) for c, (v, f) in zip(L.cells, L.cell_vals)]
    sw = []
    if any(v == 0 for v in vals):
        sw.append((ZERO_RGB, "0 (no emission assigned)"))
    if faded_any:
        sw.append((_fade(rainbow(0.6), FADE), "Outside the Ireland attribution area"))
    return Legend(title="", unit="", kind="log", lo=lo, hi=hi, ticks=_plain_ticks(lo, hi, kind), swatches=sw,
                  note=f"Log scale · one scale for all {len(layers)} maps, fitted to the region's "
                       f"{n_cells} cells over every step (min – max)" + _filter_note())


def _grid_view(layers: List[Layer]) -> Tuple[float, float, float, float]:
    """Panel extent: Ireland, or the region (and its cells) with a margin when one is set."""
    if not layers[0].clip_rings:
        return VIEW
    xs = [p[0] for r in layers[0].clip_rings for p in r]
    ys = [p[1] for r in layers[0].clip_rings for p in r]
    for L in layers:
        for w, so, e, n, _ in L.cells:
            xs += [w, e]
            ys += [so, n]
    w, e, so, n = min(xs), max(xs), min(ys), max(ys)
    cx, cy = (w + e) / 2, (so + n) / 2
    hw, hh = max((e - w) * 0.62, 0.3), max((n - so) * 0.62, 0.18)
    return cx - hw, cy - hh, cx + hw, cy + hh


# ---------------------------------------------------------------------------
# Statistics panel of the time series grid: one row per map (year, max, mean, min, median, std)
# ---------------------------------------------------------------------------
_SUP = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


def map_stats(layer: Layer) -> Optional[dict]:
    """Statistics of every cell with a value in the map (zero cells included); the region's cells
    only when the layer was clipped to a region. None when the map has no values."""
    if layer.tif_values is None:
        return None
    v = np.asarray(layer.tif_values, dtype=np.float64).ravel()
    v = v[np.isfinite(v) & (v != NODATA)]
    if not v.size:
        return None
    return {"n": int(v.size), "max": float(v.max()), "mean": float(v.mean()), "min": float(v.min()),
            "median": float(np.median(v)), "std": float(v.std())}


def stats_exponent(rows: List[Optional[dict]]) -> int:
    """A common power of ten, a multiple of 3, that brings the largest value into 1 – 999."""
    big = max((abs(r[k]) for r in rows if r for k in ("max", "mean", "min", "median", "std")), default=0.0)
    if not big or not math.isfinite(big):
        return 0
    return 3 * math.floor(math.log10(big) / 3)


def stats_cell(v: float) -> str:
    """A scaled value with about three significant digits, never in E notation above 1e-6."""
    a = abs(v)
    if a == 0:
        return "0"
    if a >= 100:
        return f"{v:,.0f}"
    if a >= 10:
        return f"{v:.1f}"
    if a >= 1:
        return f"{v:.2f}"
    if a < 1e-6:
        return f"{v:.1e}"
    return f"{v:.{min(6, 2 - math.floor(math.log10(a)))}f}"


def _draw_stats_panel(d: ImageDraw.ImageDraw, font, P, box: Tuple[float, float, float, float],
                      labels: List[str], stats: List[Optional[dict]], unit: str, monthly: bool,
                      region: bool) -> None:
    """The statistics table in ``box`` (design units: x0, y0, x1, y1), split into side-by-side parts
    when the rows do not fit one column at a readable size. The power of ten and the unit are written
    under the table, so the cells stay short."""
    x0, y0, x1, y1 = box
    e = stats_exponent(stats)
    cols = ("max", "mean", "min", "median", "std")
    head = ("Month" if monthly else "Year", "Max", "Mean", "Min", "Median", "Std")
    body = [(lab, *(stats_cell(s[k] / 10 ** e) if s else "–" for k in cols)) for lab, s in zip(labels, stats)]
    scale = f"×10{str(e).translate(_SUP)} " if e else ""
    ns = {s["n"] for s in stats if s}
    cells_txt = (f"the {next(iter(ns)):,} cells" if len(ns) == 1 else "the cells") + (" of the region" if region else " of each map")
    caption = [f"Values {scale}{unit}".replace("  ", " "),
               f"Over {cells_txt} with a value (zero cells included). Std: standard deviation."]
    pad = 12
    bw, bh = x1 - x0 - 2 * pad, y1 - y0 - 2 * pad
    cap_size = lambda fs: max(8.0, fs * 0.95)                       # noqa: E731
    gap_of = lambda fs: fs * 0.7                                    # noqa: E731

    def caption_h(fs: float) -> float:
        cf = font(cap_size(fs))
        return sum(len(_wrap(d, c, cf, P(bw))) for c in caption) * cap_size(fs) * 1.3

    best = None
    for parts in range(1, 5):
        per = math.ceil(len(body) / parts)
        sub_w = (bw - (parts - 1) * 18) / parts
        for fs in [x / 2 for x in range(48, 13, -1)]:            # 24 … 7 design units
            f, fb = font(fs), font(fs, True)
            widths = [max(d.textlength(r[j], font=fb if j == 0 else f) for r in body + [head]) / _GU
                      for j in range(len(head))]
            need_w = sum(widths) + gap_of(fs) * (len(head) - 1)
            need_h = fs * 1.6 + (per + 1) * fs * 1.45 + 8 + caption_h(fs)
            if need_w <= sub_w and need_h <= bh:
                if not best or fs > best[1]:
                    best = (parts, fs, per, sub_w, widths)
                break
    if not best:                                                   # tiny panel: smallest size, one part
        best = (1, 7.0, len(body), bw, [bw / len(head)] * len(head))
    parts, fs, per, sub_w, widths = best
    gap_col = gap_of(fs)
    f, fb, cap_f = font(fs), font(fs, True), font(cap_size(fs))
    # rows spread over the panel's height (up to twice the text size) when there is room
    lh = max(fs * 1.45, min(fs * 2.1, (bh - fs * 1.6 - 8 - caption_h(fs)) / (per + 1)))

    d.rounded_rectangle([P(x0), P(y0), P(x1), P(y1)], radius=P(8), fill=(250, 252, 253),
                        outline=(120, 128, 138), width=max(1, round(_GU)))
    ty = y0 + pad
    d.text((P(x0 + pad), P(ty)), "Statistics of each map", font=font(fs * 1.1, True), fill=NAVY)
    ty += fs * 1.6
    # columns: the time label left-aligned, the numbers right-aligned; spare width spread between columns
    for p in range(parts):
        rows = body[p * per:(p + 1) * per]
        if not rows:
            continue
        px = x0 + pad + p * (sub_w + 18)
        spare = (sub_w - sum(widths) - gap_col * (len(head) - 1)) / max(1, len(head) - 1)
        xs, cx = [], px
        for w in widths:
            xs.append((cx, cx + w))
            cx += w + gap_col + min(spare, fs * 2)
        right = xs[-1][1]
        y = ty
        d.rectangle([P(px - 4), P(y - 2), P(right + 4), P(y + lh - 3)], fill=(232, 238, 244))
        for j, h in enumerate(head):
            a, b = xs[j]
            d.text((P(a) if j == 0 else P(b), P(y + lh / 2 - 2)), h, font=fb, fill=NAVY, anchor="lm" if j == 0 else "rm")
        y += lh
        for i, r in enumerate(rows):
            if i % 2:
                d.rectangle([P(px - 4), P(y - 2), P(right + 4), P(y + lh - 3)], fill=(242, 245, 248))
            for j, txt in enumerate(r):
                a, b = xs[j]
                d.text((P(a) if j == 0 else P(b), P(y + lh / 2 - 2)), txt, font=fb if j == 0 else f, fill=TEXT,
                       anchor="lm" if j == 0 else "rm")
            y += lh
        d.line([P(px - 4), P(ty + lh - 2), P(right + 4), P(ty + lh - 2)], fill=(150, 160, 172), width=max(1, round(_GU / 2)))
    # caption: the power of ten and the unit, then what the statistics cover
    cy = ty + (per + 1) * lh + 8
    for k, c in enumerate(caption):
        for ln in _wrap(d, c, cap_f, P(bw)):
            d.text((P(x0 + pad), P(cy)), ln, font=font(cap_size(fs), k == 0), fill=NAVY if k == 0 else MUTED)
            cy += cap_size(fs) * 1.3


def grid_jpeg(q: dict, rows: int, cols: int, region: bool, stats: bool = False) -> Tuple[bytes, str]:
    """A JPEG of one map per time step in a rows × cols grid, with one shared legend.
    No coordinate labels on the panels; each panel is titled with its time step.
    ``stats``: one more panel, after the last map, with a table of each map's statistics."""
    steps, info = grid_steps(q)
    n = len(steps)
    need = n + (1 if stats else 0)
    if not grid_layout_ok(rows, cols, need):
        raise SelectionError(f"{n} maps{' and the statistics table' if stats else ''}: choose rows × columns "
                             f"with at least {need} cells, at least 2 rows and 2 columns, and no empty row or column.")
    layers, labels = [], []
    for sq, label in steps:
        L = build_layer(sq)
        if region:
            L = clip_to_region(L, q)
        layers.append(L)
        labels.append(label)
    first = layers[0]
    table = [map_stats(L) for L in layers] if stats else None
    legend = _shared_scale(layers) if region else None
    if legend is None:                     # Ireland: the dataset's fixed scale, already the same for every step
        legend = first.legend
        legend = Legend(title="", unit="", kind=legend.kind, lo=legend.lo, hi=legend.hi, stops=legend.stops,
                        ticks=legend.ticks, swatches=legend.swatches,
                        note=(legend.note + f" · one scale for all {n} maps").lstrip(" ·"))
    legend.title, legend.unit = info["legend"], first.legend.unit
    region_label = _region(q)[0] if region else ""

    u = _GU
    img = Image.new("RGB", (round(2000 * u), round(1500 * u)), "white")
    d = ImageDraw.Draw(img)
    font = lambda size, bold=False: _font(max(1, round(size * u / SS)), bold)   # noqa: E731
    P = lambda v: round(v * u)                                                 # noqa: E731

    # Title and subtitle
    sub = f"{n} {info['what']}, {labels[0]} – {labels[-1]}   [{legend.unit}]" + (f"   ·   {region_label}" if region_label else "")
    for text, size, bold, colour, y in ((first.title, 44, True, NAVY, 46), (sub, 27, True, (44, 62, 80), 108)):
        f, sz = font(size, bold), size
        while d.textlength(text, font=f) > P(1880) and sz > 16:
            sz -= 2
            f = font(sz, bold)
        d.text((P(1000), P(y)), text, font=f, fill=colour, anchor="mt")

    # Panels
    view = _grid_view(layers)
    west, south, east, north = view
    (mx0, my0), (mx1, my1) = _merc(west, south), _merc(east, north)
    # Panels keep the map's own shape: as large as the area allows, the block centred in it
    gx0, gy0, gw, gh, gap = 40, 160, 1530, 1215, 18
    label_h = min(38, max(22, gh / rows * 0.1))
    # Widen the extent towards the shape of a grid cell (more surroundings, never less), by at most 30%
    # so the map stays the focus; any remaining difference becomes margin around the centred grid
    cell_aspect = ((gw - (cols - 1) * gap) / cols) / ((gh - (rows - 1) * gap) / rows - label_h)
    aspect = (mx1 - mx0) / (my1 - my0)
    if aspect < cell_aspect:
        grow = min((my1 - my0) * cell_aspect - (mx1 - mx0), 0.3 * (mx1 - mx0)) / 2
        mx0, mx1 = mx0 - grow, mx1 + grow
    else:
        grow = min((mx1 - mx0) / cell_aspect - (my1 - my0), 0.3 * (my1 - my0)) / 2
        my0, my1 = my0 - grow, my1 + grow
    aspect = (mx1 - mx0) / (my1 - my0)
    cell_w = min((gw - (cols - 1) * gap) / cols, ((gh - (rows - 1) * gap) / rows - label_h) * aspect)
    cell_h = cell_w / aspect
    ox = gx0 + (gw - (cols * cell_w + (cols - 1) * gap)) / 2
    oy = gy0 + (gh - (rows * (label_h + cell_h) + (rows - 1) * gap)) / 2
    lab_f = font(min(26, max(15, label_h * 0.62)), True)
    coast = _outline()
    coast_col = (128, 136, 146) if region else (34, 40, 49)
    for i, (L, label) in enumerate(zip(layers, labels)):
        r, c = divmod(i, cols)
        bx, by = ox + c * (cell_w + gap), oy + r * (label_h + cell_h + gap) + label_h
        bw, bh = cell_w, cell_h
        k = min(bw / (mx1 - mx0), bh / (my1 - my0))
        fw, fh = (mx1 - mx0) * k, (my1 - my0) * k
        fl, ft = bx + (bw - fw) / 2, by + (bh - fh) / 2
        pw, ph = max(1, P(fw)), max(1, P(fh))
        panel = Image.new("RGB", (pw, ph), "white")
        pd = ImageDraw.Draw(panel)

        def pxy(lon: float, lat: float) -> Tuple[float, float]:
            x, y = _merc(lon, lat)
            return (x - mx0) * k * u, (my1 - y) * k * u

        for w, so, e, nn, colour in L.cells:
            (x0, y0), (x1, y1) = pxy(w, nn), pxy(e, so)
            pd.rectangle([x0, y0, x1, y1], fill=colour)
        lw = max(1, round(u * (1.3 if region else 1.1)))
        for ring in coast:
            pts = [pxy(lon, lat) for lon, lat in ring]
            pd.line(pts + [pts[0]], fill=coast_col, width=lw, joint="curve")
        for width, colour in ((max(3, round(u * 4.2)), (255, 255, 255)), (max(2, round(u * 2.2)), (0, 0, 0))):
            for ring in L.clip_rings:
                pts = [pxy(lon, lat) for lon, lat in ring]
                pd.line(pts + [pts[0]], fill=colour, width=width, joint="curve")
        img.paste(panel, (P(fl), P(ft)))
        d.rectangle([P(fl), P(ft), P(fl) + pw, P(ft) + ph], outline=(120, 128, 138), width=max(1, round(u)))
        d.text((P(fl), P(ft - 6)), label, font=lab_f, fill=TEXT, anchor="ls")

    if table is not None:
        r_last, c0 = rows - 1, n % cols
        tx0 = ox + c0 * (cell_w + gap)
        ty0 = oy + r_last * (label_h + cell_h + gap)
        _draw_stats_panel(d, font, P, (tx0, ty0, ox + cols * (cell_w + gap) - gap, ty0 + label_h + cell_h),
                          labels, table, first.legend.unit, info["what"].startswith("monthly"), region)

    # Shared legend (right)
    lg = legend
    px0, py0, pwid, pad = 1600, 200, 360, 22
    title_f, unit_f, tick_f, small_f = font(26, True), font(21), font(20), font(17)
    t_lines = _wrap(d, lg.title, title_f, P(pwid - 2 * pad))
    u_lines = _wrap(d, lg.unit, unit_f, P(pwid - 2 * pad))
    n_lines = _wrap(d, lg.note, small_f, P(pwid - 2 * pad)) if lg.note else []
    bar_h, bar_w = 560, 40
    panel_h = pad + len(t_lines) * 34 + len(u_lines) * 28 + 16 + bar_h + 20 + len(lg.swatches) * 36 + len(n_lines) * 23 + pad
    d.rounded_rectangle([P(px0), P(py0), P(px0 + pwid), P(py0 + panel_h)], radius=P(10),
                        fill=(248, 250, 252), outline=(85, 95, 108), width=max(1, round(u)))
    y = py0 + pad
    for ln in t_lines:
        d.text((P(px0 + pad), P(y)), ln, font=title_f, fill=TEXT)
        y += 34
    for ln in u_lines:
        d.text((P(px0 + pad), P(y)), ln, font=unit_f, fill=MUTED)
        y += 28
    y += 16
    bx0, by0 = px0 + pad, y
    for j in range(P(bar_h)):
        t = 1 - j / (P(bar_h) - 1)
        if lg.kind == "diverging":
            col = diverging(2 * t - 1)
        elif lg.kind == "stops":
            pos = t * (len(lg.stops) - 1)
            a = int(min(pos, len(lg.stops) - 2))
            f_ = pos - a
            col = tuple(round(lg.stops[a][m] + (lg.stops[a + 1][m] - lg.stops[a][m]) * f_) for m in range(3))
        else:
            col = rainbow(t)
        d.line([P(bx0), P(by0) + j, P(bx0 + bar_w), P(by0) + j], fill=col)
    d.rectangle([P(bx0), P(by0), P(bx0 + bar_w), P(by0 + bar_h)], outline=(120, 128, 138), width=max(1, round(u / 2)))
    for t, label in lg.ticks:
        ty = by0 + (1 - t) * bar_h
        d.line([P(bx0 + bar_w), P(ty), P(bx0 + bar_w + 9), P(ty)], fill=TEXT, width=max(1, round(u / 2)))
        d.text((P(bx0 + bar_w + 15), P(ty)), label, font=tick_f, fill=TEXT, anchor="lm")
    y = by0 + bar_h + 20
    for colour, label in lg.swatches:
        d.rectangle([P(bx0), P(y), P(bx0 + bar_w), P(y + 22)], fill=colour, outline=(120, 128, 138), width=max(1, round(u / 2)))
        for k_, ln in enumerate(_wrap(d, label, small_f, P(pwid - 2 * pad - bar_w - 15))[:2]):
            d.text((P(bx0 + bar_w + 15), P(y + 11 + k_ * 20)), ln, font=small_f, fill=TEXT, anchor="lm")
        y += 36
    for ln in n_lines:
        d.text((P(px0 + pad), P(y)), ln, font=small_f, fill=MUTED)
        y += 23

    # Footer
    foot_f = font(17)
    foot = [f"Source: {first.source}",
            "Coastline: Natural Earth" + (f" · {first.clip_credit}" if first.clip_credit else "")
            + (" · Black line: the time series region" if region else "")
            + f" · {rows} × {cols} grid, one colour scale for all maps"
            + (" · last panel: statistics of each map" if table is not None else "")
            + f" · INPACT Ireland Greenhouse Gas Policy Impact Explorer · generated {date.today():%d %b %Y}"]
    yy = 1408
    for text in foot:
        for ln in _wrap(d, text, foot_f, P(1880)):
            d.text((P(60), P(yy)), ln, font=foot_f, fill=MUTED)
            yy += 23

    out = io.BytesIO()
    img.resize((GRID_W, GRID_H), Image.LANCZOS).save(out, format="JPEG", quality=92, dpi=(300, 300), optimize=True)
    part = _region(q)[1] if region else ""
    stem = _slug(first.stem.split("_")[0], q.get("gas", ""), q.get("sector", "") or f"{q.get('model', '')}-{q.get('transport', '')}",
                 q.get("estimate", ""), f"{labels[0]}-{labels[-1]}".replace(" ", ""), part, f"grid{rows}x{cols}")
    return out.getvalue(), f"{stem}.jpg"
